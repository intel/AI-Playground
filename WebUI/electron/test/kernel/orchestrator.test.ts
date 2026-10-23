import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const queueEvents: Array<Record<string, unknown>> = []
const phaseEvents: Array<{ tag: Record<string, unknown>; phase: string }> = []
vi.mock('../../kernel/kernelBus', () => ({
  emitQueueEvent: (event: Record<string, unknown>) => {
    queueEvents.push(event)
  },
  emitArtifactPhase: (tag: Record<string, unknown>, phase: string) => {
    phaseEvents.push({ tag, phase })
  },
}))

// The orchestrator sits on the runner's execution seam; here the runner is a
// controllable stub so the tests own when "the run" settles.
const startArtifactRunMock = vi.fn<(payload: { runId: string }) => Promise<unknown>>()
let activeRunId: string | null = null
const cancelActiveMock = vi.fn()
vi.mock('../../artifact/runner', () => ({
  artifactRunActive: () => activeRunId !== null,
  cancelActiveArtifactRun: () => cancelActiveMock(),
  activeArtifactRunId: () => activeRunId,
  artifactRunTag: (payload: { runId: string; owner?: unknown }) => ({
    runId: payload.runId,
    owner: payload.owner,
  }),
  startArtifactRun: (payload: { runId: string }) => startArtifactRunMock(payload),
}))

import {
  artifactRunsQueued,
  artifactWorkOpen,
  awaitChatWindow,
  cancelArtifactRun,
  cancelAllArtifactRuns,
  finishTextRequest,
  mediaRequestsQueued,
  resetOrchestratorForTest,
  runMediaRequest,
  setOrchestratorDeps,
  submitArtifactRun,
  submitTextRequest,
  textRequestsOpen,
  type OrchestratorDeps,
} from '../../kernel/orchestrator'
import type { ArtifactRunPayload } from '../../artifact/runner'

type Deferred = {
  resolve: (value: unknown) => void
  promise: Promise<unknown>
}

function deferred(): Deferred {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((res) => {
    resolve = res
  })
  return { resolve, promise }
}

function payload(overrides: Partial<ArtifactRunPayload> = {}): ArtifactRunPayload {
  return {
    runId: 'run-1',
    mode: 'imageGen',
    preset: { name: 'Draft Image' } as ArtifactRunPayload['preset'],
    params: {
      prompt: 'a castle',
      negativePrompt: '',
      seed: 1,
      inferenceSteps: 4,
      width: 512,
      height: 512,
      batchSize: 1,
    },
    inputs: [],
    ...overrides,
  } as ArtifactRunPayload
}

/**
 * Arms the runner stub so the NEXT submitted run holds the active slot until
 * the returned deferred resolves.
 */
function holdNextRun(): Deferred {
  const hold = deferred()
  startArtifactRunMock.mockImplementationOnce(async (request) => {
    activeRunId = request.runId
    const result = await hold.promise
    if (activeRunId === request.runId) activeRunId = null
    return result
  })
  return hold
}

const deps = (overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps => ({
  stopChatForMedia: vi.fn(async () => {}),
  freeComfyMemory: vi.fn(async () => {}),
  restartChatBackend: vi.fn(async () => {}),
  chatRequestsOpen: () => 0,
  ...overrides,
})

describe('the orchestrator', () => {
  beforeEach(() => {
    // reset, not clear: a test that cancels a queued run leaves its armed
    // once-implementation unconsumed, and the next test's run would inherit
    // a hold it can never resolve.
    vi.resetAllMocks()
    queueEvents.length = 0
    phaseEvents.length = 0
    activeRunId = null
    resetOrchestratorForTest()
  })

  it('announces a parked run as queued to its owner, and as cancelled when dropped', async () => {
    setOrchestratorDeps(deps())
    const hold = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(activeRunId).toBe('run-1'))

    const owner = { kind: 'tool' as const, toolCallId: 'call-2' }
    const queued = submitArtifactRun(payload({ runId: 'run-2', owner }), { queue: 'queue' })
    expect(phaseEvents).toEqual([{ tag: { runId: 'run-2', owner }, phase: 'queued' }])

    cancelArtifactRun('run-2')
    expect((await queued).state).toBe('cancelled')
    expect(phaseEvents.at(-1)).toEqual({ tag: { runId: 'run-2', owner }, phase: 'cancelled' })

    hold.resolve({ state: 'completed', items: [] })
    await active
  })

  it('fail-fast refuses while anything is executing or queued; queue submissions park FIFO', async () => {
    setOrchestratorDeps(deps())
    const holdOne = holdNextRun()
    const active = submitArtifactRun(payload())
    // The runner stub marks the active slot when its async body runs; real
    // runs are synchronous at that point, here the slot is awaited.
    await vi.waitFor(() => expect(activeRunId).toBe('run-1'))

    const refused = await submitArtifactRun(payload({ runId: 'run-2' }))
    expect(refused.state).toBe('failed')
    expect(refused.error).toBe('Another generation is already in progress')

    const holdTwo = holdNextRun()
    const queued = submitArtifactRun(payload({ runId: 'run-3' }), { queue: 'queue' })
    expect(artifactRunsQueued()).toBe(1)
    expect((await submitArtifactRun(payload({ runId: 'run-4' }))).state).toBe('failed')

    holdOne.resolve({ state: 'completed', items: [] })
    await active
    await vi.waitFor(() => expect(activeRunId).toBe('run-3'))
    holdTwo.resolve({ state: 'completed', items: [] })
    expect((await queued).state).toBe('completed')
  })

  it('emits queue events in enqueue → start → finish order, carrying the chat scope', async () => {
    setOrchestratorDeps(deps())
    const holdOne = holdNextRun()
    const active = submitArtifactRun(payload({ conversationKey: 'c1', activityId: 'act-1' }))
    await vi.waitFor(() => expect(activeRunId).toBe('run-1'))
    const queued = submitArtifactRun(
      payload({ runId: 'run-2', conversationKey: 'c1', activityId: 'act-2' }),
      { queue: 'queue' },
    )

    expect(queueEvents.find((e) => e.action === 'enqueued')).toMatchObject({
      runKey: 'run-2',
      kind: 'artifact',
      queueDepth: 0,
      conversationKey: 'c1',
      activityId: 'act-2',
    })

    holdOne.resolve({ state: 'completed', items: [] })
    await active
    await queued
    expect(queueEvents.map((e) => `${e.runKey}:${e.action}`)).toEqual([
      'run-1:started',
      'run-2:enqueued',
      'run-1:finished',
      'run-2:started',
      'run-2:finished',
    ])
  })

  it('brackets the GPU window: one stop per drain, free + reload once on the last run out', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const holdOne = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalled())
    expect(activeRunId).toBe('run-1')

    const holdTwo = holdNextRun()
    const queued = submitArtifactRun(payload({ runId: 'run-2' }), { queue: 'queue' })

    // The head settles with work queued behind: no swap-back.
    holdOne.resolve({ state: 'completed', items: [] })
    await active
    expect(d.freeComfyMemory).not.toHaveBeenCalled()
    expect(d.restartChatBackend).not.toHaveBeenCalled()

    // The queued run takes the window without a second stop…
    await vi.waitFor(() => expect(activeRunId).toBe('run-2'))
    expect(d.stopChatForMedia).toHaveBeenCalledTimes(1)

    // …and the last one out swaps back exactly once.
    holdTwo.resolve({ state: 'completed', items: [] })
    await queued
    expect(d.stopChatForMedia).toHaveBeenCalledTimes(1)
    expect(d.freeComfyMemory).toHaveBeenCalledTimes(1)
    expect(d.restartChatBackend).toHaveBeenCalledTimes(1)
  })

  it('does not admit a GPU chat turn while stopChatForMedia is in flight', async () => {
    const stop = deferred()
    const d = deps({ stopChatForMedia: vi.fn(() => stop.promise as Promise<void>) })
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const media = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalled())

    let admitted = false
    const text = submitTextRequest({
      runId: 'turn-1',
      conversationKey: 'c1',
      needsGpu: true,
    }).then(() => {
      admitted = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(admitted).toBe(false)
    expect(textRequestsOpen()).toBe(1)

    stop.resolve(undefined)
    await vi.waitFor(() => expect(activeRunId).toBe('run-1'))
    expect(admitted).toBe(false)

    hold.resolve({ state: 'completed', items: [] })
    await media
    await text
    expect(admitted).toBe(true)
  })

  it('returns the GPU after a failed run', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalled())
    hold.resolve({ state: 'failed', items: [], error: 'boom' })
    await active
    expect(d.freeComfyMemory).toHaveBeenCalledTimes(1)
    expect(d.restartChatBackend).toHaveBeenCalledTimes(1)
  })

  it('abandons queued and in-acquire artifact work', async () => {
    const stop = deferred()
    const d = deps({ stopChatForMedia: vi.fn(() => stop.promise as Promise<void>) })
    setOrchestratorDeps(d)
    holdNextRun()
    const acquiring = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalled())
    const queued = submitArtifactRun(payload({ runId: 'run-2' }), { queue: 'queue' })
    expect(artifactWorkOpen()).toBe(true)
    expect(artifactRunsQueued()).toBe(1)

    cancelAllArtifactRuns('The app window was replaced')
    expect((await queued).state).toBe('cancelled')
    expect(artifactRunsQueued()).toBe(0)

    stop.resolve(undefined)
    expect((await acquiring).state).toBe('cancelled')
    expect(activeRunId).toBe(null)
    await vi.waitFor(() => expect(d.restartChatBackend).toHaveBeenCalledTimes(1))
    expect(artifactWorkOpen()).toBe(false)
  })

  it('never swaps when keepModelsLoaded is set', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const active = submitArtifactRun(payload({ keepModelsLoaded: true }))
    await vi.waitFor(() => expect(activeRunId).toBe('run-1'))
    hold.resolve({ state: 'completed', items: [] })
    await active
    expect(d.stopChatForMedia).not.toHaveBeenCalled()
    expect(d.freeComfyMemory).not.toHaveBeenCalled()
    expect(d.restartChatBackend).not.toHaveBeenCalled()
  })

  it('still returns the GPU after a keepModelsLoaded tail that followed a swap', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const holdOne = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalledTimes(1))

    const holdTwo = holdNextRun()
    const queued = submitArtifactRun(payload({ runId: 'run-2', keepModelsLoaded: true }), {
      queue: 'queue',
    })
    holdOne.resolve({ state: 'completed', items: [] })
    await active
    expect(d.freeComfyMemory).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(activeRunId).toBe('run-2'))

    holdTwo.resolve({ state: 'completed', items: [] })
    await queued
    expect(d.freeComfyMemory).toHaveBeenCalledTimes(1)
    expect(d.restartChatBackend).toHaveBeenCalledTimes(1)
  })

  it('fail-fast refuses a second submit in the same tick, before the runner is active', async () => {
    setOrchestratorDeps(deps())
    const hold = holdNextRun()
    const first = submitArtifactRun(payload({ runId: 'run-1' }))
    const second = submitArtifactRun(payload({ runId: 'run-2' }))
    expect((await second).state).toBe('failed')
    expect((await second).error).toBe('Another generation is already in progress')
    await vi.waitFor(() => expect(activeRunId).toBe('run-1'))
    hold.resolve({ state: 'completed', items: [] })
    await first
  })

  it('waits for open chat requests before stopping the backend', async () => {
    let openRequests = 2
    const d = deps({ chatRequestsOpen: () => openRequests })
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const active = submitArtifactRun(payload())
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(d.stopChatForMedia).not.toHaveBeenCalled()
    openRequests = 0
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalledTimes(1))
    hold.resolve({ state: 'completed', items: [] })
    await active
  })

  it('chat readiness waits for the GPU window to come back to chat', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalled())

    let settled = false
    const readiness = awaitChatWindow().then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)

    hold.resolve({ state: 'completed', items: [] })
    await active
    await readiness
    expect(settled).toBe(true)
  })

  it('rejects awaitChatWindow as soon as the signal aborts, not on the next poll', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalled())

    const ac = new AbortController()
    const waiting = awaitChatWindow(ac.signal)
    const started = Date.now()
    ac.abort()
    await expect(waiting).rejects.toThrow('Cancelled while waiting for the chat GPU window.')
    expect(Date.now() - started).toBeLessThan(200)

    hold.resolve({ state: 'completed', items: [] })
    await active
  })

  it('cancels a queued run by id without touching the active one', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(activeRunId).toBe('run-1'))

    holdNextRun()
    const queued = submitArtifactRun(payload({ runId: 'run-2', activityId: 'act-2' }), {
      queue: 'queue',
    })
    cancelArtifactRun('run-2')
    expect((await queued).state).toBe('cancelled')
    expect(cancelActiveMock).not.toHaveBeenCalled()
    expect(activeRunId).toBe('run-1')
    expect(queueEvents.filter((e) => e.runKey === 'run-2').map((e) => e.action)).toEqual([
      'enqueued',
      'finished',
    ])
    hold.resolve({ state: 'completed', items: [] })
    await active
    expect(d.freeComfyMemory).toHaveBeenCalledTimes(1)
    expect(d.restartChatBackend).toHaveBeenCalledTimes(1)
  })

  it('serializes media requests, and waits for the GPU window before starting one', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalled())

    const firstBracket = deferred()
    const bracketStarted: string[] = []
    const request1 = runMediaRequest(
      async () => {
        bracketStarted.push('one')
        return (await firstBracket.promise) as never
      },
      { runKey: 'media-1' },
    )

    await new Promise((resolve) => setTimeout(resolve, 20))
    // The window is held for media — the bracket must not start.
    expect(bracketStarted).toEqual([])

    const secondBracket = deferred()
    const request2 = runMediaRequest(
      async () => {
        bracketStarted.push('two')
        return (await secondBracket.promise) as never
      },
      { runKey: 'media-2' },
    )

    hold.resolve({ state: 'completed', items: [] })
    await active
    // The window came back (release ran); the first bracket may start.
    await vi.waitFor(() => expect(bracketStarted).toEqual(['one']))

    firstBracket.resolve('done-one')
    expect(await request1).toBe('done-one')
    await vi.waitFor(() => expect(bracketStarted).toEqual(['one', 'two']))
    secondBracket.resolve('done-two')
    expect(await request2).toBe('done-two')
  })

  it('a media request aborted while waiting never runs', async () => {
    setOrchestratorDeps(deps())
    const controller = new AbortController()
    controller.abort()
    await expect(
      runMediaRequest(async () => 'ran', {
        runKey: 'media-1',
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow('Cancelled while waiting')
  })

  it('aborts a parked media request without waiting for the head', async () => {
    setOrchestratorDeps(deps())
    const first = deferred()
    const ran: string[] = []
    const request1 = runMediaRequest(
      async () => {
        ran.push('one')
        return (await first.promise) as never
      },
      { runKey: 'media-1' },
    )
    await vi.waitFor(() => expect(ran).toEqual(['one']))

    const controller = new AbortController()
    const request2 = runMediaRequest(
      async () => {
        ran.push('two')
        return 'nope'
      },
      { runKey: 'media-2', abortSignal: controller.signal },
    )
    expect(mediaRequestsQueued()).toBe(1)
    controller.abort()
    await expect(request2).rejects.toThrow('Cancelled while waiting')
    expect(mediaRequestsQueued()).toBe(0)
    expect(ran).toEqual(['one'])
    first.resolve('done')
    expect(await request1).toBe('done')
    expect(ran).toEqual(['one'])
  })

  it('fail-fast refuses a panel run while a local chat turn occupies the GPU', async () => {
    setOrchestratorDeps(deps())
    await submitTextRequest({ runId: 'turn-1', conversationKey: 'c1', needsGpu: true })
    expect(textRequestsOpen()).toBe(1)

    const refused = await submitArtifactRun(payload({ runId: 'panel-1' }))
    expect(refused.state).toBe('failed')
    expect(refused.error).toBe('A chat turn is already in progress')
    expect(startArtifactRunMock).not.toHaveBeenCalled()

    finishTextRequest('turn-1')
    expect(textRequestsOpen()).toBe(0)
    const hold = holdNextRun()
    const active = submitArtifactRun(payload({ runId: 'panel-2' }))
    await vi.waitFor(() => expect(activeRunId).toBe('panel-2'))
    hold.resolve({ state: 'completed', items: [] })
    expect((await active).state).toBe('completed')
  })

  it('cloud chat occupancy does not fail-fast a panel run', async () => {
    setOrchestratorDeps(deps())
    await submitTextRequest({ runId: 'cloud-1', conversationKey: 'c1', needsGpu: false })
    const hold = holdNextRun()
    const active = submitArtifactRun(payload({ runId: 'panel-1' }))
    await vi.waitFor(() => expect(activeRunId).toBe('panel-1'))
    hold.resolve({ state: 'completed', items: [] })
    expect((await active).state).toBe('completed')
    finishTextRequest('cloud-1')
  })

  it('nested queued media for the same conversation runs while text occupancy is live', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    await submitTextRequest({ runId: 'turn-1', conversationKey: 'c1', needsGpu: true })
    const hold = holdNextRun()
    const nested = submitArtifactRun(payload({ runId: 'nested-1', conversationKey: 'c1' }), {
      queue: 'queue',
    })
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalledTimes(1))
    expect(activeRunId).toBe('nested-1')
    expect(textRequestsOpen()).toBe(1)
    hold.resolve({ state: 'completed', items: [] })
    expect((await nested).state).toBe('completed')
    finishTextRequest('turn-1')
  })

  it('queued media for another conversation waits until unrelated text occupancy ends', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    await submitTextRequest({ runId: 'turn-1', conversationKey: 'c1', needsGpu: true })
    const hold = holdNextRun()
    const other = submitArtifactRun(payload({ runId: 'other-1', conversationKey: 'c2' }), {
      queue: 'queue',
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(d.stopChatForMedia).not.toHaveBeenCalled()
    expect(activeRunId).toBeNull()

    finishTextRequest('turn-1')
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalledTimes(1))
    expect(activeRunId).toBe('other-1')
    hold.resolve({ state: 'completed', items: [] })
    expect((await other).state).toBe('completed')
  })

  it('emits text queue events enqueued → started → finished', async () => {
    setOrchestratorDeps(deps())
    const admitted = submitTextRequest({ runId: 'turn-1', conversationKey: 'c1', needsGpu: true })
    await admitted
    expect(queueEvents.map((e) => `${e.kind}:${e.runKey}:${e.action}`)).toEqual([
      'text:turn-1:enqueued',
      'text:turn-1:started',
    ])
    finishTextRequest('turn-1')
    expect(queueEvents.at(-1)).toMatchObject({
      kind: 'text',
      runKey: 'turn-1',
      action: 'finished',
      conversationKey: 'c1',
    })
    expect(textRequestsOpen()).toBe(0)
  })

  it('a local text request waits for the GPU window and aborts without proceeding', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalled())

    const ac = new AbortController()
    const waiting = submitTextRequest(
      { runId: 'turn-1', conversationKey: 'c1', needsGpu: true },
      ac.signal,
    )
    await vi.waitFor(() =>
      expect(queueEvents.some((e) => e.kind === 'text' && e.action === 'enqueued')).toBe(true),
    )
    expect(queueEvents.some((e) => e.kind === 'text' && e.action === 'started')).toBe(false)
    ac.abort()
    await expect(waiting).rejects.toThrow('Cancelled while waiting for the chat GPU window.')
    expect(textRequestsOpen()).toBe(0)
    expect(queueEvents.filter((e) => e.kind === 'text').map((e) => e.action)).toEqual([
      'enqueued',
      'finished',
    ])

    hold.resolve({ state: 'completed', items: [] })
    await active
  })
})
