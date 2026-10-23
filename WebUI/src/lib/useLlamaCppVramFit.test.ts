import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, reactive } from 'vue'
import type { LlamaCppVramInputs } from '@/lib/vram/types'
import type { LlmModel } from '@/assets/js/store/textInference'
import type { GpuSample } from '@/types/computeMetrics'
import { pickPrimaryGpu } from '@/lib/computeMetricsWindow'
import { GIB, MIB } from '@/lib/vram'

const textInference = reactive({
  backend: 'llamaCPP' as string,
  contextSize: 8192,
  llmModels: [] as Record<string, unknown>[],
  selectedDeviceName: null as string | null,
  getDeviceNameForBackend: (_backend: string) => textInference.selectedDeviceName,
})

type TestGpu = { memTotalMiB?: number; memUsedMiB?: number }

const computeMetrics = reactive({
  primaryGpu: undefined as TestGpu | undefined,
  /** Set to exercise the device-aware lookup; otherwise `gpuFor` is `primaryGpu`. */
  gpus: undefined as GpuSample[] | undefined,
  gpuFor(hint?: string | null): TestGpu | undefined {
    if (!computeMetrics.gpus) return computeMetrics.primaryGpu
    return pickPrimaryGpu(computeMetrics.gpus as GpuSample[], hint ?? undefined)
  },
})

vi.mock('@/assets/js/store/textInference', () => ({ useTextInference: () => textInference }))
vi.mock('@/assets/js/store/computeMetrics', () => ({ useComputeMetrics: () => computeMetrics }))

const { useLlamaCppVramFit, useVramFitLevels, llamaCppFitTarget } =
  await import('./useLlamaCppVramFit.ts')

// A 7B-ish dense model: 32 layers, 4096 wide, 8 KV heads.
const inputs: LlamaCppVramInputs = {
  arch: {
    architecture: 'llama',
    blockCount: 32,
    embeddingLength: 4096,
    headCount: 32,
    headCountKv: 8,
    vocabSize: 128256,
  },
  weightsBytes: 4 * GIB,
  mmprojBytes: 0,
}

const getLlamaCppVramInputs = vi.fn(async (_name: string, _mmproj?: string) => inputs)

beforeEach(async () => {
  getLlamaCppVramInputs.mockClear()
  // The composable is the renderer's only caller of this IPC.
  ;(globalThis as unknown as { window: unknown }).window = {
    electronAPI: { getLlamaCppVramInputs },
  }
  textInference.backend = 'llamaCPP'
  textInference.contextSize = 8192
  textInference.llmModels = [
    { name: 'owner/repo/model.gguf', type: 'llamaCPP', active: true, downloaded: true },
  ]
  computeMetrics.primaryGpu = { memTotalMiB: 16 * 1024, memUsedMiB: 2 * 1024 }
  computeMetrics.gpus = undefined
  textInference.selectedDeviceName = null
})

async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('useLlamaCppVramFit', () => {
  it('reports the fit at the current, reference and maximum context', async () => {
    textInference.llmModels[0].maxContextSize = 131072
    const { summary } = useLlamaCppVramFit()
    await settle()

    const fit = summary.value
    expect(fit).not.toBeNull()
    expect(fit?.totalBytes).toBe(16 * 1024 * MIB)
    expect(fit?.availableBytes).toBe(14 * 1024 * MIB)
    expect(fit?.current.contextTokens).toBe(8192)
    expect(fit?.reference.contextTokens).toBe(8192)
    expect(fit?.max.contextTokens).toBe(131072)
    // Base is the file itself; only the context part grows with the window.
    expect(fit?.max.baseBytes).toBe(fit?.current.baseBytes)
    expect(fit?.max.contextBytes).toBeGreaterThan(fit?.current.contextBytes ?? 0)
    expect(fit?.level).toBe('easy')
  })

  it('follows the context slider, and re-reads no GGUF to do it', async () => {
    const { summary } = useLlamaCppVramFit()
    await settle()
    const atEightK = summary.value?.current.totalBytes ?? 0
    const reads = getLlamaCppVramInputs.mock.calls.length

    textInference.contextSize = 131072
    await nextTick()
    expect(summary.value?.current.totalBytes).toBeGreaterThan(atEightK)
    expect(getLlamaCppVramInputs).toHaveBeenCalledTimes(reads)
  })

  it('reads a model once for every place the chip is mounted', async () => {
    textInference.llmModels = [
      { name: 'owner/repo/second.gguf', type: 'llamaCPP', active: true, downloaded: true },
    ]
    useLlamaCppVramFit()
    await settle()
    const reads = getLlamaCppVramInputs.mock.calls.length
    useLlamaCppVramFit()
    await settle()
    expect(getLlamaCppVramInputs).toHaveBeenCalledTimes(reads)
  })

  it('judges a model that is not downloaded yet, projector included', async () => {
    textInference.llmModels = [
      {
        name: 'owner/repo/not-here.gguf',
        mmproj: 'owner/repo/mmproj-BF16.gguf',
        type: 'llamaCPP',
        active: true,
        downloaded: false,
      },
    ]
    const { summary } = useLlamaCppVramFit()
    await settle()

    expect(getLlamaCppVramInputs).toHaveBeenCalledWith(
      'owner/repo/not-here.gguf',
      'owner/repo/mmproj-BF16.gguf',
    )
    expect(summary.value?.level).toBe('easy')
  })

  it('judges a listed model rather than the active one, and reads each list model once', async () => {
    const listed = [
      { name: 'owner/repo/listed-a.gguf', type: 'llamaCPP', active: false, downloaded: false },
      { name: 'owner/repo/listed-b.gguf', type: 'llamaCPP', active: false, downloaded: true },
    ]
    textInference.llmModels = [
      { name: 'owner/repo/active.gguf', type: 'llamaCPP', active: true, downloaded: true },
      ...listed,
    ]
    // Two rows of the picker, each mounting its own chip, plus a second pass over
    // the same rows (the menu reopened).
    const fits = [...listed, ...listed].map((m) =>
      useLlamaCppVramFit(computed(() => m as unknown as LlmModel)),
    )
    await settle()

    const read = getLlamaCppVramInputs.mock.calls.map(([name]) => name)
    expect(fits.every((fit) => fit.summary.value?.level === 'easy')).toBe(true)
    expect(read).toContain('owner/repo/listed-a.gguf')
    expect(read).toContain('owner/repo/listed-b.gguf')
    expect(read).toHaveLength(new Set(read).size)
  })

  it('never has more than three headers in flight', async () => {
    let inFlight = 0
    let peak = 0
    getLlamaCppVramInputs.mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return inputs
    })
    const models = Array.from({ length: 9 }, (_, i) => ({
      name: `owner/repo/many-${i}.gguf`,
      type: 'llamaCPP',
      active: false,
      downloaded: false,
    }))
    models.forEach((m) => useLlamaCppVramFit(computed(() => m as unknown as LlmModel)))
    await vi.waitFor(() => expect(getLlamaCppVramInputs).toHaveBeenCalledTimes(9))

    expect(peak).toBeLessThanOrEqual(3)
  })

  it('turns red once the model no longer fits the card', async () => {
    computeMetrics.primaryGpu = { memTotalMiB: 4 * 1024, memUsedMiB: 512 }
    const { summary } = useLlamaCppVramFit()
    await settle()
    expect(summary.value?.level).toBe('over')
  })

  // A hybrid laptop: a 2 GiB iGPU whose "memory" is mostly host RAM, and an 8 GiB
  // discrete card. The verdict has to follow what llama.cpp was pointed at.
  const hybrid: GpuSample[] = [
    {
      id: '0',
      name: 'AMD Radeon 780M Graphics',
      vendor: 'unknown',
      dedicatedTotalMiB: 2048,
      sharedTotalMiB: 16384,
      memUsedMiB: 1749,
      memTotalMiB: 18432,
    },
    {
      id: '1',
      name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
      vendor: 'nvidia',
      dedicatedTotalMiB: 8188,
      memUsedMiB: 1278,
      memTotalMiB: 8188,
    },
  ]

  it('judges against the device the backend is set to', async () => {
    computeMetrics.gpus = hybrid
    textInference.selectedDeviceName = 'AMD Radeon 780M Graphics'
    const { summary } = useLlamaCppVramFit()
    await settle()
    expect(summary.value?.totalBytes).toBe(18432 * MIB)

    textInference.selectedDeviceName = 'NVIDIA GeForce RTX 4060 Laptop GPU'
    await nextTick()
    expect(summary.value?.totalBytes).toBe(8188 * MIB)
  })

  it('judges against the discrete card when no device is selected', async () => {
    computeMetrics.gpus = hybrid
    const { summary } = useLlamaCppVramFit()
    await settle()
    expect(summary.value?.totalBytes).toBe(8188 * MIB)
  })

  it('says nothing without a GPU sample or on another backend', async () => {
    computeMetrics.primaryGpu = undefined
    const { summary } = useLlamaCppVramFit()
    await settle()
    expect(summary.value).toBeNull()

    computeMetrics.primaryGpu = { memTotalMiB: 16 * 1024 }
    await nextTick()
    expect(summary.value).not.toBeNull()

    textInference.backend = 'openVINO'
    await settle()
    expect(summary.value).toBeNull()
  })
})

describe('useVramFitLevels', () => {
  const target = (name: string) => ({ name, downloaded: true })

  // The in-flight-cap test above leaves a deliberately slow implementation
  // behind, and the shared `beforeEach` only clears calls, not behaviour.
  beforeEach(() => getLlamaCppVramInputs.mockImplementation(async () => inputs))

  it('judges each model in a list, reading every header once', async () => {
    const { levelOf } = useVramFitLevels()
    const models = [target('owner/repo/a.gguf'), target('owner/repo/b.gguf')]
    // A filter re-runs on every keystroke; the reads must not.
    models.forEach((m) => levelOf(m))
    models.forEach((m) => levelOf(m))
    await settle()

    expect(models.map((m) => levelOf(m))).toEqual(['easy', 'easy'])
    expect(getLlamaCppVramInputs).toHaveBeenCalledTimes(2)
  })

  it('says nothing before the header lands, and nothing without a GPU sample', async () => {
    const { levelOf } = useVramFitLevels()
    // First call only starts the read — the answer cannot be there yet.
    expect(levelOf(target('owner/repo/slow.gguf'))).toBeNull()
    await settle()
    expect(levelOf(target('owner/repo/slow.gguf'))).toBe('easy')

    computeMetrics.primaryGpu = undefined
    expect(levelOf(target('owner/repo/slow.gguf'))).toBeNull()
  })

  // The difference that decides whether a model is filtered away: a header that
  // came back empty is an answer ("we cannot size this"), a header still in
  // flight is not one yet. Null is what the main process returns for a model it
  // could not read — it catches the 404 and the unparseable header itself — so
  // this one case covers every way the estimate can come back missing.
  it('calls a model unknown once its header comes back empty, not while it is in flight', async () => {
    getLlamaCppVramInputs.mockImplementation(async () => null as unknown as LlamaCppVramInputs)
    const { levelOf } = useVramFitLevels()
    expect(levelOf(target('owner/repo/headerless.gguf'))).toBeNull()
    await settle()
    expect(levelOf(target('owner/repo/headerless.gguf'))).toBe('unknown')
  })

  it('shares its cache with the chip, so a listed model is read once for both', async () => {
    const model = { name: 'owner/repo/shared.gguf', downloaded: true }
    useLlamaCppVramFit(computed(() => model))
    await settle()
    getLlamaCppVramInputs.mockClear()

    const { levelOf } = useVramFitLevels()
    expect(levelOf(model)).toBe('easy')
    expect(getLlamaCppVramInputs).not.toHaveBeenCalled()
  })

  it('turns a model away only when it is over the card', async () => {
    computeMetrics.primaryGpu = { memTotalMiB: 4 * 1024, memUsedMiB: 512 }
    const { levelOf } = useVramFitLevels()
    levelOf(target('owner/repo/big.gguf'))
    await settle()
    expect(levelOf(target('owner/repo/big.gguf'))).toBe('over')
  })
})

describe('llamaCppFitTarget', () => {
  it('passes a llama.cpp model through and drops every other backend', () => {
    const gguf = { name: 'owner/repo/a.gguf', type: 'llamaCPP', downloaded: true }
    expect(llamaCppFitTarget(gguf as unknown as LlmModel)).toBe(gguf)
    // An OpenVINO row would otherwise cost a HuggingFace range request to learn
    // there is no GGUF header to read.
    const ov = { name: 'owner/repo/ov', type: 'openVINO', downloaded: true }
    expect(llamaCppFitTarget(ov as unknown as LlmModel)).toBeUndefined()
    expect(llamaCppFitTarget(undefined)).toBeUndefined()
  })
})
