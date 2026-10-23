import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { MediaItem } from '@/assets/js/store/imageGenerationPresets'
import type { ArtifactRunEvent } from '@/lib/artifactRunProjection'

// The run store takes a step's live status and media from the artifact runs that
// step owns, so these tests drive the real artifactRuns projection with
// owner-stamped kernel events — exactly what main sends.

const kernelListeners: Array<(event: unknown) => void> = []
vi.stubGlobal('window', {
  electronAPI: {
    onKernelEvent: (cb: (event: unknown) => void) => {
      kernelListeners.push(cb)
      return () => {
        const index = kernelListeners.indexOf(cb)
        if (index >= 0) kernelListeners.splice(index, 1)
      }
    },
    getKernelSnapshot: async () => ({
      scope: { kind: 'global' },
      sequence: 0,
      state: {
        services: [],
        activeTurn: null,
        activeArtifactRun: null,
        chatTurns: [],
        activities: [],
        inferenceProfile: null,
      },
    }),
  },
})

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({
    state: { COM_GENERATING: 'Generating', COM_GENERATION_QUEUED: 'Queued' },
  }),
}))

const { useMediaAgentRuns } = await import('@/assets/js/store/mediaAgentRuns')

function image(id: string, state: MediaItem['state'] = 'done'): MediaItem {
  return {
    id,
    type: 'image',
    state,
    mode: 'imageGen',
    settings: {},
    imageUrl: `aipg-media://${id}.png`,
  } as MediaItem
}

let seq = 0
async function send(...events: ArtifactRunEvent[]) {
  await vi.waitFor(() => expect(kernelListeners.length).toBeGreaterThan(0))
  for (const event of events) {
    seq += 1
    for (const listener of kernelListeners) {
      listener({ ...event, seq, scope: { kind: 'run', runId: event.runId } })
    }
  }
}

const inner = (toolCallId: string) => ({
  kind: 'tool' as const,
  toolCallId,
  parentToolCallId: 'call-1',
})

describe('mediaAgentRuns', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    kernelListeners.length = 0
  })

  it('attributes media to the step whose tool call owns the run', async () => {
    const runs = useMediaAgentRuns()
    runs.beginRun('call-1', 'a castle, then a 3D model')
    runs.beginStep('call-1', { toolCallId: 't1', toolName: 'comfyUI', label: 'Starting…' })
    await send(
      // Another chat's run is generating at the same time.
      {
        type: 'artifact-item',
        runId: 'other',
        owner: { kind: 'tool', toolCallId: 'elsewhere' },
        item: image('other'),
      },
      { type: 'artifact-item', runId: 'run-1', owner: inner('t1'), item: image('new') },
    )

    expect(runs.run('call-1')?.steps[0].media.map((item) => item.id)).toEqual(['new'])
  })

  it('carries the live label and progress of the running step only', async () => {
    const runs = useMediaAgentRuns()
    runs.beginRun('call-1', 'a castle')
    runs.beginStep('call-1', { toolCallId: 't1', toolName: 'comfyUI', label: 'Starting…' })
    await send({
      type: 'artifact-phase',
      runId: 'run-1',
      owner: inner('t1'),
      phase: 'running',
      progress: { current: 5, max: 20 },
    })

    expect(runs.run('call-1')?.steps[0]).toMatchObject({
      label: 'Generating 5/20',
      progress: 0.25,
    })

    runs.endStep('call-1', { toolCallId: 't1', media: [image('done')] })
    expect(runs.run('call-1')?.steps[0]).toMatchObject({ state: 'done', progress: undefined })

    // A settled step must not keep absorbing progress updates.
    await send({
      type: 'artifact-phase',
      runId: 'run-1',
      owner: inner('t1'),
      phase: 'running',
      progress: { current: 19, max: 20 },
    })
    expect(runs.run('call-1')?.steps[0].label).toBe('Starting…')
  })

  it('shows a waiting step as queued rather than as preparing', async () => {
    const runs = useMediaAgentRuns()
    runs.beginRun('call-1', 'a castle')
    runs.beginStep('call-1', { toolCallId: 't1', toolName: 'comfyUI', label: 'Starting…' })
    await send({ type: 'artifact-phase', runId: 'run-1', owner: inner('t1'), phase: 'queued' })

    expect(runs.activeStepLabel('call-1')).toBe('Queued')
  })

  it('marks a step failed when the tool reports an error', () => {
    const runs = useMediaAgentRuns()
    runs.beginRun('call-1', 'a castle')
    runs.beginStep('call-1', { toolCallId: 't1', toolName: 'comfyUI', label: 'Starting…' })
    runs.endStep('call-1', { toolCallId: 't1', error: 'workflow exploded' })

    expect(runs.run('call-1')?.steps[0]).toMatchObject({
      state: 'failed',
      error: 'workflow exploded',
    })
  })

  it('settles a run that ended while a step was still running', () => {
    const runs = useMediaAgentRuns()
    runs.beginRun('call-1', 'a castle')
    runs.beginStep('call-1', { toolCallId: 't1', toolName: 'comfyUI', label: 'Starting…' })
    // e.g. the turn was aborted mid-generation.
    runs.endRun('call-1', 'failed')

    const run = runs.run('call-1')
    expect(run?.state).toBe('failed')
    expect(run?.steps.every((step) => step.state !== 'running')).toBe(true)
  })

  it('restarts the narration block on each planning phase', () => {
    const runs = useMediaAgentRuns()
    runs.beginRun('call-1', 'a castle')
    runs.appendNarration('call-1', 'Picking a workflow')
    expect(runs.run('call-1')?.narration).toBe('Picking a workflow')

    runs.setPhase('call-1', 'running-tool')
    runs.setPhase('call-1', 'planning')
    expect(runs.run('call-1')?.narration).toBe('')
  })

  it('has no live run for an unknown tool call, so the UI can fall back', () => {
    expect(useMediaAgentRuns().run('never-started')).toBeNull()
    expect(useMediaAgentRuns().run(undefined)).toBeNull()
  })
})
