import { describe, expect, it } from 'vitest'
import {
  applyArtifactEvent,
  applyArtifactSnapshot,
  artifactPhaseLabel,
  emptyArtifactRuns,
  runsOwnedBy,
  SETTLED_RUN_LIMIT,
  toolMediaView,
  type ArtifactRunEvent,
  type ArtifactRunsState,
} from '@/lib/artifactRunProjection'
import type { ArtifactRunOwner } from '@/types/kernelEvents'
import type { MediaItem } from '@/types/mediaItem'

const PLACEHOLDER = 'data:image/svg+xml,placeholder'

function image(id: string, state: MediaItem['state'], imageUrl = PLACEHOLDER): MediaItem {
  return { id, type: 'image', state, mode: 'imageGen', settings: {}, imageUrl } as MediaItem
}

function tool(toolCallId: string, parentToolCallId?: string): ArtifactRunOwner {
  return { kind: 'tool', toolCallId, ...(parentToolCallId ? { parentToolCallId } : {}) }
}

function apply(state: ArtifactRunsState, ...events: ArtifactRunEvent[]): ArtifactRunsState {
  return events.reduce(applyArtifactEvent, state)
}

const labels = {
  COM_GENERATION_QUEUED: 'Queued',
  COM_STARTING_BACKEND: 'Starting image backend',
  COM_INSTALL_WORKFLOW_COMPONENTS: 'Installing',
  COM_LOADING_WORKFLOW_COMPONENTS: 'Loading components',
  COM_LOADING_MODEL: 'Loading AI Model',
  COM_GENERATING: 'Generating',
}

describe('artifactRunProjection', () => {
  it('keeps two interleaved runs on their own tool cards', () => {
    const a = tool('call-a')
    const b = tool('call-b')
    const state = apply(
      emptyArtifactRuns(),
      { type: 'artifact-phase', runId: 'run-a', owner: a, phase: 'running' },
      { type: 'artifact-phase', runId: 'run-b', owner: b, phase: 'queued' },
      { type: 'artifact-item', runId: 'run-a', owner: a, item: image('a1', 'generating') },
      { type: 'artifact-item', runId: 'run-b', owner: b, item: image('b1', 'queued') },
      {
        type: 'artifact-phase',
        runId: 'run-a',
        owner: a,
        phase: 'running',
        progress: { current: 5, max: 6 },
      },
    )

    const viewA = toolMediaView(runsOwnedBy(state, 'call-a'))
    const viewB = toolMediaView(runsOwnedBy(state, 'call-b'))
    expect(viewA.items.map((item) => item.id)).toEqual(['a1'])
    expect(viewA.phase).toBe('running')
    expect(viewA.progress).toEqual({ current: 5, max: 6 })
    expect(viewB.items.map((item) => item.id)).toEqual(['b1'])
    expect(viewB.phase).toBe('queued')
  })

  it('goes from queued through running to settled', () => {
    const owner = tool('call-1')
    let state = apply(emptyArtifactRuns(), {
      type: 'artifact-phase',
      runId: 'run-1',
      owner,
      phase: 'queued',
    })
    expect(toolMediaView(runsOwnedBy(state, 'call-1'))).toMatchObject({
      processing: true,
      phase: 'queued',
    })

    state = apply(
      state,
      { type: 'artifact-phase', runId: 'run-1', owner, phase: 'loading-model' },
      { type: 'artifact-item', runId: 'run-1', owner, item: image('i1', 'done', 'aipg-media://x') },
      { type: 'artifact-phase', runId: 'run-1', owner, phase: 'completed' },
      { type: 'artifact-done', runId: 'run-1', owner, state: 'completed' },
    )
    const view = toolMediaView(runsOwnedBy(state, 'call-1'))
    expect(view.processing).toBe(false)
    expect(view.phase).toBeUndefined()
    expect(view.items.map((item) => item.id)).toEqual(['i1'])
  })

  it('aggregates specialist runs under the delegating media call, in call order', () => {
    const state = apply(
      emptyArtifactRuns(),
      {
        type: 'artifact-phase',
        runId: 'run-1',
        owner: tool('inner-1', 'media-1'),
        phase: 'completed',
      },
      {
        type: 'artifact-item',
        runId: 'run-1',
        owner: tool('inner-1', 'media-1'),
        item: image('first', 'done', 'aipg-media://1'),
      },
      {
        type: 'artifact-phase',
        runId: 'run-2',
        owner: tool('inner-2', 'media-1'),
        phase: 'running',
      },
      {
        type: 'artifact-item',
        runId: 'run-2',
        owner: tool('inner-2', 'media-1'),
        item: image('second', 'generating'),
      },
    )

    const parent = toolMediaView(runsOwnedBy(state, 'media-1'))
    expect(parent.items.map((item) => item.id)).toEqual(['first', 'second'])
    expect(parent.phase).toBe('running')
    expect(runsOwnedBy(state, 'inner-1').map((run) => run.runId)).toEqual(['run-1'])
  })

  it('prefers the run that is executing over ones still waiting', () => {
    const state = apply(
      emptyArtifactRuns(),
      { type: 'artifact-phase', runId: 'run-1', owner: tool('call-1'), phase: 'queued' },
      { type: 'artifact-phase', runId: 'run-2', owner: tool('call-1'), phase: 'running' },
    )
    expect(toolMediaView(runsOwnedBy(state, 'call-1')).phase).toBe('running')
  })

  it('never lists panel runs or failed and stopped items on a tool card', () => {
    const owner = tool('call-1')
    const state = apply(
      emptyArtifactRuns(),
      { type: 'artifact-phase', runId: 'panel', owner: { kind: 'panel' }, phase: 'running' },
      { type: 'artifact-item', runId: 'run-1', owner, item: image('failed', 'failed') },
      { type: 'artifact-item', runId: 'run-1', owner, item: image('stopped', 'stopped') },
    )
    expect(runsOwnedBy(state, 'call-1').map((run) => run.runId)).toEqual(['run-1'])
    expect(toolMediaView(runsOwnedBy(state, 'call-1')).items).toEqual([])
  })

  it('hydrates the executing run from a snapshot', () => {
    const state = applyArtifactSnapshot(emptyArtifactRuns(), {
      runId: 'run-1',
      mode: 'imageGen',
      workflow: 'Draft Image',
      owner: tool('call-1'),
      phase: 'running',
      progress: { current: 2, max: 4 },
      items: [image('i1', 'generating')],
    })
    expect(toolMediaView(runsOwnedBy(state, 'call-1'))).toMatchObject({
      processing: true,
      phase: 'running',
      progress: { current: 2, max: 4 },
    })
  })

  it('drops the oldest settled runs past the limit', () => {
    let state = emptyArtifactRuns()
    for (let i = 0; i <= SETTLED_RUN_LIMIT; i += 1) {
      state = apply(state, {
        type: 'artifact-done',
        runId: `run-${i}`,
        owner: tool(`call-${i}`),
        state: 'completed',
      })
    }
    expect(Object.keys(state.runs)).toHaveLength(SETTLED_RUN_LIMIT)
    expect(state.runs['run-0']).toBeUndefined()
  })

  it('labels every non-terminal phase', () => {
    expect(artifactPhaseLabel('queued', undefined, labels)).toBe('Queued')
    expect(artifactPhaseLabel('preparing-backend', undefined, labels)).toBe(
      'Starting image backend',
    )
    expect(artifactPhaseLabel('running', { current: 5, max: 6 }, labels)).toBe('Generating 5/6')
    expect(artifactPhaseLabel('running', undefined, labels)).toBe('Generating')
    expect(artifactPhaseLabel('completed', undefined, labels)).toBeUndefined()
  })
})
