import type {
  ArtifactPhase,
  ArtifactRunOwner,
  ArtifactRunSnapshot,
  KernelArtifactDoneEvent,
  KernelArtifactItemEvent,
  KernelArtifactPhaseEvent,
} from '@/types/kernelEvents'
import type { MediaItem } from '@/types/mediaItem'

// Renderer projection of artifact runs, keyed by run id. Every run carries the
// owner main stamped on it, so a tool card finds its own runs by tool call id
// instead of guessing from the shared Image Gen state.

export type ArtifactRunView = {
  runId: string
  owner?: ArtifactRunOwner
  phase: ArtifactPhase
  progress?: { current: number; max: number }
  error?: string
  items: MediaItem[]
  /** Order the projection first saw the run in — keeps a tool's media in call order. */
  order: number
}

export type ArtifactRunsState = {
  runs: Record<string, ArtifactRunView>
  nextOrder: number
}

export type ArtifactRunEvent =
  KernelArtifactPhaseEvent | KernelArtifactItemEvent | KernelArtifactDoneEvent

const TERMINAL_PHASES: ReadonlySet<ArtifactPhase> = new Set(['completed', 'failed', 'cancelled'])

/** Settled runs kept for cards still on screen; older ones fall back to the tool output. */
export const SETTLED_RUN_LIMIT = 50

export function emptyArtifactRuns(): ArtifactRunsState {
  return { runs: {}, nextOrder: 0 }
}

export function isTerminalPhase(phase: ArtifactPhase): boolean {
  return TERMINAL_PHASES.has(phase)
}

function upsert(
  state: ArtifactRunsState,
  runId: string,
  owner: ArtifactRunOwner | undefined,
  patch: (run: ArtifactRunView) => ArtifactRunView,
): ArtifactRunsState {
  const existing = state.runs[runId]
  const base: ArtifactRunView = existing ?? {
    runId,
    owner,
    phase: 'queued',
    items: [],
    order: state.nextOrder,
  }
  const next = patch({ ...base, owner: base.owner ?? owner })
  return {
    runs: { ...state.runs, [runId]: next },
    nextOrder: existing ? state.nextOrder : state.nextOrder + 1,
  }
}

function upsertItem(items: MediaItem[], item: MediaItem): MediaItem[] {
  const index = items.findIndex((existing) => existing.id === item.id)
  if (index === -1) return [...items, item]
  const next = [...items]
  next[index] = item
  return next
}

function prune(state: ArtifactRunsState): ArtifactRunsState {
  const settled = Object.values(state.runs)
    .filter((run) => isTerminalPhase(run.phase))
    .sort((a, b) => a.order - b.order)
  if (settled.length <= SETTLED_RUN_LIMIT) return state
  const runs = { ...state.runs }
  for (const run of settled.slice(0, settled.length - SETTLED_RUN_LIMIT)) delete runs[run.runId]
  return { ...state, runs }
}

export function applyArtifactEvent(
  state: ArtifactRunsState,
  event: ArtifactRunEvent,
): ArtifactRunsState {
  switch (event.type) {
    case 'artifact-phase':
      return prune(
        upsert(state, event.runId, event.owner, (run) => ({
          ...run,
          phase: event.phase,
          progress: event.phase === 'running' ? (event.progress ?? run.progress) : undefined,
          error: event.error ?? run.error,
        })),
      )
    case 'artifact-item':
      return upsert(state, event.runId, event.owner, (run) => ({
        ...run,
        items: upsertItem(run.items, event.item),
      }))
    case 'artifact-done': {
      const phase: ArtifactPhase = event.state
      return prune(
        upsert(state, event.runId, event.owner, (run) => ({
          ...run,
          phase,
          progress: undefined,
          error: event.error ?? run.error,
        })),
      )
    }
  }
}

/** Installs the run main is executing at snapshot time (a reconnecting renderer). */
export function applyArtifactSnapshot(
  state: ArtifactRunsState,
  snapshot: ArtifactRunSnapshot | null,
): ArtifactRunsState {
  if (!snapshot) return state
  return upsert(state, snapshot.runId, snapshot.owner, (run) => ({
    ...run,
    phase: snapshot.phase,
    progress: snapshot.progress,
    error: snapshot.error ?? undefined,
    items: snapshot.items.reduce(upsertItem, run.items),
  }))
}

/** Runs a tool call submitted itself, or that a specialist ran on its behalf. */
export function runsOwnedBy(state: ArtifactRunsState, toolCallId: string): ArtifactRunView[] {
  return Object.values(state.runs)
    .filter(
      (run) =>
        run.owner?.kind === 'tool' &&
        (run.owner.toolCallId === toolCallId || run.owner.parentToolCallId === toolCallId),
    )
    .sort((a, b) => a.order - b.order)
}

export type ToolMediaView = {
  items: MediaItem[]
  processing: boolean
  /** Phase of the run in flight; a running one wins over ones still waiting. */
  phase?: ArtifactPhase
  progress?: { current: number; max: number }
}

function hasMedia(item: MediaItem): boolean {
  if (item.type === 'image') return !!item.imageUrl
  if (item.type === 'video') return !!item.videoUrl
  return !!item.model3dUrl
}

export function toolMediaView(runs: ArtifactRunView[]): ToolMediaView {
  const open = runs.filter((run) => !isTerminalPhase(run.phase))
  const current = open.find((run) => run.phase !== 'queued') ?? open[0]
  return {
    items: runs
      .flatMap((run) => run.items)
      .filter((item) => item.state !== 'failed' && item.state !== 'stopped' && hasMedia(item)),
    processing: open.length > 0,
    phase: current?.phase,
    progress: current?.progress,
  }
}

/** The i18n state; the keys read here all exist in `en-US.json`. */
export type ArtifactPhaseLabels = Record<string, string>

/** User-facing status line for a phase — every non-terminal phase has its own. */
export function artifactPhaseLabel(
  phase: ArtifactPhase | undefined,
  progress: { current: number; max: number } | undefined,
  labels: ArtifactPhaseLabels,
): string | undefined {
  switch (phase) {
    case 'queued':
      return labels.COM_GENERATION_QUEUED
    case 'preparing-backend':
      return labels.COM_STARTING_BACKEND
    case 'installing-components':
      return labels.COM_INSTALL_WORKFLOW_COMPONENTS
    case 'loading-components':
      return labels.COM_LOADING_WORKFLOW_COMPONENTS
    case 'loading-model':
      return labels.COM_LOADING_MODEL
    case 'running':
      return progress
        ? `${labels.COM_GENERATING} ${progress.current}/${progress.max}`
        : labels.COM_GENERATING
    default:
      return undefined
  }
}
