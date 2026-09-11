import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { MediaItem } from '@/assets/js/store/imageGenerationPresets'

// The run store mirrors the (global) generation state onto the step that is
// currently running, so these tests stub the two stores it reads from and drive
// them by hand. Only the reducer behaviour matters here: per-step attribution of
// produced media, and that a run can never be left spinning.

const generatedImages = ref<MediaItem[]>([])
const imageGenActivity = ref<{ label: string; progress?: number } | null>(null)

vi.mock('@/assets/js/store/imageGenerationPresets', () => ({
  useImageGenerationPresets: () => ({
    get generatedImages() {
      return generatedImages.value
    },
  }),
}))

vi.mock('@/assets/js/store/activities', () => ({
  useActivities: () => ({
    get imageGenActivity() {
      return imageGenActivity.value
    },
  }),
}))

const { useMediaAgentRuns } = await import('@/assets/js/store/mediaAgentRuns')

function image(id: string): MediaItem {
  return {
    id,
    type: 'image',
    state: 'done',
    mode: 'imageGen',
    settings: {},
    imageUrl: `aipg-media://${id}.png`,
  } as MediaItem
}

/** The store mirrors inside a watcher, so let Vue flush it. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('mediaAgentRuns', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    generatedImages.value = []
    imageGenActivity.value = null
  })

  it('attributes only media produced after a step started to that step', async () => {
    const runs = useMediaAgentRuns()
    // A previous conversation already left an image in the shared store.
    generatedImages.value = [image('old')]

    runs.beginRun('call-1', 'a castle, then a 3D model')
    runs.beginStep('call-1', { toolCallId: 't1', toolName: 'comfyUI', label: 'Starting…' })
    generatedImages.value = [image('old'), image('new')]
    await flush()

    expect(runs.run('call-1')?.steps[0].media.map((item) => item.id)).toEqual(['new'])
  })

  it('carries the live label and progress of the running step only', async () => {
    const runs = useMediaAgentRuns()
    runs.beginRun('call-1', 'a castle')
    runs.beginStep('call-1', { toolCallId: 't1', toolName: 'comfyUI', label: 'Starting…' })
    imageGenActivity.value = { label: 'Generating 5/20', progress: 0.25 }
    await flush()

    expect(runs.run('call-1')?.steps[0]).toMatchObject({
      label: 'Generating 5/20',
      progress: 0.25,
    })

    runs.endStep('call-1', { toolCallId: 't1', media: [image('done')] })
    expect(runs.run('call-1')?.steps[0]).toMatchObject({ state: 'done', progress: undefined })

    // A settled step must not keep absorbing global progress updates.
    imageGenActivity.value = { label: 'Generating 19/20', progress: 0.95 }
    await flush()
    expect(runs.run('call-1')?.steps[0].label).toBe('Generating 5/20')
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
