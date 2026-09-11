import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { MediaItem } from './imageGenerationPresets'
import { useImageGenerationPresets } from './imageGenerationPresets'
import { useActivities } from './activities'
import type { ToolAgentPhase } from '../agents/toolAgent'

// Live view of nested media specialist runs (agents/mediaAgent.ts), keyed by the
// delegating tool call id so both surfaces can render the same timeline while
// the parent tool call is still pending: Chat gets the id from the tool part,
// Agent Mode from the tool bridge.
//
// Only a UI mirror — nothing here feeds the model, and a missing run simply
// means "no live data" (e.g. after a reload), which the timeline handles by
// falling back to the step lines persisted in the tool output.

export type MediaRunStepState = 'running' | 'done' | 'failed'

export type MediaRunStep = {
  toolCallId: string
  toolName: string
  /** ComfyUI workflow (preset) the step runs, when the tool input names one. */
  workflow?: string
  prompt?: string
  state: MediaRunStepState
  /** Live status line, e.g. "Generating 12/20". */
  label: string
  /** 0..1 while ComfyUI reports determinate progress. */
  progress?: number
  /** Media produced by this step, filling in as items arrive. */
  media: MediaItem[]
  error?: string
  startedAt: number
}

export type MediaRun = {
  id: string
  request: string
  phase: ToolAgentPhase
  /** Streamed narration of the specialist (reasoning or plain text). */
  narration: string
  narrationStartedAt: number
  steps: MediaRunStep[]
  state: 'running' | 'done' | 'failed'
  startedAt: number
}

/** Keeps memory bounded — finished runs only matter until the page reloads. */
const RUN_LIMIT = 20

export const useMediaAgentRuns = defineStore('mediaAgentRuns', () => {
  const imageGeneration = useImageGenerationPresets()
  const activities = useActivities()

  const runs = ref<MediaRun[]>([])
  // Media items that already existed when the current step began, so a step
  // only claims what it produced itself (the generation store is global).
  let stepBaselineIds = new Set<string>()

  function run(runId: string | undefined): MediaRun | null {
    if (!runId) return null
    return runs.value.find((item) => item.id === runId) ?? null
  }

  /** Status line of the step in flight — "what is this run doing right now". */
  function activeStepLabel(runId: string | undefined): string | undefined {
    return run(runId)?.steps.findLast((step) => step.state === 'running')?.label
  }

  function patchRun(runId: string, patch: (current: MediaRun) => MediaRun): void {
    runs.value = runs.value.map((item) => (item.id === runId ? patch(item) : item))
  }

  function patchActiveStep(runId: string, patch: (step: MediaRunStep) => MediaRunStep): void {
    patchRun(runId, (current) => {
      const index = current.steps.findLastIndex((step) => step.state === 'running')
      if (index === -1) return current
      const steps = [...current.steps]
      steps[index] = patch(steps[index])
      return { ...current, steps }
    })
  }

  function beginRun(runId: string, request: string): void {
    const now = Date.now()
    const fresh: MediaRun = {
      id: runId,
      request,
      phase: 'planning',
      narration: '',
      narrationStartedAt: now,
      steps: [],
      state: 'running',
      startedAt: now,
    }
    runs.value = [...runs.value.filter((item) => item.id !== runId), fresh].slice(-RUN_LIMIT)
  }

  function setPhase(runId: string, phase: ToolAgentPhase): void {
    patchRun(runId, (current) =>
      current.phase === phase
        ? current
        : {
            ...current,
            phase,
            // Each planning stretch is its own narration block, so the elapsed
            // timer in the UI restarts instead of counting the whole run.
            ...(phase === 'planning' ? { narration: '', narrationStartedAt: Date.now() } : {}),
          },
    )
  }

  function appendNarration(runId: string, text: string): void {
    patchRun(runId, (current) => ({ ...current, narration: current.narration + text }))
  }

  function beginStep(
    runId: string,
    step: {
      toolCallId: string
      toolName: string
      workflow?: string
      prompt?: string
      label: string
    },
  ): void {
    stepBaselineIds = new Set(imageGeneration.generatedImages.map((item) => item.id))
    patchRun(runId, (current) => ({
      ...current,
      phase: 'running-tool',
      steps: [...current.steps, { ...step, state: 'running', media: [], startedAt: Date.now() }],
    }))
  }

  function endStep(
    runId: string,
    result: { toolCallId: string; media?: MediaItem[]; error?: string },
  ): void {
    patchRun(runId, (current) => ({
      ...current,
      steps: current.steps.map((step) =>
        step.toolCallId === result.toolCallId && step.state === 'running'
          ? {
              ...step,
              state: result.error ? 'failed' : 'done',
              // Prefer the tool's own result over what was mirrored live.
              media: result.media?.length ? result.media : step.media,
              error: result.error,
              progress: undefined,
            }
          : step,
      ),
    }))
  }

  function endRun(runId: string, state: 'done' | 'failed'): void {
    patchRun(runId, (current) => ({
      ...current,
      state,
      phase: 'planning',
      narration: '',
      // A run can only end while its steps are settled; anything still marked
      // running died with the run.
      steps: current.steps.map((step) =>
        step.state === 'running' ? { ...step, state: 'failed' as const } : step,
      ),
    }))
  }

  // Mirror the global generation state onto the step that is currently running.
  // The activity carries ComfyUI's own label and determinate percentage
  // (comfyUiPresets writes value/max there), so nothing needs re-parsing.
  watch(
    () => [activities.imageGenActivity, imageGeneration.generatedImages] as const,
    ([activity, generated]) => {
      const active = runs.value.find((item) => item.state === 'running')
      if (!active) return
      const media = generated
        .filter((item) => !stepBaselineIds.has(item.id))
        .filter((item) => item.state !== 'stopped' && item.state !== 'failed')
        .filter((item) => {
          if (item.type === 'image') return item.imageUrl.trim() !== ''
          if (item.type === 'video') return item.videoUrl.trim() !== ''
          return item.model3dUrl.trim() !== ''
        })
        .map((item) => ({ ...item }))
      patchActiveStep(active.id, (step) => ({
        ...step,
        label: activity?.label ?? step.label,
        progress: activity?.progress,
        media,
      }))
    },
    { deep: true },
  )

  return {
    runs,
    run,
    activeStepLabel,
    beginRun,
    setPhase,
    appendNarration,
    beginStep,
    endStep,
    endRun,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMediaAgentRuns, import.meta.hot))
}
