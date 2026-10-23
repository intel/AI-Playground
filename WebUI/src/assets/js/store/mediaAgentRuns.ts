import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'
import type { MediaItem } from './imageGenerationPresets'
import { useArtifactRuns } from './artifactRuns'
import type { ToolAgentPhase } from '@/lib/toolAgent'

// Live view of nested media specialist runs (agents/mediaAgent.ts), keyed by the
// delegating tool call id so both surfaces can render the same timeline while
// the parent tool call is still pending: Chat gets the id from the tool part,
// Agent Mode from the tool bridge.
//
// Only a UI mirror — nothing here feeds the model, and a missing run simply
// means "no live data" (e.g. after a reload), which the timeline handles by
// falling back to the step lines persisted in the tool output. A step's live
// status and media come from the artifact runs it owns (artifactRuns store).

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
  const artifactRuns = useArtifactRuns()

  const runs = ref<MediaRun[]>([])

  function withLiveProgress(step: MediaRunStep): MediaRunStep {
    const live = artifactRuns.viewFor(step.toolCallId)
    if (step.state !== 'running') {
      return step.media.length || !live.items.length ? step : { ...step, media: live.items }
    }
    const { progress } = live
    return {
      ...step,
      label: artifactRuns.labelFor(live) ?? step.label,
      progress: progress && progress.max > 0 ? progress.current / progress.max : undefined,
      media: live.items,
    }
  }

  function run(runId: string | undefined): MediaRun | null {
    if (!runId) return null
    const found = runs.value.find((item) => item.id === runId)
    return found ? { ...found, steps: found.steps.map(withLiveProgress) } : null
  }

  /** Status line of the step in flight — "what is this run doing right now". */
  function activeStepLabel(runId: string | undefined): string | undefined {
    return run(runId)?.steps.findLast((step) => step.state === 'running')?.label
  }

  function patchRun(runId: string, patch: (current: MediaRun) => MediaRun): void {
    runs.value = runs.value.map((item) => (item.id === runId ? patch(item) : item))
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
              media: result.media ?? [],
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
