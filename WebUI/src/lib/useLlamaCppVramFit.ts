import { computed, reactive, watchEffect, type Ref } from 'vue'
import type { LlamaCppVramInputs } from '@/lib/vram/types'
import { useComputeMetrics } from '@/assets/js/store/computeMetrics'
import { useTextInference, type LlmModel } from '@/assets/js/store/textInference'
import {
  emptyCardBudgetBytes,
  estimateLlamaCppVram,
  mibToBytes,
  vramFitLevel,
  type VramFitLevel,
  type VramFitVerdict,
} from '@/lib/vram'

/** The context size every model is also shown at, so two models compare on one scale. */
export const REFERENCE_CONTEXT_TOKENS = 8192

// A header for a model that is not downloaded is a range request to HuggingFace,
// and the picker asks for every model it lists at once.
const MAX_PARALLEL_READS = 3

export type VramFitPoint = {
  contextTokens: number
  /** Weights plus a multimodal projector — everything that does not scale with context. */
  baseBytes: number
  /** KV cache, recurrent states, compute buffers and MTP draft. */
  contextBytes: number
  totalBytes: number
  level: VramFitLevel
}

export type VramFitSummary = {
  level: VramFitLevel
  /** Card size, and what is left of it right now. */
  totalBytes: number
  availableBytes: number
  /** The budget the verdict is against: an empty card minus the driver's share. */
  usableBytes: number
  current: VramFitPoint
  reference: VramFitPoint
  max: VramFitPoint
}

// One read per model for the whole app: the chip is mounted on the status bar, on
// the picker's trigger and on every row of its list, and a GGUF header does not
// change while the app runs. Keyed by where the header came from, so a model that
// finishes downloading is read again from the file itself.
const inputsCache = reactive(new Map<string, LlamaCppVramInputs | null>())
const inFlight = new Set<string>()
let running = 0
const waiting: (() => void)[] = []

function acquire(): Promise<void> {
  if (running < MAX_PARALLEL_READS) {
    running += 1
    return Promise.resolve()
  }
  return new Promise((resolve) =>
    waiting.push(() => {
      running += 1
      resolve()
    }),
  )
}

function release(): void {
  running -= 1
  waiting.shift()?.()
}

/**
 * The least a caller has to know about a model to get a verdict on it. The chat
 * picker passes an `LlmModel`; the model manager builds one of these from a
 * library entry, which carries no projector or context ceiling of its own.
 */
export type VramFitTarget = {
  name: string
  downloaded: boolean
  mmproj?: string
  llamaCppArgs?: string
  maxContextSize?: number
}

/**
 * A picker entry reduced to a target, or undefined when the estimator has nothing
 * to say about it. The guard is the caller's job rather than the composable's: a
 * model that is not a GGUF would otherwise cost a HuggingFace range request per
 * row to learn that, which is what the whole picker does on an OpenVINO preset.
 */
export function llamaCppFitTarget(model: LlmModel | undefined): VramFitTarget | undefined {
  return model?.type === 'llamaCPP' ? model : undefined
}

const cacheKey = (model: VramFitTarget) => `${model.downloaded ? 'local' : 'remote'}:${model.name}`

function requestInputs(model: VramFitTarget): void {
  const key = cacheKey(model)
  if (inputsCache.has(key) || inFlight.has(key)) return
  inFlight.add(key)
  void (async () => {
    await acquire()
    try {
      inputsCache.set(key, await window.electronAPI.getLlamaCppVramInputs(model.name, model.mmproj))
    } catch {
      inputsCache.set(key, null)
    } finally {
      release()
      inFlight.delete(key)
    }
  })()
}

/**
 * The card the verdict is about: the one llama.cpp is set to run on, not whichever
 * adapter the machine happens to call primary. On a hybrid laptop those differ, and
 * an iGPU's "memory" is mostly host RAM — a budget no GGUF actually gets.
 *
 * A CPU or NPU selection names no GPU, so the lookup falls back to the primary card
 * and the chip keeps answering "would this fit the card", which is what it is for.
 */
function fitGpu(
  textInference: ReturnType<typeof useTextInference>,
  computeMetrics: ReturnType<typeof useComputeMetrics>,
) {
  return computeMetrics.gpuFor(textInference.getDeviceNameForBackend('llamaCPP'))
}

/** The card as the estimator sees it: total size and the budget to judge against. */
type CardBudget = { totalBytes: number; availableBytes: number; usableBytes: number }

function cardBudget(gpu: { memTotalMiB?: number; memUsedMiB?: number } | undefined) {
  if (!gpu?.memTotalMiB) return null
  const totalBytes = mibToBytes(gpu.memTotalMiB)
  return {
    totalBytes,
    usableBytes: emptyCardBudgetBytes(totalBytes),
    availableBytes:
      gpu.memUsedMiB != null ? Math.max(0, totalBytes - mibToBytes(gpu.memUsedMiB)) : totalBytes,
  }
}

function summarize(
  model: VramFitTarget,
  source: LlamaCppVramInputs,
  card: CardBudget,
  contextSize: number,
): VramFitSummary {
  // The catalog asks for MTP off the model's own draft head on some models,
  // which costs KV and a slice of the weights on top of everything else.
  const mtp = (model.llamaCppArgs ?? '').includes('draft-mtp')
  const maxContext = model.maxContextSize

  const pointAt = (contextTokens: number): VramFitPoint => {
    const estimate = estimateLlamaCppVram({
      arch: source.arch,
      weightsBytes: source.weightsBytes,
      mmprojBytes: source.mmprojBytes,
      contextSize: contextTokens,
      flashAttention: true,
      nParallel: 1,
      mtp,
    })
    return {
      contextTokens,
      baseBytes: estimate.weightsBytes,
      contextBytes: estimate.totalBytes - estimate.weightsBytes,
      totalBytes: estimate.totalBytes,
      level: vramFitLevel(estimate.totalBytes, card.usableBytes),
    }
  }

  // A model narrower than the setting never gets the whole window.
  const current = pointAt(Math.min(contextSize, maxContext ?? Infinity))
  return {
    level: current.level,
    ...card,
    current,
    reference: pointAt(REFERENCE_CONTEXT_TOKENS),
    max: pointAt(maxContext ?? contextSize),
  }
}

/**
 * The verdict for any number of models, for code that filters a list rather than
 * rendering one chip. `levelOf` is a plain function so it can be called from a
 * `computed` over a whole list; reading it registers the model for a header read
 * and re-runs the computed once that lands.
 *
 * Three outcomes, and the difference between the last two is the whole point:
 * - a level, when the header was read and the estimate ran;
 * - `'unknown'`, when the read came back with nothing usable — a real answer
 *   about a model that should have had one, and a reason to keep it out;
 * - `null`, when there is nothing to say yet: no target, no GPU sample, or a
 *   header still in flight. Filtering on `null` would empty a list while it
 *   loads, so callers must leave those alone.
 */
export function useVramFitLevels() {
  const textInference = useTextInference()
  const computeMetrics = useComputeMetrics()

  function levelOf(model: VramFitTarget | undefined): VramFitVerdict | null {
    if (!model) return null
    requestInputs(model)
    const card = cardBudget(fitGpu(textInference, computeMetrics))
    if (!card) return null
    const key = cacheKey(model)
    // `undefined` is "not read yet"; `null` is "read, and there was nothing".
    if (!inputsCache.has(key)) return null
    const source = inputsCache.get(key)
    if (!source) return 'unknown'
    return summarize(model, source, card, textInference.contextSize).level
  }

  return { levelOf }
}

/**
 * How a llama.cpp model sits in the card's memory, at the current, a reference
 * and the model's maximum context. Defaults to the active model; pass one to ask
 * about a model the user is only looking at. Null whenever the answer would be a
 * guess: another backend, a header that could not be read, or no GPU sample yet.
 *
 * A model that is not on disk is read from its header on HuggingFace, which is
 * the moment the verdict is worth the most: before paying for the download.
 */
export function useLlamaCppVramFit(target?: Ref<VramFitTarget | undefined>) {
  const textInference = useTextInference()
  const computeMetrics = useComputeMetrics()

  const model = computed(() => {
    if (target) return target.value
    if (textInference.backend !== 'llamaCPP') return undefined
    return textInference.llmModels.find((m) => m.active && m.type === 'llamaCPP')
  })

  watchEffect(() => {
    if (model.value) requestInputs(model.value)
  })

  const inputs = computed(() => {
    const current = model.value
    return current ? (inputsCache.get(cacheKey(current)) ?? null) : null
  })

  const summary = computed<VramFitSummary | null>(() => {
    const card = cardBudget(fitGpu(textInference, computeMetrics))
    const source = inputs.value
    const current = model.value
    if (!source || !card || !current) return null
    return summarize(current, source, card, textInference.contextSize)
  })

  /**
   * What the chip should show. `'unknown'` is the "?" chip: a model in the
   * estimator's reach whose header came back empty. Null keeps the chip off the
   * row entirely — nothing asked for, or nothing answered yet.
   */
  const verdict = computed<VramFitVerdict | null>(() => {
    if (summary.value) return summary.value.level
    const current = model.value
    if (!current || !cardBudget(fitGpu(textInference, computeMetrics))) return null
    return inputsCache.has(cacheKey(current)) ? 'unknown' : null
  })

  return { summary, verdict }
}
