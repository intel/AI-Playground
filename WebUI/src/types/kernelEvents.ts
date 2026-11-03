// Shared kernel event vocabulary (docs/architecture-target.md §4.6). Imported
// by the Electron main process (electron/kernel/kernelBus.ts) and the renderer
// projection (src/assets/js/projection/kernelProjection.ts). Main stamps
// `scope` and `seq`; the renderer's listener-first handshake installs a
// snapshot at sequence N and applies only events with a greater sequence.

import type { UIMessageChunk } from 'ai'
import type { MediaItem } from './mediaItem'
import type { ActivityCategory, ActivityScope, ActivityState } from '@/assets/js/activities/types'
import type { SerializedAppError } from '@/assets/js/errors/types'
import type { SessionDocument, SessionTurns } from './sessionIpc'

export type KernelEventScope =
  { kind: 'global' } | { kind: 'chat'; conversationKey: string } | { kind: 'run'; runId: string }

/** One stream, one sequence: ordering across scopes is guaranteed too. */
export type KernelEventEnvelope = {
  scope: KernelEventScope
  seq: number
}

/** Backend service status. `info` is an `ApiServiceInformation` payload. */
export type KernelServiceEvent = {
  type: 'service'
  info: unknown
}

/** A running agent turn's translated UI message chunk. */
export type KernelAgentChunkEvent = {
  type: 'agent-chunk'
  sessionId: string
  turnId: string
  chunk: unknown
}

/** Streaming text output of one running tool, under its tool card. */
export type KernelAgentToolProgressEvent = {
  type: 'agent-tool-progress'
  sessionId: string
  turnId: string
  toolCallId: string
  toolName: string
  text: string
}

/** An image a tool produced, shown under that tool's card. */
export type KernelAgentToolImageEvent = {
  type: 'agent-tool-image'
  sessionId: string
  turnId: string
  toolCallId: string
  dataUri: string
  label: string
}

/** The turn settled (success, error or abort); its stream can close. */
/** The turn moved within the Turn Queue (queued → running when it takes the place). */
export type KernelAgentTurnStateEvent = {
  type: 'agent-turn-state'
  sessionId: string
  turnId: string
  state: AgentTurnState
  /** What the user is asked; only while `paused`. */
  pauseReason?: PauseReason
}

export type KernelAgentTurnDoneEvent = {
  type: 'agent-turn-done'
  sessionId: string
  turnId: string
}

// ── Artifact (media generation) events, docs/architecture-target.md §4.1 ──────
//
// The artifact runner in main owns the run lifecycle; the renderer's
// imageGenerationPresets store is a projection of these events.

/**
 * The run-level phase vocabulary (§4.1). These replace — rather than discard —
 * the renderer's `GenerateState`; the projection maps them onto the legacy
 * UI states so every consumer component keeps working.
 */
export type ArtifactPhase =
  | 'queued'
  | 'preparing-backend'
  | 'installing-components'
  | 'loading-components'
  | 'loading-model'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

/**
 * Who a run's progress belongs to. `panel` is the Image Gen / Edit / Video
 * panel (and Home Agent `/imgGen`); `tool` is the tool call that submitted it,
 * with `parentToolCallId` naming the delegating `media` call for specialist runs.
 */
export type ArtifactRunOwner =
  { kind: 'panel' } | { kind: 'tool'; toolCallId: string; parentToolCallId?: string }

/** Stamped on every artifact event by the runner, straight from the run's payload. */
export type ArtifactRunTag = {
  runId: string
  /** Decides gallery persistence: renderer-origin runs are saved as media records. */
  origin?: 'renderer' | 'agent'
  /** Decides which surface renders the run's progress. */
  owner?: ArtifactRunOwner
}

/** Run-level phase transition for an artifact run (queued, executing or settled). */
export type KernelArtifactPhaseEvent = ArtifactRunTag & {
  type: 'artifact-phase'
  phase: ArtifactPhase
  /** Execution progress for the `running` phase ("step 3 of 20"). */
  progress?: { current: number; max: number }
  /** Failure text for the `failed` phase. */
  error?: string
}

/**
 * One tracked media item of the active run: registration, a state/output
 * change or a terminal settle. `item` is the full `MediaItem` at its new state.
 */
export type KernelArtifactItemEvent = ArtifactRunTag & {
  type: 'artifact-item'
  item: MediaItem
}

/**
 * The run settled. Items already streamed via `artifact-item` (and are on the
 * snapshot), so this carries only the outcome and the failure text.
 */
export type KernelArtifactDoneEvent = ArtifactRunTag & {
  type: 'artifact-done'
  state: 'completed' | 'failed' | 'cancelled'
  error?: string
}

// ── Chat turn events, docs/architecture-target.md §4.6 / §7 ─────────────────
//
// The chat turn engine in main owns the AI SDK call; the renderer's Chat
// consumes these chunks through its transport. Adjacent text/reasoning deltas
// are coalesced at the bus (§4.6 "Streaming across IPC"); every semantic chunk
// flushes them first, so the scoped sequence stays meaningful.

/** One UIMessageChunk of a chat turn main is streaming. */
export type KernelChatChunkEvent = {
  type: 'chat-chunk'
  conversationKey: string
  turnId: string
  chunk: UIMessageChunk
}

/** The turn settled (success, error or abort); its stream can close. */
export type KernelChatTurnDoneEvent = {
  type: 'chat-turn-done'
  conversationKey: string
  turnId: string
}

/** RAG sources for the turn, emitted after retrieval and before the first token. */
export type KernelChatRagEvent = {
  type: 'chat-rag'
  conversationKey: string
  turnId: string
  sourceText: string | null
}

/**
 * Live progress of a nested media-specialist run (one per `media` tool call).
 * Transient timeline data — not part of any snapshot; a renderer that reloads
 * mid-run loses the timeline but still receives the tool's result.
 */
export type KernelMediaAgentEvent = {
  type: 'media-agent-event'
  runKey: string
  event:
    | { type: 'phase'; phase: 'planning' | 'running-tool' }
    | { type: 'narration-delta'; kind: 'reasoning' | 'text'; text: string }
    | { type: 'tool-start'; toolCallId: string; toolName: string; input: unknown }
    | { type: 'tool-finish'; toolCallId: string; output: unknown; error?: string }
}

/**
 * What a Turn Queue member is: an agent turn, a Chat / Home Agent turn, a title
 * summary, or a panel / Home Agent media run.
 */
export type TurnWork = 'agent' | 'chat' | 'summary' | 'generation'

/**
 * One queue entry's lifecycle on the orchestrator's typed queue (steps 7 + 10).
 * Transient like media progress — only an agent turn's Turn Queue position is
 * snapshotted (on its `AgentTurnSnapshot`). `text` is a chat or agent turn's
 * occupancy (not an artifact); nested media for that conversation stays `queue`.
 */
export type KernelQueueEvent = {
  type: 'queue-event'
  runKey: string
  kind: 'artifact' | 'media-request' | 'text'
  /**
   * `moved`: a waiting Turn Queue member's position changed (one ahead left, or a
   * paused member cut in at the front). `yielded`: a paused member gave up its
   * place; `reclaimed`: it holds the place again.
   */
  action: 'enqueued' | 'moved' | 'started' | 'finished' | 'yielded' | 'reclaimed'
  /** Entries still waiting after this one. */
  queueDepth: number
  /** 1-based place among the Turn Queue members still waiting; absent once it holds the place. */
  position?: number
  work?: TurnWork
  /** While a Turn Queue member waits: the kind of work holding the place. */
  holder?: TurnWork
  origin?: 'renderer' | 'agent'
  /** Present for chat-scoped work — lets the projection relabel the tool activity. */
  conversationKey?: string
  /** The renderer activity id the tool began for this work, when it has one. */
  activityId?: string
}

// ── Ledger events (docs/architecture-target.md §4.6, step 14) ───────────────

/** One long-running step main is tracking, projected onto the activities sink. */
export type KernelActivity = {
  id: string
  category: ActivityCategory
  label: string
  detail?: string
  progress?: number
  scope: ActivityScope
  state: ActivityState
  parentId?: string
}

export type KernelActivityEvent = {
  type: 'activity'
  action: 'begin' | 'update' | 'end'
  activity: KernelActivity
}

export type KernelErrorEvent = {
  type: 'error'
  error: SerializedAppError
}

export type KernelStoredKind = 'conversation' | 'session' | 'media' | 'grants' | 'inference-profile'

export type KernelStoredEvent = {
  type: 'stored'
  kind: KernelStoredKind
  id?: string
  /** Present when `kind` is `inference-profile`. */
  inferenceProfile?: KernelInferenceProfile | null
}

/** A Session's `session.json` changed in main (a turn settled into it): its row and timeline. */
export type KernelSessionChangedEvent = {
  type: 'session-changed'
  session: SessionDocument
}

/** Which Sessions have a turn in flight: the whole ledger on every change. */
export type KernelSessionTurnsEvent = {
  type: 'session-turns'
  turns: SessionTurns
}

/** Last successful local chat load — kernel memory, not the settings dropdown. */
export type KernelInferenceProfile = {
  serviceName: string
  llmModelName: string
  embeddingModelName?: string
  contextSize?: number
  modelArgs?: string
  active: boolean
}

export type KernelEventPayload =
  | KernelServiceEvent
  | KernelAgentChunkEvent
  | KernelAgentToolProgressEvent
  | KernelAgentToolImageEvent
  | KernelAgentTurnStateEvent
  | KernelAgentTurnDoneEvent
  | KernelArtifactPhaseEvent
  | KernelArtifactItemEvent
  | KernelArtifactDoneEvent
  | KernelChatChunkEvent
  | KernelChatTurnDoneEvent
  | KernelChatRagEvent
  | KernelMediaAgentEvent
  | KernelQueueEvent
  | KernelActivityEvent
  | KernelErrorEvent
  | KernelStoredEvent
  | KernelSessionChangedEvent
  | KernelSessionTurnsEvent

export type KernelEvent = KernelEventPayload & KernelEventEnvelope

/** Where an open agent turn stands in the Turn Queue. */
export type AgentTurnState = 'queued' | 'running' | 'paused'

/** What a Paused Session waits on the user for: the kind of decision and what it is about. */
export type PauseReason = {
  kind: 'download' | 'vram-warning' | 'confirmation' | 'question'
  /** Model names (with size where known), the preset, or the card's title. */
  summary?: string
}

/**
 * The accumulated state of one agent turn main holds open, for a renderer that
 * (re)connects halfway through. Chunks are stored accumulated — adjacent
 * text/reasoning deltas of the same part are merged, never as individual token
 * events to replay.
 */
export type AgentTurnSnapshot = {
  sessionId: string
  turnId: string
  state: AgentTurnState
  /** What the user is asked; only while `paused`. */
  pauseReason?: PauseReason
  /** Its place in the Turn Queue while queued (1 = next to start). */
  queuePosition?: number
  chunks: unknown[]
  toolProgress: Record<string, string>
  toolImages: Record<string, KernelAgentToolImageEvent[]>
}

/**
 * The accumulated state of the one artifact run main can be executing, for a
 * renderer that (re)connects halfway through. Items are stored accumulated.
 */
export type ArtifactRunSnapshot = {
  runId: string
  /** Which driver surface submitted the run (panel mode or tool kind). */
  mode: WorkflowModeType
  workflow: string
  variant?: string
  /**
   * Renderer drivers pre-register Image Gen items; in-process agent tools do
   * not. A reconnected renderer only hydrates the panel from `renderer` runs.
   */
  origin?: 'renderer' | 'agent'
  owner?: ArtifactRunOwner
  phase: ArtifactPhase
  progress?: { current: number; max: number }
  error?: string | null
  items: MediaItem[]
}

/**
 * The accumulated state of a chat turn main is running, for a renderer that
 * (re)connects halfway through. Chunks are stored accumulated — post-coalesce
 * batches, never individual token deltas.
 */
export type ChatTurnSnapshot = {
  turnId: string
  conversationKey: string
  chunks: UIMessageChunk[]
}

export type KernelSnapshotState = {
  /** `ApiServiceInformation` payloads, keyed off the live service registry. */
  services: unknown[]
  /** Agent turns main holds open, at most one per Agent Session. */
  agentTurns: AgentTurnSnapshot[]
  activeArtifactRun: ArtifactRunSnapshot | null
  /** Chat turns main is running, one per conversation (desktop + side channels). */
  chatTurns: ChatTurnSnapshot[]
  /** In-flight kernel activities (step 14); ended ones are not snapshotted. */
  activities: KernelActivity[]
  /** Live loaded local chat model; null when none has been loaded this session. */
  inferenceProfile: KernelInferenceProfile | null
  /** Sessions with a turn in flight, one turn each. */
  sessionTurns?: SessionTurns
}

export type KernelSnapshot = {
  scope: { kind: 'global' }
  sequence: number
  state: KernelSnapshotState
}
