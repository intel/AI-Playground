import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('electron', () => ({
  nativeImage: {
    createFromDataURL: vi.fn(() => ({ isEmpty: () => false, toPNG: () => Buffer.from('PNG') })),
  },
}))

vi.mock('../../adapters/backends/comfyuiTools.ts', () => ({
  isCustomNodeInstalled: vi.fn(() => true),
  isPackageInstalled: vi.fn(async () => true),
  installPypiPackage: vi.fn(async () => {}),
  downloadCustomNode: vi.fn(async () => true),
}))

// The runner's transport is tested in comfyClient.test.ts; here it is a fake
// so tests can push websocket frames and inspect submitted prompts.
vi.mock('../../artifact/comfyClient', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    submitPrompt: vi.fn(async () => {}),
    interruptExecution: vi.fn(async () => {}),
    clearQueue: vi.fn(async () => {}),
    uploadInputFile: vi.fn(async () => {}),
    getComfySocket: vi.fn(),
  }
})

const { saveMediaItems } = vi.hoisted(() => ({
  saveMediaItems: vi.fn(async (_items: unknown[]) => {}),
}))

vi.mock('../../persist/mediaItemFiles.ts', () => ({
  saveMediaItems,
}))

import {
  cancelActiveArtifactRun,
  resetArtifactRunnerForTest,
  setArtifactRunnerDeps,
  type ArtifactRunPayload,
  type RunnerComfyService,
} from '../../artifact/runner'
import {
  cancelArtifactRun,
  resetOrchestratorForTest,
  submitArtifactRun,
} from '../../kernel/orchestrator'
import {
  resetKernelBusForTest,
  setKernelEventWindow,
  getKernelSnapshot,
} from '../../kernel/kernelBus'
import { submitPrompt, getComfySocket, interruptExecution } from '../../artifact/comfyClient'
import type {
  ComfyClientDeps,
  ComfySocketHandle,
  ComfySocketHandlers,
} from '../../artifact/comfyClient'
import type { ArtifactRunInput } from '../../artifact/workflowRewrite'
import type { ComfyUiPreset } from '@/lib/presetSchemas'
import type { ArtifactMissingModel } from '@/types/mediaRequests'
import { isImage, type MediaItem } from '@/types/mediaItem'

const FAKE_SOCKET = {
  opened: Promise.resolve(),
  readyState: () => 1,
  setHandlers: vi.fn(),
  close: vi.fn(),
}

let socketHandlers: {
  onBinaryPreview: (mime: string, bytes: ArrayBuffer) => void
  onJson: (msg: unknown) => void
  onClose: (code: number, reason: string) => void
} | null = null
let submittedPrompts: { workflow: unknown; clientId: string }[] = []
let kernelEvents: ({ type: string } & Record<string, unknown>)[] = []
let serviceStatus: string
let statusListeners: ((status: string) => void)[]
let consentRequests: number
let consentApproved: boolean
let missingModels: ArtifactMissingModel[]
const setPresetParameters = vi.fn(async (_parameters: string[]) => {})

function deps(overrides: Partial<Parameters<typeof setArtifactRunnerDeps>[0]> = {}) {
  return {
    getComfyService: (): RunnerComfyService =>
      ({
        currentStatus: serviceStatus,
        baseUrl: 'http://127.0.0.1:49123',
        start: vi.fn(async () => {
          serviceStatus = 'running'
          for (const listener of statusListeners) listener('running')
          return 'running'
        }),
        stop: vi.fn(async () => {
          serviceStatus = 'stopped'
          return 'stopped'
        }),
        getLoopbackAuthToken: () => 'token',
        serviceDir: '/comfy',
        getTorchBackendEnv: () => ({}),
        comfyUiVariantName: 'cpu',
        setPresetParameters,
      }) as unknown as RunnerComfyService,
    onServiceStatusChange: (cb: (status: string) => void) => {
      statusListeners.push(cb)
      return () => {
        statusListeners = statusListeners.filter((listener) => listener !== cb)
      }
    },
    modelsMissing: vi.fn(async (_preset: ComfyUiPreset) => missingModels),
    requestModelConsent: vi.fn(async () => {
      consentRequests++
      return consentApproved
    }),
    ensureOvmsImageReady: vi.fn(async () => ({ success: true as const, url: 'http://ovms' })),
    readMediaAsDataUri: vi.fn(async () => null),
    getPlatform: () => 'darwin' as NodeJS.Platform,
    devPresetsEnabled: () => false,
    ...overrides,
  }
}

function preset(): ComfyUiPreset {
  return {
    type: 'comfy',
    name: 'Test Image',
    backend: 'comfyui',
    category: 'create-images',
    toolCategory: 'create-images',
    mediaType: 'image',
    displayPriority: 0,
    tags: [],
    settings: [],
    requiredCustomNodes: ['someone/somenode'],
    requiredPythonPackages: [],
    requiredModels: [],
    comfyUiApiWorkflow: {
      '1': {
        class_type: 'EmptyImage',
        inputs: { width: 512, height: 512, batch_size: 1, color: 1 },
        _meta: { title: 'Empty Image' },
      },
      '2': {
        class_type: 'KSampler',
        inputs: { seed: 0, steps: 4, cfg: 1, sampler_name: 'euler' },
        _meta: { title: 'KSampler' },
      },
    },
  } as unknown as ComfyUiPreset
}

function payload(overrides: Partial<ArtifactRunPayload> = {}): ArtifactRunPayload {
  const inputs: ArtifactRunInput[] = []
  return {
    runId: 'run-1',
    mode: 'imageGen',
    preset: preset(),
    params: {
      prompt: 'a cat',
      negativePrompt: 'nsfw',
      seed: 1234,
      inferenceSteps: 4,
      width: 512,
      height: 512,
      batchSize: 2,
    },
    inputs,
    modelsConsented: true,
    ...overrides,
  }
}

function itemsFor(payload: ArtifactRunPayload): MediaItem[] {
  return Array.from({ length: payload.params.batchSize }, (_, i) => ({
    id: `item-${i}`,
    mode: payload.mode,
    state: 'queued' as const,
    type: 'image' as const,
    imageUrl: 'data:image/svg+xml,placeholder',
    settings: { seed: 1234 + i },
  }))
}

function phases(): string[] {
  return kernelEvents
    .filter((event) => event.type === 'artifact-phase')
    .map((event) => String(event.phase ?? ''))
}

describe('artifact runner', () => {
  beforeEach(() => {
    resetKernelBusForTest()
    resetArtifactRunnerForTest()
    resetOrchestratorForTest()
    kernelEvents = []
    const send = vi.fn((_channel: string, payload: { type: string }) => {
      kernelEvents.push(payload as { type: string } & Record<string, unknown>)
    })
    setKernelEventWindow({ isDestroyed: () => false, webContents: { send } } as never)

    submittedPrompts = []
    serviceStatus = 'running'
    statusListeners = []
    consentRequests = 0
    consentApproved = true
    missingModels = []
    socketHandlers = null
    setPresetParameters.mockClear()
    saveMediaItems.mockClear()
    vi.mocked(getComfySocket).mockImplementation(
      (
        _baseUrl: string,
        _deps: ComfyClientDeps,
        _clientId: string,
        handlers: ComfySocketHandlers,
      ) => {
        socketHandlers = handlers
        return FAKE_SOCKET as unknown as ComfySocketHandle
      },
    )
    vi.mocked(submitPrompt).mockImplementation(
      async (_baseUrl: string, _deps: ComfyClientDeps, workflow: unknown, clientId: string) => {
        submittedPrompts.push({ workflow, clientId })
      },
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs a batch to completion, streaming phases and item events', async () => {
    setArtifactRunnerDeps(deps())
    const request = payload()
    const run = submitArtifactRun({ ...request, items: itemsFor(request) })

    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(2))
    // One prompt per batch entry, each with its own seed.
    const seeds = submittedPrompts.map(
      (submitted) =>
        (submitted.workflow as Record<string, { inputs?: Record<string, unknown> }>)['2']!.inputs!
          .seed,
    )
    expect(seeds).toEqual(['1234', '1235'])

    socketHandlers!.onJson({ type: 'execution_start' })
    socketHandlers!.onJson({ type: 'progress', data: { value: 1, max: 4 } })
    socketHandlers!.onJson({
      type: 'executed',
      data: {
        node: '2',
        output: { images: [{ filename: 'out0.png', subfolder: '', type: 'output' }] },
      },
    })
    socketHandlers!.onJson({
      type: 'executed',
      data: {
        node: '2',
        output: { images: [{ filename: 'out1.png', subfolder: '', type: 'output' }] },
      },
    })

    const result = await run
    expect(result.state).toBe('completed')
    expect(result.items).toHaveLength(2)
    expect(result.items[0].state).toBe('done')
    const first = result.items[0]
    expect(isImage(first) && first.imageUrl).toContain('aipg-media://')
    expect(phases()).toEqual(
      expect.arrayContaining([
        'queued',
        'preparing-backend',
        'loading-components',
        'running',
        'completed',
      ]),
    )
    expect(kernelEvents.filter((event) => event.type === 'artifact-item')).toHaveLength(2 + 1 + 2)
    expect(saveMediaItems).toHaveBeenCalledTimes(1)
    const savedItems = saveMediaItems.mock.calls[0]?.[0] as unknown as MediaItem[]
    expect(savedItems).toHaveLength(2)
    expect(savedItems[0]).toMatchObject({ state: 'done' })
  })

  it('applies the preset launch flags before starting the backend', async () => {
    setArtifactRunnerDeps(deps())
    const request = payload()
    request.preset = {
      ...preset(),
      requiredComfyUiParameters: ['--use-quad-cross-attention'],
    } as ComfyUiPreset
    const run = submitArtifactRun({ ...request, items: itemsFor(request) })

    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(2))
    expect(setPresetParameters).toHaveBeenCalledWith(['--use-quad-cross-attention'])

    socketHandlers!.onJson({ type: 'execution_start' })
    socketHandlers!.onJson({
      type: 'executed',
      data: {
        node: '2',
        output: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
      },
    })
    socketHandlers!.onJson({
      type: 'executed',
      data: {
        node: '2',
        output: { images: [{ filename: 'b.png', subfolder: '', type: 'output' }] },
      },
    })
    const result = await run
    expect(result.state).toBe('completed')
  })

  it('fail-fast refuses while a run is active, queued submissions wait', async () => {
    setArtifactRunnerDeps(deps())
    const first = payload()
    const active = submitArtifactRun({ ...first, items: itemsFor(first) })
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(2))

    const refused = await submitArtifactRun(payload({ runId: 'run-2' }))
    expect(refused.state).toBe('failed')
    expect(refused.error).toBe('Another generation is already in progress')

    const queued = submitArtifactRun(payload({ runId: 'run-3' }), { queue: 'queue' })
    expect(await Promise.race([queued, Promise.resolve('pending')])).toBe('pending')

    socketHandlers!.onJson({
      type: 'executed',
      data: {
        node: '2',
        output: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
      },
    })
    socketHandlers!.onJson({
      type: 'executed',
      data: {
        node: '2',
        output: { images: [{ filename: 'b.png', subfolder: '', type: 'output' }] },
      },
    })
    const firstResult = await active
    expect(firstResult.state).toBe('completed')

    // The queued run starts as soon as the GPU is free.
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(4))
    socketHandlers!.onJson({
      type: 'executed',
      data: {
        node: '2',
        output: { images: [{ filename: 'c.png', subfolder: '', type: 'output' }] },
      },
    })
    socketHandlers!.onJson({
      type: 'executed',
      data: {
        node: '2',
        output: { images: [{ filename: 'd.png', subfolder: '', type: 'output' }] },
      },
    })
    const queuedResult = await queued
    expect(queuedResult.state).toBe('completed')
  })

  it('tags in-process items and the snapshot with the applied variant, not variants[0]', async () => {
    setArtifactRunnerDeps(deps())
    const request = payload({
      variant: 'Fast',
      origin: 'agent',
      items: undefined,
      params: { ...payload().params, batchSize: 1 },
      preset: {
        ...preset(),
        variants: [
          { name: 'Standard', overrides: {} },
          { name: 'Fast', overrides: {} },
        ],
      } as ReturnType<typeof preset>,
    })
    const run = submitArtifactRun(request)
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(1))

    const snapshot = getKernelSnapshot().state.activeArtifactRun
    expect(snapshot?.variant).toBe('Fast')
    expect(snapshot?.origin).toBe('agent')
    expect(snapshot?.items[0]?.settings.variant).toBe('Fast')

    socketHandlers!.onJson({
      type: 'executed',
      data: {
        node: '2',
        output: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] },
      },
    })
    await run
    expect(saveMediaItems).not.toHaveBeenCalled()
  })

  it('stamps the owner on every event of a queued tool run, before it starts too', async () => {
    setArtifactRunnerDeps(deps())
    const first = payload({ params: { ...payload().params, batchSize: 1 } })
    const active = submitArtifactRun({ ...first, items: itemsFor(first) })
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(1))

    const owner = { kind: 'tool' as const, toolCallId: 'inner-1', parentToolCallId: 'media-1' }
    const queued = submitArtifactRun(
      payload({
        runId: 'run-2',
        origin: 'renderer',
        owner,
        items: undefined,
        params: { ...payload().params, batchSize: 1 },
      }),
      { queue: 'queue' },
    )
    const ownRun = () => kernelEvents.filter((event) => event.runId === 'run-2')
    expect(ownRun()).toEqual([
      expect.objectContaining({ type: 'artifact-phase', phase: 'queued', owner }),
    ])

    socketHandlers!.onJson({
      type: 'executed',
      data: {
        node: '2',
        output: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
      },
    })
    await active
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(2))
    socketHandlers!.onJson({
      type: 'executed',
      data: {
        node: '2',
        output: { images: [{ filename: 'b.png', subfolder: '', type: 'output' }] },
      },
    })
    expect((await queued).state).toBe('completed')

    const events = ownRun()
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['artifact-phase', 'artifact-item', 'artifact-done']),
    )
    for (const event of events) {
      expect(event).toMatchObject({ owner, origin: 'renderer' })
    }
  })

  it('ignores leftover websocket frames from a settled run after a queued run starts', async () => {
    setArtifactRunnerDeps(deps())
    const first = payload({ params: { ...payload().params, batchSize: 1 } })
    const active = submitArtifactRun({ ...first, items: itemsFor(first) })
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(1))
    const firstHandlers = socketHandlers!

    const queued = submitArtifactRun(
      payload({ runId: 'run-2', params: { ...payload().params, batchSize: 1 } }),
      { queue: 'queue' },
    )

    firstHandlers.onJson({
      type: 'executed',
      data: {
        node: '2',
        output: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
      },
    })
    expect((await active).state).toBe('completed')

    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(2))
    const secondHandlers = socketHandlers!
    expect(secondHandlers).not.toBe(firstHandlers)

    // A stray frame on the previous run's handlers must not settle the next one.
    firstHandlers.onJson({
      type: 'executed',
      data: {
        node: '2',
        output: { images: [{ filename: 'stray.png', subfolder: '', type: 'output' }] },
      },
    })
    expect(await Promise.race([queued, Promise.resolve('pending')])).toBe('pending')

    secondHandlers.onJson({
      type: 'executed',
      data: {
        node: '2',
        output: { images: [{ filename: 'b.png', subfolder: '', type: 'output' }] },
      },
    })
    expect((await queued).state).toBe('completed')
  })

  it('asks for consent when models are missing and cancels when declined', async () => {
    missingModels = [
      { repo_id: 'some/model.gguf', type: 'unet', backend: 'comfyui', model_path: '/models' },
    ]
    consentApproved = false
    setArtifactRunnerDeps(deps())
    const result = await submitArtifactRun(payload({ modelsConsented: undefined }))
    expect(consentRequests).toBe(1)
    expect(result.state).toBe('cancelled')
    expect(submittedPrompts).toHaveLength(0)
  })

  it('starts the backend and waits for the running status before submitting', async () => {
    serviceStatus = 'stopped'
    setArtifactRunnerDeps(deps())
    const request = payload({ params: { ...payload().params, batchSize: 1 } })
    const run = submitArtifactRun({ ...request, items: itemsFor(request) })

    await vi.waitFor(() => expect(serviceStatus).toBe('running'))
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(1))
    socketHandlers!.onJson({
      type: 'executed',
      data: {
        node: '2',
        output: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
      },
    })
    expect((await run).state).toBe('completed')
  })

  it('fails the run when the backend crashes mid-run', async () => {
    setArtifactRunnerDeps(deps())
    const request = payload({ params: { ...payload().params, batchSize: 1 } })
    const run = submitArtifactRun({ ...request, items: itemsFor(request) })
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(1))

    serviceStatus = 'error'
    for (const listener of statusListeners) listener('error')

    const result = await run
    expect(result.state).toBe('failed')
    expect(result.error).toContain('stopped unexpectedly')
  })

  it('summarizes ComfyUI execution errors onto the failed result', async () => {
    setArtifactRunnerDeps(deps())
    const request = payload({ params: { ...payload().params, batchSize: 1 } })
    const run = submitArtifactRun({ ...request, items: itemsFor(request) })
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(1))

    socketHandlers!.onJson({
      type: 'execution_error',
      data: { node_id: '1', exception_type: 'ValueError', exception_message: 'bad input' },
    })
    const result = await run
    expect(result.state).toBe('failed')
    expect(result.error).toBeTruthy()
  })

  it('cancels the active run, settling in-flight items as stopped', async () => {
    setArtifactRunnerDeps(deps())
    const request = payload()
    const run = submitArtifactRun({ ...request, items: itemsFor(request) })
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(2))

    cancelActiveArtifactRun()
    const result = await run
    expect(result.state).toBe('cancelled')
    expect(interruptExecution).toHaveBeenCalled()
    expect(
      kernelEvents.filter((event) => event.type === 'artifact-item').length,
    ).toBeGreaterThanOrEqual(4)
  })

  it('cancels a queued run by id without touching the active one', async () => {
    setArtifactRunnerDeps(deps())
    const request = payload()
    const active = submitArtifactRun({ ...request, items: itemsFor(request) })
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(2))

    const queued = submitArtifactRun(payload({ runId: 'run-9' }), { queue: 'queue' })
    cancelArtifactRun('run-9')
    const cancelled = await queued
    expect(cancelled.state).toBe('cancelled')
    expect(active).toBeDefined()
    cancelActiveArtifactRun()
    await active
  })

  it('fails a stalled run through the idle watchdog', async () => {
    vi.useFakeTimers()
    setArtifactRunnerDeps(deps())
    const request = payload({ params: { ...payload().params, batchSize: 1 } })
    const run = submitArtifactRun({ ...request, items: itemsFor(request) })
    // Let the drive pass run to the submit point under fake timers.
    await vi.advanceTimersByTimeAsync(10)
    expect(submittedPrompts).toHaveLength(1)

    // Progress re-arms the watchdog...
    socketHandlers!.onJson({ type: 'progress', data: { value: 1, max: 4 } })
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(
      kernelEvents.some((event) => event.type === 'artifact-phase' && event.phase === 'failed'),
    ).toBe(false)

    await vi.advanceTimersByTimeAsync(2 * 60_000)
    const result = await run
    expect(result.state).toBe('failed')
    expect(result.error).toContain('stalled')
  })
})
