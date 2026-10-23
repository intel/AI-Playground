import type { BrowserWindow } from 'electron'
import { appLoggerInstance } from '../observability/logger'
import type {
  AgentTurnSnapshot,
  ArtifactRunSnapshot,
  ArtifactRunTag,
  ArtifactPhase,
  ChatTurnSnapshot,
  KernelActivity,
  KernelActivityEvent,
  KernelAgentToolImageEvent,
  KernelErrorEvent,
  KernelEvent,
  KernelEventPayload,
  KernelEventScope,
  KernelInferenceProfile,
  KernelMediaAgentEvent,
  KernelQueueEvent,
  KernelSnapshot,
  KernelStoredEvent,
} from '@/types/kernelEvents'
import type { MediaItem } from '@/types/mediaItem'
import type { UIMessageChunk } from 'ai'
import {
  createAppError,
  serializeAppError,
  type CreateAppErrorInput,
} from '@/assets/js/errors/appError'

const appLogger = appLoggerInstance

// ── Kernel event bus (main side, docs/architecture-target.md §4.6) ────────────
//
// Every main→renderer notification crosses one ordered stream: events are
// stamped with a scope and a single sequence number, and the renderer
// projection hydrates with a listener-first snapshot handshake (subscribe,
// buffer, install at sequence N, apply events above N). Point-to-point
// `webContents.send` channels this replaces: 'serviceInfoUpdate',
// 'agentMode:streamChunk', 'agentMode:toolProgress', 'agentMode:toolImage',
// 'agentMode:turnDone'. ('agentMode:executeTool' stays: it is a request the
// renderer answers, not a notification.)
//
// The bus also owns the window it sends to. Services used to capture the
// BrowserWindow they were constructed with, so after the app window was
// recreated (macOS close + dock re-activate) their status pushes went to a
// destroyed webContents and the new renderer never learned anything. Main sets
// the current window here on every createWindow(). Parked leftovers (remaining
// event types, leftover send channels) are in docs/architecture-target.md §8.2.

const KERNEL_EVENT_CHANNEL = 'kernel:event'

let currentWin: BrowserWindow | null = null
let sequence = 0

export function setKernelEventWindow(win: BrowserWindow | null): void {
  currentWin = win
}

/** The window main currently renders into — never a stale capture. */
export function getKernelEventWindow(): BrowserWindow | null {
  return currentWin
}

type KernelEventTap = (event: KernelEvent) => void
const taps = new Set<KernelEventTap>()

/**
 * Main-side tap into the stream — the artifact runner subscribes to service
 * status through this instead of reaching into the services.
 */
export function onKernelEvent(tap: KernelEventTap): () => void {
  taps.add(tap)
  return () => {
    taps.delete(tap)
  }
}

function emit(payload: KernelEventPayload, scope: KernelEventScope): void {
  const event = { ...payload, scope, seq: ++sequence } as KernelEvent
  for (const tap of taps) {
    try {
      tap(event)
    } catch (error) {
      appLogger.warn(`kernel event tap failed: ${String(error)}`, 'kernel')
    }
  }
  const target = currentWin
  if (!target || target.isDestroyed()) return
  try {
    target.webContents.send(KERNEL_EVENT_CHANNEL, event)
  } catch (error) {
    // A destroyed-but-not-yet-collected webContents throws; events are
    // fire-and-forget so the drop is logged, not fatal.
    appLogger.warn(`kernel event ${payload.type} dropped: ${String(error)}`, 'kernel')
  }
}

// ── Service status ────────────────────────────────────────────────────────────

const services = new Map<string, unknown>()

/** Push a backend service's status to the renderer and record it for snapshots. */
export function emitServiceUpdate(info: unknown): void {
  const record = info as { serviceName?: string }
  if (record?.serviceName) services.set(record.serviceName, info)
  emit({ type: 'service', info }, { kind: 'global' })
}

// ── Agent turn accumulator ─────────────────────────────────────────────────────

let activeTurn: AgentTurnSnapshot | null = null

/** Track a turn main is about to run, so snapshots can name it. */
export function beginAgentTurnSnapshot(turnId: string): void {
  activeTurn = { turnId, chunks: [], toolProgress: {}, toolImages: {} }
}

function isMergeableAgentDelta(
  chunk: unknown,
): chunk is { type: 'text-delta' | 'reasoning-delta'; id: string; delta: string } {
  if (!chunk || typeof chunk !== 'object') return false
  const value = chunk as { type?: unknown; id?: unknown; delta?: unknown }
  return (
    (value.type === 'text-delta' || value.type === 'reasoning-delta') &&
    typeof value.id === 'string' &&
    typeof value.delta === 'string'
  )
}

export function emitAgentChunk(turnId: string, chunk: unknown): void {
  if (activeTurn?.turnId === turnId) {
    const last = activeTurn.chunks.at(-1)
    if (
      isMergeableAgentDelta(last) &&
      isMergeableAgentDelta(chunk) &&
      last.type === chunk.type &&
      last.id === chunk.id
    ) {
      last.delta += chunk.delta
    } else {
      activeTurn.chunks.push(chunk)
    }
  }
  emit({ type: 'agent-chunk', turnId, chunk }, { kind: 'run', runId: turnId })
}

export function emitAgentToolProgress(
  turnId: string,
  toolCallId: string,
  toolName: string,
  text: string,
): void {
  if (activeTurn?.turnId === turnId) activeTurn.toolProgress[toolCallId] = text
  emit(
    { type: 'agent-tool-progress', turnId, toolCallId, toolName, text },
    { kind: 'run', runId: turnId },
  )
}

export function emitAgentToolImage(toolCallId: string, dataUri: string, label: string): void {
  const event: KernelAgentToolImageEvent = { type: 'agent-tool-image', toolCallId, dataUri, label }
  if (activeTurn) {
    const shown = activeTurn.toolImages[toolCallId] ?? []
    activeTurn.toolImages[toolCallId] = [...shown, event]
  }
  emit(event, { kind: 'run', runId: activeTurn?.turnId ?? '' })
}

export function emitAgentTurnDone(turnId: string): void {
  emit({ type: 'agent-turn-done', turnId }, { kind: 'run', runId: turnId })
  if (activeTurn?.turnId === turnId) activeTurn = null
}

// ── Artifact run accumulator ──────────────────────────────────────────────────

let activeArtifactRun: ArtifactRunSnapshot | null = null

/** Track a run the artifact runner is about to start, so snapshots can name it. */
export function beginArtifactRunSnapshot(run: Omit<ArtifactRunSnapshot, 'items'>): void {
  activeArtifactRun = { ...run, items: [] }
}

function runTag(tag: ArtifactRunTag): ArtifactRunTag {
  return { runId: tag.runId, origin: tag.origin, owner: tag.owner }
}

export function emitArtifactPhase(
  tag: ArtifactRunTag,
  phase: ArtifactPhase,
  progress?: { current: number; max: number },
  error?: string,
): void {
  if (activeArtifactRun?.runId === tag.runId) {
    activeArtifactRun.phase = phase
    activeArtifactRun.progress = progress
    if (error !== undefined) activeArtifactRun.error = error
  }
  emit(
    { type: 'artifact-phase', ...runTag(tag), phase, progress, error },
    { kind: 'run', runId: tag.runId },
  )
}

export function emitArtifactItem(tag: ArtifactRunTag, item: MediaItem): void {
  if (activeArtifactRun?.runId === tag.runId) {
    const index = activeArtifactRun.items.findIndex((existing) => existing.id === item.id)
    if (index === -1) activeArtifactRun.items.push(item)
    else activeArtifactRun.items[index] = item
  }
  emit({ type: 'artifact-item', ...runTag(tag), item }, { kind: 'run', runId: tag.runId })
}

export function emitArtifactDone(
  tag: ArtifactRunTag,
  state: 'completed' | 'failed' | 'cancelled',
  error?: string,
): void {
  emit({ type: 'artifact-done', ...runTag(tag), state, error }, { kind: 'run', runId: tag.runId })
  if (activeArtifactRun?.runId === tag.runId) activeArtifactRun = null
}

/** The run main is executing right now, if any — the GPU occupancy primitive asks. */
export function getActiveArtifactRun(): ArtifactRunSnapshot | null {
  return activeArtifactRun
}

// ── Media specialist progress (transient; narration deltas coalesce) ─────────

// A nested run narrates per token; adjacent narration deltas of one run merge
// into one event on the same short timer the chat deltas use, and any other
// event of that run flushes them first.
const MEDIA_NARRATION_FLUSH_MS = 32

type MediaRunState = {
  pending: { kind: 'reasoning' | 'text'; text: string } | null
  timer: ReturnType<typeof setTimeout> | null
}

const mediaRuns = new Map<string, MediaRunState>()

function flushMediaPending(runKey: string, state: MediaRunState): void {
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }
  const pending = state.pending
  if (!pending) return
  state.pending = null
  emit(
    { type: 'media-agent-event', runKey, event: { type: 'narration-delta', ...pending } },
    { kind: 'run', runId: runKey },
  )
}

export function emitMediaAgentEvent(runKey: string, event: KernelMediaAgentEvent['event']): void {
  if (event.type === 'narration-delta') {
    let state = mediaRuns.get(runKey)
    if (!state) {
      state = { pending: null, timer: null }
      mediaRuns.set(runKey, state)
    }
    if (state.pending && state.pending.kind !== event.kind) flushMediaPending(runKey, state)
    state.pending = {
      kind: event.kind,
      text: (state.pending?.text ?? '') + event.text,
    }
    if (!state.timer) {
      state.timer = setTimeout(() => flushMediaPending(runKey, state!), MEDIA_NARRATION_FLUSH_MS)
    }
    return
  }
  const state = mediaRuns.get(runKey)
  if (state) flushMediaPending(runKey, state)
  emit({ type: 'media-agent-event', runKey, event }, { kind: 'run', runId: runKey })
}

/** The run settled; flush and stop tracking its narration. */
export function endMediaAgentRun(runKey: string): void {
  const state = mediaRuns.get(runKey)
  if (state) {
    flushMediaPending(runKey, state)
    mediaRuns.delete(runKey)
  }
}

// ── Orchestrator queue events (§4.4, step 7) ─────────────────────────────────
//
// Queue positions are transient state, not coalesced and not snapshotted: a
// reloaded renderer does not adopt queue positions, and the entries either
// run or were cancelled with their callers.

export function emitQueueEvent(event: Omit<KernelQueueEvent, 'type'>): void {
  emit(
    { type: 'queue-event', ...event },
    event.conversationKey
      ? { kind: 'chat', conversationKey: event.conversationKey }
      : { kind: 'global' },
  )
}

// ── Ledger: activity / error / stored (step 14) ───────────────────────────────

const activeActivities = new Map<string, KernelActivity>()
let inferenceProfile: KernelInferenceProfile | null = null

function activityScope(activity: KernelActivity): KernelEventScope {
  if (activity.scope.kind === 'chat') {
    return { kind: 'chat', conversationKey: activity.scope.conversationKey }
  }
  return { kind: 'global' }
}

export function emitActivity(
  action: KernelActivityEvent['action'],
  activity: KernelActivity,
): void {
  if (action === 'begin' || action === 'update') {
    activeActivities.set(activity.id, { ...activity, state: activity.state ?? 'active' })
  } else {
    activeActivities.delete(activity.id)
  }
  emit({ type: 'activity', action, activity }, activityScope(activity))
}

export function emitError(error: KernelErrorEvent['error']): void {
  const conversationKey =
    typeof error.context?.conversationKey === 'string' ? error.context.conversationKey : undefined
  emit(
    { type: 'error', error },
    conversationKey ? { kind: 'chat', conversationKey } : { kind: 'global' },
  )
}

export function emitFailure(input: CreateAppErrorInput): void {
  emitError(serializeAppError(createAppError(input)))
}

export function emitStored(
  kind: KernelStoredEvent['kind'],
  id?: string,
  inferenceProfile?: KernelInferenceProfile | null,
): void {
  emit({ type: 'stored', kind, id, inferenceProfile }, { kind: 'global' })
}

export function setInferenceProfileSnapshot(profile: KernelInferenceProfile | null): void {
  inferenceProfile = profile
  emitStored('inference-profile', undefined, profile)
}

// ── Chat turn accumulator + delta coalescing (§4.6 "Streaming across IPC") ───
//
// The chat turn engine in main streams UIMessageChunks over the bus. Adjacent
// text/reasoning deltas of the same part are merged into one chunk and flushed
// on a short timer; any semantic chunk (tool, error, finish, …) flushes the
// pending delta first, so it can never overtake the content it follows.

const CHAT_DELTA_FLUSH_MS = 32

type MergeableDelta = Extract<UIMessageChunk, { type: 'text-delta' | 'reasoning-delta' }>

type ChatTurnState = {
  snapshot: ChatTurnSnapshot
  pending: MergeableDelta | null
  timer: ReturnType<typeof setTimeout> | null
}

const chatTurns = new Map<string, ChatTurnState>()

function chatTurnKey(conversationKey: string, turnId: string): string {
  return `${conversationKey}::${turnId}`
}

function isMergeableDelta(chunk: UIMessageChunk): boolean {
  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'
}

function flushChatPending(state: ChatTurnState): void {
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }
  const pending = state.pending
  if (!pending) return
  state.pending = null
  emitChatChunkNow(state.snapshot.conversationKey, state.snapshot.turnId, pending)
}

function emitChatChunkNow(conversationKey: string, turnId: string, chunk: UIMessageChunk): void {
  const state = chatTurns.get(chatTurnKey(conversationKey, turnId))
  if (state) state.snapshot.chunks.push(chunk)
  emit({ type: 'chat-chunk', conversationKey, turnId, chunk }, { kind: 'chat', conversationKey })
}

/** Track a chat turn main is about to run, so snapshots can name it. */
export function beginChatTurnSnapshot(conversationKey: string, turnId: string): void {
  chatTurns.set(chatTurnKey(conversationKey, turnId), {
    snapshot: { conversationKey, turnId, chunks: [] },
    pending: null,
    timer: null,
  })
}

/**
 * Coalescing emit for one UIMessageChunk of a running chat turn. Semantic
 * chunks go out immediately (flushing any pending delta first); adjacent
 * text/reasoning deltas of the same part merge until the flush timer fires.
 */
export function emitChatChunk(
  conversationKey: string,
  turnId: string,
  chunk: UIMessageChunk,
): void {
  const state = chatTurns.get(chatTurnKey(conversationKey, turnId))
  if (!state) {
    // A turn main does not track (should not happen) streams uncoalesced.
    emitChatChunkNow(conversationKey, turnId, chunk)
    return
  }
  if (isMergeableDelta(chunk)) {
    const pending = state.pending
    if (pending && pending.type === chunk.type && pending.id === chunk.id) {
      pending.delta += chunk.delta
      // Reasoning deltas carry the block's timing metadata: the merged chunk
      // keeps the block's first start and the latest finish.
      const a = pending.providerMetadata?.aipg as Record<string, unknown> | undefined
      const b = (chunk as MergeableDelta).providerMetadata?.aipg as
        Record<string, unknown> | undefined
      if (a || b) {
        pending.providerMetadata = {
          ...(pending.providerMetadata ?? {}),
          aipg: {
            ...(b ?? {}),
            ...(a?.reasoningStarted != null
              ? { reasoningStarted: a.reasoningStarted as number }
              : {}),
          },
        }
      }
    } else {
      flushChatPending(state)
      state.pending = { ...(chunk as MergeableDelta) }
    }
    if (!state.timer) {
      state.timer = setTimeout(() => flushChatPending(state), CHAT_DELTA_FLUSH_MS)
    }
    return
  }
  flushChatPending(state)
  emitChatChunkNow(conversationKey, turnId, chunk)
}

/** RAG source chip for the turn. Not snapshotted — retrieval finishes before streaming. */
export function emitChatRag(
  conversationKey: string,
  turnId: string,
  sourceText: string | null,
): void {
  emit({ type: 'chat-rag', conversationKey, turnId, sourceText }, { kind: 'chat', conversationKey })
}

/**
 * The turn settled: flush any pending delta (so the streamed text is never
 * lost behind the done event) and stop tracking the turn. Snapshots no longer
 * name it — resume only applies to turns still running.
 */
export function endChatTurn(conversationKey: string, turnId: string): void {
  const key = chatTurnKey(conversationKey, turnId)
  const state = chatTurns.get(key)
  if (state) {
    flushChatPending(state)
    chatTurns.delete(key)
  }
  emit({ type: 'chat-turn-done', conversationKey, turnId }, { kind: 'chat', conversationKey })
}

/**
 * The coalesced chunk log of a running turn plus the bus sequence it was
 * captured at — the renderer resumes by replaying the log, then applying only
 * events stamped above that sequence. Synchronous on main's single thread, so
 * no event can slip between the copy and the watermark.
 */
export function getChatTurnChunks(
  conversationKey: string,
  turnId: string,
): { chunks: UIMessageChunk[]; sequence: number } | null {
  const state = chatTurns.get(chatTurnKey(conversationKey, turnId))
  if (!state) return null
  flushChatPending(state)
  return { chunks: [...state.snapshot.chunks], sequence }
}

/** All chat turns main is running right now (for the kernel snapshot). */
export function getActiveChatTurns(): ChatTurnSnapshot[] {
  const turns: ChatTurnSnapshot[] = []
  for (const state of chatTurns.values()) {
    flushChatPending(state)
    turns.push({ ...state.snapshot, chunks: [...state.snapshot.chunks] })
  }
  return turns
}

// ── Snapshot ───────────────────────────────────────────────────────────────────

/**
 * The projection's hydration state. `sequence` is the bus's last stamped seq:
 * the renderer applies only buffered events above it, so nothing recorded in
 * this snapshot can be double-applied.
 */
export function getKernelSnapshot(): KernelSnapshot {
  // Flush pending chat deltas first: they emit and bump `sequence`, and the
  // watermark must be captured after that so a resumed renderer does not also
  // apply the just-flushed chunks as live events.
  const chatTurnSnapshots = getActiveChatTurns()
  return {
    scope: { kind: 'global' },
    sequence,
    state: {
      services: [...services.values()],
      activeTurn: activeTurn ? { ...activeTurn } : null,
      activeArtifactRun: activeArtifactRun ? { ...activeArtifactRun } : null,
      chatTurns: chatTurnSnapshots,
      activities: [...activeActivities.values()],
      inferenceProfile,
    },
  }
}

// Test seam: reset module state between unit tests.
export function resetKernelBusForTest(): void {
  currentWin = null
  sequence = 0
  services.clear()
  activeTurn = null
  activeArtifactRun = null
  for (const state of chatTurns.values()) {
    if (state.timer) clearTimeout(state.timer)
  }
  chatTurns.clear()
  for (const state of mediaRuns.values()) {
    if (state.timer) clearTimeout(state.timer)
  }
  mediaRuns.clear()
  taps.clear()
  activeActivities.clear()
  inferenceProfile = null
}
