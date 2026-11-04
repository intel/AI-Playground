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

const { recordMediaTurn } = vi.hoisted(() => ({
  recordMediaTurn: vi.fn(async (turn: { sessionId: string; items: unknown[] }) =>
    (turn.items as { id: string }[]).map((item) => ({
      ...item,
      imageUrl: `aipg-media://sessions/${turn.sessionId}/files/${item.id}.png`,
    })),
  ),
}))

vi.mock('../../session/sessionMediaTurn.ts', () => ({ recordMediaTurn }))

import {
  artifactRunActive,
  cancelActiveArtifactRun,
  resetArtifactRunnerForTest,
  setArtifactRunnerDeps,
  type ArtifactRunPayload,
  type RunnerComfyService,
} from '../../artifact/runner'
import {
  cancelArtifactRun,
  finishTextRequest,
  reclaimTurnPlace,
  resetOrchestratorForTest,
  setOrchestratorDeps,
  submitArtifactRun,
  submitTextRequest,
  type TurnPause,
} from '../../kernel/orchestrator'
import { awaitUser, resetUserWaitForTest } from '../../kernel/userWait'
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
    recordMediaTurn.mockClear()
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
    expect(saveMediaItems).not.toHaveBeenCalled()
  })

  it('settles a panel run in a Session into that Session', async () => {
    setArtifactRunnerDeps(deps())
    const request = payload({ sessionId: 'session-1', variant: 'Fast' })
    const run = submitArtifactRun({ ...request, items: itemsFor(request), origin: 'renderer' })

    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(2))
    for (const filename of ['out0.png', 'out1.png']) {
      socketHandlers!.onJson({
        type: 'executed',
        data: { node: '2', output: { images: [{ filename, subfolder: '', type: 'output' }] } },
      })
    }

    const result = await run
    expect(recordMediaTurn).toHaveBeenCalledTimes(1)
    expect(recordMediaTurn.mock.calls[0][0]).toMatchObject({
      sessionId: 'session-1',
      runId: 'run-1',
      mode: 'imageGen',
      preset: 'Test Image',
      variant: 'Fast',
      prompt: 'a cat',
      status: 'completed',
      items: [
        expect.objectContaining({ imageUrl: 'aipg-media://media/out0.png?v=item-0' }),
        expect.objectContaining({ imageUrl: 'aipg-media://media/out1.png?v=item-1' }),
      ],
    })
    const moved = 'aipg-media://sessions/session-1/files/item-0.png'
    expect(result.items[0]).toMatchObject({ imageUrl: moved })
    const done = kernelEvents.findIndex((event) => event.type === 'artifact-done')
    const movedEvent = kernelEvents.findIndex(
      (event) =>
        event.type === 'artifact-item' &&
        (event.item as MediaItem & { imageUrl: string }).imageUrl === moved,
    )
    expect(movedEvent).toBeGreaterThan(-1)
    expect(movedEvent).toBeLessThan(done)
  })

  it('records a failed panel run in its Session too', async () => {
    setArtifactRunnerDeps(deps())
    const request = payload({ sessionId: 'session-1' })
    const run = submitArtifactRun({ ...request, items: itemsFor(request), origin: 'renderer' })
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(2))
    socketHandlers!.onJson({
      type: 'execution_error',
      data: { exception_type: 'RuntimeError', exception_message: 'boom', node_id: '2' },
    })

    expect((await run).state).toBe('failed')
    expect(recordMediaTurn).toHaveBeenCalledTimes(1)
    expect(recordMediaTurn.mock.calls[0][0]).toMatchObject({ status: 'failed', items: [] })
  })

  it('leaves agent runs out of the Session History', async () => {
    setArtifactRunnerDeps(deps())
    const request = payload({
      sessionId: 'session-1',
      origin: 'agent',
      params: { ...payload().params, batchSize: 1 },
    })
    const run = submitArtifactRun(request)
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(1))
    socketHandlers!.onJson({
      type: 'executed',
      data: {
        node: '2',
        output: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
      },
    })
    await run
    expect(recordMediaTurn).not.toHaveBeenCalled()
  })

  it('gives two outputs distinct URLs when ComfyUI reuses a filename', async () => {
    setArtifactRunnerDeps(deps())
    const urls: string[] = []
    for (const runId of ['chat-run', 'agent-run']) {
      const run = submitArtifactRun(
        payload({ runId, origin: 'agent', params: { ...payload().params, batchSize: 1 } }),
      )
      await vi.waitFor(() => expect(artifactRunActive()).toBe(true))
      await vi.waitFor(() => expect(socketHandlers).not.toBeNull())
      socketHandlers!.onJson({
        type: 'executed',
        data: {
          node: '2',
          output: { images: [{ filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' }] },
        },
      })
      const result = await run
      socketHandlers = null
      const item = result.items[0]
      urls.push(isImage(item) ? item.imageUrl : '')
    }
    expect(urls[0]).not.toBe(urls[1])
    expect(urls[0]).toMatch(/^aipg-media:\/\/media\/ComfyUI_00001_\.png\?/)
    expect(urls[1]).toMatch(/^aipg-media:\/\/media\/ComfyUI_00001_\.png\?/)
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

  it('a queued submission waits while a run is active', async () => {
    setArtifactRunnerDeps(deps())
    const first = payload()
    const active = submitArtifactRun({ ...first, items: itemsFor(first) })
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(2))

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

describe('media from a turn asks for its models before the GPU is taken', () => {
  const MISSING: ArtifactMissingModel[] = [
    { repo_id: 'some/model.gguf', type: 'unet', backend: 'comfyui', model_path: '/models' },
  ]
  type AsyncMock = ReturnType<typeof vi.fn<() => Promise<void>>>
  let orchestrator: {
    stopChatForMedia: AsyncMock
    freeComfyMemory: AsyncMock
    restartChatBackend: AsyncMock
    chatRequestsOpen: () => number
  }
  let answers: { conversationKey: string | null | undefined; answer: (ok: boolean) => void }[]

  /** Consent the way main asks it: as a pause of the named turn, until the user answers. */
  function askingConsent(models: (preset: ComfyUiPreset) => ArtifactMissingModel[]) {
    return deps({
      modelsMissing: vi.fn(async (preset: ComfyUiPreset) => models(preset)),
      requestModelConsent: vi.fn(
        (_models: ArtifactMissingModel[], _onProgress?: () => void, key?: string | null) =>
          awaitUser(
            key ?? undefined,
            () =>
              new Promise<boolean>((resolve) => {
                answers.push({ conversationKey: key, answer: resolve })
              }),
            { kind: 'download', summary: 'some/model.gguf' },
          ),
      ),
    })
  }

  function completeBatchOfOne(): void {
    socketHandlers!.onJson({
      type: 'executed',
      data: {
        node: '2',
        output: { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
      },
    })
  }

  function oneImage(overrides: Partial<ArtifactRunPayload> = {}): ArtifactRunPayload {
    return payload({
      origin: 'agent',
      modelsConsented: undefined,
      params: { ...payload().params, batchSize: 1 },
      ...overrides,
    })
  }

  beforeEach(() => {
    resetKernelBusForTest()
    resetArtifactRunnerForTest()
    resetOrchestratorForTest()
    resetUserWaitForTest()
    kernelEvents = []
    setKernelEventWindow({
      isDestroyed: () => false,
      webContents: {
        send: (_channel: string, event: { type: string }) => {
          kernelEvents.push(event as { type: string } & Record<string, unknown>)
        },
      },
    } as never)
    submittedPrompts = []
    serviceStatus = 'running'
    statusListeners = []
    answers = []
    socketHandlers = null
    vi.mocked(getComfySocket).mockImplementation(
      (_b: string, _d: ComfyClientDeps, _c: string, handlers: ComfySocketHandlers) => {
        socketHandlers = handlers
        return FAKE_SOCKET as unknown as ComfySocketHandle
      },
    )
    vi.mocked(submitPrompt).mockImplementation(
      async (_b: string, _d: ComfyClientDeps, workflow: unknown, clientId: string) => {
        submittedPrompts.push({ workflow, clientId })
      },
    )
    orchestrator = {
      stopChatForMedia: vi.fn(async () => {}),
      freeComfyMemory: vi.fn(async () => {}),
      restartChatBackend: vi.fn(async () => {}),
      chatRequestsOpen: () => 0,
    }
    setOrchestratorDeps(orchestrator)
  })

  it('asks at submit, for the turn it belongs to, before the chat model is stopped', async () => {
    let missing = MISSING
    setArtifactRunnerDeps(askingConsent(() => missing))
    const run = submitArtifactRun(oneImage({ conversationKey: 'session-a' }), { queue: 'queue' })

    await vi.waitFor(() => expect(answers).toHaveLength(1))
    expect(answers[0].conversationKey).toBe('session-a')
    expect(orchestrator.stopChatForMedia).not.toHaveBeenCalled()
    expect(artifactRunActive()).toBe(false)

    missing = []
    answers[0].answer(true)
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(1))
    expect(orchestrator.stopChatForMedia).toHaveBeenCalledTimes(1)
    completeBatchOfOne()
    expect((await run).state).toBe('completed')
    expect(answers).toHaveLength(1)
  })

  it('a declined download cancels the run without touching the chat backend', async () => {
    setArtifactRunnerDeps(askingConsent(() => MISSING))
    const run = submitArtifactRun(oneImage({ conversationKey: 'session-a' }), { queue: 'queue' })
    await vi.waitFor(() => expect(answers).toHaveLength(1))

    answers[0].answer(false)
    expect(await run).toMatchObject({ state: 'cancelled', error: 'Generation cancelled.' })
    expect(orchestrator.stopChatForMedia).not.toHaveBeenCalled()
    expect(orchestrator.restartChatBackend).not.toHaveBeenCalled()
    expect(submittedPrompts).toHaveLength(0)
    expect(phases()).toEqual(['preparing-backend', 'cancelled'])
  })

  it('asks once for parallel calls from one turn, and none of them asks again', async () => {
    let missing = MISSING
    setArtifactRunnerDeps(askingConsent(() => missing))
    const first = submitArtifactRun(oneImage({ runId: 'sprite-1', conversationKey: 'session-a' }), {
      queue: 'queue',
    })
    const second = submitArtifactRun(
      oneImage({ runId: 'sprite-2', conversationKey: 'session-a' }),
      { queue: 'queue' },
    )
    await vi.waitFor(() => expect(answers).toHaveLength(1))

    missing = []
    answers[0].answer(true)
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(1))
    completeBatchOfOne()
    expect((await first).state).toBe('completed')
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(2))
    completeBatchOfOne()
    expect((await second).state).toBe('completed')
    expect(answers).toHaveLength(1)
  })

  it('a stop while the user decides ends the run, and a later answer starts nothing', async () => {
    setArtifactRunnerDeps(askingConsent(() => MISSING))
    const run = submitArtifactRun(oneImage({ conversationKey: 'session-a' }), { queue: 'queue' })
    await vi.waitFor(() => expect(answers).toHaveLength(1))

    cancelArtifactRun('run-1')
    expect((await run).state).toBe('cancelled')
    answers[0].answer(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(orchestrator.stopChatForMedia).not.toHaveBeenCalled()
    expect(submittedPrompts).toHaveLength(0)
  })

  it("a stopped run's unanswered prompt does not hold up the turn's next media", async () => {
    let missing = MISSING
    setArtifactRunnerDeps(askingConsent(() => missing))
    const stopped = submitArtifactRun(oneImage({ conversationKey: 'session-a' }), {
      queue: 'queue',
    })
    await vi.waitFor(() => expect(answers).toHaveLength(1))
    cancelArtifactRun('run-1')
    expect((await stopped).state).toBe('cancelled')

    missing = []
    const next = submitArtifactRun(oneImage({ runId: 'run-2', conversationKey: 'session-a' }), {
      queue: 'queue',
    })
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(1))
    completeBatchOfOne()
    expect((await next).state).toBe('completed')
  })

  it("pauses the asking turn while another session's turn and media run, then resumes first", async () => {
    const log: string[] = []
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
    const agentTurn = (runId: string, conversationKey: string) => {
      const pause: TurnPause = {
        onUserWait: (waiting) => log.push(`${runId} ${waiting ? 'paused' : 'answered'}`),
        onRequeued: () => log.push(`${runId} requeued`),
        onHolding: () => log.push(`${runId} holding`),
        readyAgain: async () => {
          log.push(`${runId} ready again`)
        },
      }
      return submitTextRequest({
        runId,
        conversationKey,
        needsGpu: true,
        joinsTurnQueue: true,
        work: 'agent',
        pause,
      }).then(() => log.push(`${runId} started`))
    }
    let sessionAMissing = MISSING
    setArtifactRunnerDeps(
      askingConsent((preset) => (preset.name === 'Session A Image' ? sessionAMissing : [])),
    )
    const sessionAImage = (runId: string) =>
      oneImage({
        runId,
        conversationKey: 'session-a',
        preset: { ...preset(), name: 'Session A Image' },
      })
    const sessionBImage = (runId: string) => oneImage({ runId, conversationKey: 'session-b' })

    await agentTurn('turn-a', 'session-a')
    const turnB = agentTurn('turn-b', 'session-b')
    const mediaA = submitArtifactRun(sessionAImage('media-a'), { queue: 'queue' })
    await turnB
    expect(answers.map((asked) => asked.conversationKey)).toEqual(['session-a'])
    expect(log).toEqual(['turn-a started', 'turn-a paused', 'turn-b started'])

    const firstB = submitArtifactRun(sessionBImage('media-b1'), { queue: 'queue' })
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(1))
    completeBatchOfOne()
    expect((await firstB).state).toBe('completed')

    sessionAMissing = []
    answers[0].answer(true)
    await settle()
    expect(log.slice(-2)).toEqual(['turn-a answered', 'turn-a requeued'])
    expect(submittedPrompts).toHaveLength(1)

    // Turn B's own media is not stuck behind the answered run waiting for B's place.
    const secondB = submitArtifactRun(sessionBImage('media-b2'), { queue: 'queue' })
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(2))
    completeBatchOfOne()
    expect((await secondB).state).toBe('completed')

    finishTextRequest('turn-b')
    await vi.waitFor(() => expect(submittedPrompts).toHaveLength(3))
    expect(log.at(-1)).toBe('turn-a holding')
    completeBatchOfOne()
    expect((await mediaA).state).toBe('completed')

    await reclaimTurnPlace('turn-a')
    expect(log.at(-1)).toBe('turn-a ready again')
    expect(log.filter((entry) => entry === 'turn-a ready again')).toHaveLength(1)
    finishTextRequest('turn-a')
  })

  it('never lets the turn hold its place while a second media prompt of it waits', async () => {
    const started: string[] = []
    const turn = (runId: string, conversationKey: string, pausable: boolean) =>
      submitTextRequest({
        runId,
        conversationKey,
        needsGpu: true,
        joinsTurnQueue: true,
        work: 'agent',
        pause: pausable
          ? { onUserWait: () => {}, onRequeued: () => {}, readyAgain: async () => {} }
          : undefined,
      }).then(() => started.push(runId))
    const stillMissing = new Set(['Sprite One', 'Sprite Two'])
    setArtifactRunnerDeps(askingConsent((preset) => (stillMissing.has(preset.name) ? MISSING : [])))
    const sprite = (name: string) =>
      oneImage({ runId: name, conversationKey: 'session-a', preset: { ...preset(), name } })

    await turn('turn-a', 'session-a', true)
    const turnB = turn('turn-b', 'session-b', false)
    const turnC = turn('turn-c', 'session-c', false)
    const one = submitArtifactRun(sprite('Sprite One'), { queue: 'queue' })
    const two = submitArtifactRun(sprite('Sprite Two'), { queue: 'queue' })
    await turnB
    await vi.waitFor(() => expect(answers).toHaveLength(1))

    stillMissing.delete('Sprite One')
    answers[0].answer(true)
    await vi.waitFor(() => expect(answers).toHaveLength(2))
    finishTextRequest('turn-b')
    await turnC
    expect(started).toEqual(['turn-a', 'turn-b', 'turn-c'])

    stillMissing.delete('Sprite Two')
    answers[1].answer(true)
    finishTextRequest('turn-c')
    for (const run of [one, two]) {
      await vi.waitFor(() => expect(submittedPrompts.length).toBeGreaterThan(0))
      completeBatchOfOne()
      submittedPrompts = []
      expect((await run).state).toBe('completed')
    }
    finishTextRequest('turn-a')
  })
})
