// ── The orchestrator (docs/architecture-target.md §4.4, steps 7 + 10) ─────────
//
// One queue and one GPU policy for every GPU-competing caller. Until this
// module existed the same job was smeared across three places that could not
// see each other: the renderer's mediaPipeline lanes (serializing tool calls),
// the renderer's chatBackends wrap (stopping/reloading the LLM around chat
// tool generations — and nothing did it for panel runs at all), and the
// gpuOccupancy refcount (the same wrap for in-process agent tools only).
//
// What it owns now:
// - the typed queue (`KernelRequestMap`): text turns (chat occupancy) and
//   artifact runs, plus a request lane for whole media-request brackets.
//   Artifact `queue` submissions park FIFO; `fail-fast` keeps the panel's
//   "one generation at a time" contract and refuses while a local chat turn
//   occupies the GPU. Nested media for that turn uses `queue`, not fail-fast.
//   Queue lifecycle crosses the kernel bus as `queue-event`.
// - the GPU window: which side holds the GPU, the LLM⇄ComfyUI swap, the
//   skip-when-queued rule (a spritesheet costs one swap, not one per sprite),
//   and the wait for open chat HTTP (and unrelated text occupancy) before
//   stopping a backend mid-stream — no proceed-anyway bound.
// - chat readiness admission: Chat, Agent, and Home Agent `/load` occupy as
//   `text` requests first; `ensureChatBackendReady` then loads with
//   `skipGpuAdmission` because the window wait already happened.
//
// What deliberately stays out: which model to load is still data from the last
// successful load (or the turn request); download consent stays renderer-side.
// Concurrent chat turns stay concurrent with each other; they serialize only
// against the media GPU window. VRAM budgets / jump-the-queue are not here.

import { appLoggerInstance } from '../observability/logger'
import { emitArtifactPhase, emitQueueEvent } from './kernelBus'
import {
  artifactRunActive,
  artifactRunTag,
  activeArtifactRunId,
  cancelActiveArtifactRun,
  startArtifactRun,
  type ArtifactRunPayload,
  type ArtifactRunResult,
} from '../artifact/runner'

const appLogger = appLoggerInstance

export type TextRequest = {
  runId: string
  conversationKey: string
  /** Local LLM turns wait for the chat GPU window. Cloud turns occupy without waiting. */
  needsGpu: boolean
}

export type KernelRequestMap = {
  text: { request: TextRequest; result: void }
  artifact: { request: ArtifactRunPayload; result: ArtifactRunResult }
}

export type KernelRequest<K extends keyof KernelRequestMap> = {
  id: string
  kind: K
  payload: KernelRequestMap[K]['request']
}

type TextOccupancy = TextRequest & { phase: 'waiting' | 'running' }

export type OrchestratorDeps = {
  /** Stop the running chat LLM/embedding servers (OVMS keeps speech servers up). */
  stopChatForMedia(): Promise<void>
  /** Free ComfyUI memory and unload its models (no-op when it is not running). */
  freeComfyMemory(): Promise<void>
  /** Load the last chat model again (in-process; no-op if none was loaded). */
  restartChatBackend(): Promise<void>
  /** In-flight /v1/chat/completions requests (chat turns, media specialists, summarize). */
  chatRequestsOpen(): number
}

let orchestratorDeps: OrchestratorDeps | null = null

type QueuedRun = {
  payload: ArtifactRunPayload
  resolve: (result: ArtifactRunResult) => void
}

const runQueue: QueuedRun[] = []

// Admitted = executeRun has been entered and not yet settled. `artifactRunActive`
// only flips once the runner starts, which is after the GPU acquire can await,
// so fail-fast has to key off this or two panel submits in the same tick both
// enter executeRun and the second cancels the first inside the runner.
let admittedArtifactRuns = 0
const admittedCancels = new Map<string, AbortController>()

// The media-request lane: one whole `media` bracket (nested specialist + its
// generations) at a time — four parallel `media` tool calls must not prompt
// the model four at once, and the bracket's own LLM steps need the chat
// backend up, so it waits for the GPU window before starting.
type QueuedMediaRequest = {
  runKey: string
  conversationKey?: string
  abortSignal?: AbortSignal
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}
const mediaRequestQueue: QueuedMediaRequest[] = []
let mediaRequestActive = false

// 'media' while any artifact run has swapped the LLM off the GPU, 'chat'
// otherwise. The swap-back is tracked separately so a new media run (or a
// chat readiness) never stops the backend while its reload is still in
// flight — the old wraps shared this hazard, the queue makes it reachable.
let gpuWindow: 'chat' | 'media' = 'chat'
let swapBackInFlight: Promise<void> | null = null

const textOccupancy = new Map<string, TextOccupancy>()

export function setOrchestratorDeps(deps: OrchestratorDeps): void {
  orchestratorDeps = deps
}

// Test seam.
export function resetOrchestratorForTest(): void {
  orchestratorDeps = null
  runQueue.splice(0)
  for (const cancel of admittedCancels.values()) cancel.abort()
  admittedCancels.clear()
  admittedArtifactRuns = 0
  for (const entry of mediaRequestQueue) {
    entry.reject(new Error('Orchestrator reset for test'))
  }
  mediaRequestQueue.splice(0)
  mediaRequestActive = false
  gpuWindow = 'chat'
  swapBackInFlight = null
  textOccupancy.clear()
}

export function artifactRunsQueued(): number {
  return runQueue.length
}

/** Admitted, executing, or queued — close policy and fail-fast both ask. */
export function artifactWorkOpen(): boolean {
  return queueBusy()
}

export function mediaRequestsQueued(): number {
  return mediaRequestQueue.length
}

export function textRequestsOpen(): number {
  return textOccupancy.size
}

/** Artifact FIFO only — text occupancy must not live here or nested media deadlocks. */
function queueBusy(): boolean {
  return admittedArtifactRuns > 0 || artifactRunActive() || runQueue.length > 0
}

function localTextGpuOpen(): boolean {
  for (const entry of textOccupancy.values()) {
    if (entry.needsGpu) return true
  }
  return false
}

function textWaitingCount(): number {
  let count = 0
  for (const entry of textOccupancy.values()) {
    if (entry.phase === 'waiting') count += 1
  }
  return count
}

function unrelatedLocalTextOpen(conversationKey?: string): boolean {
  for (const entry of textOccupancy.values()) {
    if (!entry.needsGpu) continue
    if (conversationKey && entry.conversationKey === conversationKey) continue
    return true
  }
  return false
}

// ── Artifact run queue ────────────────────────────────────────────────────────

/**
 * Submits a resolved run. `queue: 'fail-fast'` (panel / Home Agent) refuses
 * while anything is executing or queued, and while a local chat turn occupies
 * the GPU (so a panel click cannot kill an open stream). `'queue'` (chat tool
 * lanes, in-process agent tools) parks FIFO and may run nested inside its
 * parent text occupancy.
 */
export function submitArtifactRun(
  payload: ArtifactRunPayload,
  options: { queue: 'fail-fast' | 'queue' } = { queue: 'fail-fast' },
): Promise<ArtifactRunResult> {
  if (queueBusy()) {
    if (options.queue === 'fail-fast') {
      return Promise.resolve({
        state: 'failed',
        items: [],
        error: 'Another generation is already in progress',
      })
    }
    return new Promise<ArtifactRunResult>((resolve) => {
      runQueue.push({ payload, resolve })
      emitArtifactPhase(artifactRunTag(payload), 'queued')
      emitQueueEvent({
        runKey: payload.runId,
        kind: 'artifact',
        action: 'enqueued',
        queueDepth: runQueue.length - 1,
        origin: payload.origin,
        conversationKey: payload.conversationKey,
        activityId: payload.activityId,
      })
    })
  }
  if (options.queue === 'fail-fast' && localTextGpuOpen()) {
    return Promise.resolve({
      state: 'failed',
      items: [],
      error: 'A chat turn is already in progress',
    })
  }
  return executeRun(payload)
}

function executeRun(payload: ArtifactRunPayload): Promise<ArtifactRunResult> {
  const cancel = new AbortController()
  admittedCancels.set(payload.runId, cancel)
  admittedArtifactRuns += 1
  emitQueueEvent({
    runKey: payload.runId,
    kind: 'artifact',
    action: 'started',
    queueDepth: runQueue.length,
    origin: payload.origin,
    conversationKey: payload.conversationKey,
    activityId: payload.activityId,
  })
  return withGpuWindow(payload, () => startArtifactRun(payload), cancel.signal).finally(
    async () => {
      admittedCancels.delete(payload.runId)
      emitArtifactFinished(payload)
      admittedArtifactRuns -= 1
      await drainQueue()
    },
  )
}

async function drainQueue(): Promise<void> {
  if (admittedArtifactRuns > 0 || artifactRunActive()) return
  const next = runQueue.shift()
  if (next) {
    void executeRun(next.payload).then(next.resolve)
    return
  }
  // Release lives here, not in withGpuWindow: Keep Models Loaded skips acquire
  // but a queued keep-true tail after a swap still has to return the GPU to
  // chat, and cancelling the last waiter must not leave the window on media.
  await considerRelease()
}

function emitArtifactFinished(payload: ArtifactRunPayload): void {
  emitQueueEvent({
    runKey: payload.runId,
    kind: 'artifact',
    action: 'finished',
    queueDepth: runQueue.length,
    origin: payload.origin,
    conversationKey: payload.conversationKey,
    activityId: payload.activityId,
  })
}

/** Cancels one run by id, whether it is active, admitted, or still waiting. */
export function cancelArtifactRun(runId: string): void {
  admittedCancels.get(runId)?.abort()
  if (activeArtifactRunId() === runId) {
    cancelActiveArtifactRun()
    return
  }
  const index = runQueue.findIndex((entry) => entry.payload.runId === runId)
  if (index !== -1) {
    const [entry] = runQueue.splice(index, 1)
    dropQueuedRun(entry)
  }
}

function dropQueuedRun(entry: (typeof runQueue)[number], reason?: string): void {
  const result = cancelledRun(reason)
  emitArtifactPhase(artifactRunTag(entry.payload), 'cancelled', undefined, result.error)
  emitArtifactFinished(entry.payload)
  entry.resolve(result)
}

/**
 * Drops queued runs and aborts admitted/active ones. A destroyed renderer
 * cannot drive placeholders, and a replacement window must not fail-fast on
 * an invisible drain.
 */
export function cancelAllArtifactRuns(reason = 'Generation cancelled.'): void {
  for (const entry of runQueue.splice(0)) dropQueuedRun(entry, reason)
  for (const cancel of admittedCancels.values()) cancel.abort()
  cancelActiveArtifactRun()
}

function cancelledRun(error = 'Generation cancelled.'): ArtifactRunResult {
  return { state: 'cancelled', items: [], error }
}

// ── Text occupancy (`KernelRequestMap['text']`, step 10) ───────────────────────

/**
 * Registers a chat turn as queue occupancy and, for local LLM turns, waits
 * until the GPU window is chat. Resolves when the turn may load/stream.
 * Nested media for this conversation uses `queue`, not fail-fast, so it can
 * take the GPU while this occupancy is still live (HTTP is idle in the tool
 * phase). Cloud turns occupy without waiting — they do not hold the local GPU.
 */
export async function submitTextRequest(request: TextRequest, signal?: AbortSignal): Promise<void> {
  if (textOccupancy.has(request.runId)) {
    throw new Error(`Text request ${request.runId} is already occupying the queue`)
  }
  textOccupancy.set(request.runId, { ...request, phase: 'waiting' })
  emitQueueEvent({
    runKey: request.runId,
    kind: 'text',
    action: 'enqueued',
    queueDepth: Math.max(0, textWaitingCount() - 1),
    conversationKey: request.conversationKey,
  })
  try {
    if (request.needsGpu) {
      await awaitChatWindow(signal)
    } else if (signal?.aborted) {
      throw cancelledChatWindow()
    }
    const entry = textOccupancy.get(request.runId)
    if (!entry) return
    entry.phase = 'running'
    emitQueueEvent({
      runKey: request.runId,
      kind: 'text',
      action: 'started',
      queueDepth: textWaitingCount(),
      conversationKey: request.conversationKey,
    })
  } catch (error) {
    finishTextRequest(request.runId)
    throw error
  }
}

/** Drops occupancy. Idempotent — cancel-during-wait already finished it. */
export function finishTextRequest(runId: string): void {
  const entry = textOccupancy.get(runId)
  if (!entry) return
  textOccupancy.delete(runId)
  emitQueueEvent({
    runKey: runId,
    kind: 'text',
    action: 'finished',
    queueDepth: textWaitingCount(),
    conversationKey: entry.conversationKey,
  })
}

// ── Media request lane ─────────────────────────────────────────────────────────

/**
 * Runs one whole media-request bracket at a time, waiting for the GPU window
 * first: the bracket's own LLM steps need the chat backend, so it must not
 * start while a generation holds the GPU for media.
 */
export function runMediaRequest<T>(
  run: () => Promise<T>,
  options: { runKey: string; conversationKey?: string; abortSignal?: AbortSignal },
): Promise<T> {
  if (options.abortSignal?.aborted) {
    return Promise.reject(new Error('Cancelled while waiting for the media request lane.'))
  }
  return new Promise<T>((resolve, reject) => {
    const entry: QueuedMediaRequest = {
      runKey: options.runKey,
      conversationKey: options.conversationKey,
      abortSignal: options.abortSignal,
      run,
      resolve: resolve as (value: unknown) => void,
      reject,
    }
    const onAbort = () => {
      const index = mediaRequestQueue.indexOf(entry)
      if (index === -1) return
      mediaRequestQueue.splice(index, 1)
      emitQueueEvent({
        runKey: entry.runKey,
        kind: 'media-request',
        action: 'finished',
        queueDepth: mediaRequestQueue.length,
        conversationKey: entry.conversationKey,
      })
      reject(new Error('Cancelled while waiting for the media request lane.'))
    }
    options.abortSignal?.addEventListener('abort', onAbort, { once: true })
    mediaRequestQueue.push(entry)
    emitQueueEvent({
      runKey: options.runKey,
      kind: 'media-request',
      action: 'enqueued',
      queueDepth: mediaRequestQueue.length - 1,
      conversationKey: options.conversationKey,
    })
    drainMediaRequestLane()
  })
}

function drainMediaRequestLane(): void {
  if (mediaRequestActive) return
  const entry = mediaRequestQueue.shift()
  if (!entry) return
  mediaRequestActive = true
  void (async () => {
    try {
      if (entry.abortSignal?.aborted) {
        throw new Error('Cancelled while waiting for the media request lane.')
      }
      await waitForChatWindow(entry.abortSignal)
      if (entry.abortSignal?.aborted) {
        throw new Error('Cancelled while waiting for the media request lane.')
      }
      emitQueueEvent({
        runKey: entry.runKey,
        kind: 'media-request',
        action: 'started',
        queueDepth: mediaRequestQueue.length,
        conversationKey: entry.conversationKey,
      })
      const result = await entry.run()
      entry.resolve(result)
    } catch (error) {
      entry.reject(error)
    } finally {
      emitQueueEvent({
        runKey: entry.runKey,
        kind: 'media-request',
        action: 'finished',
        queueDepth: mediaRequestQueue.length,
        conversationKey: entry.conversationKey,
      })
      mediaRequestActive = false
      drainMediaRequestLane()
    }
  })()
}

// ── GPU window policy ──────────────────────────────────────────────────────────

/**
 * Brackets GPU-holding work. `keepModelsLoaded` skips the swap *onto* media
 * (the user's developer setting, carried per run) but never the swap back —
 * that lives in `drainQueue` so a keep-true tail after a real swap still
 * returns the GPU to chat. Failures in the swap-back are logged, never thrown
 * — throwing would replace a finished result with a cleanup error, and the
 * chat model comes back with the next turn anyway.
 */
async function withGpuWindow<T>(
  payload: ArtifactRunPayload,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    if (!payload.keepModelsLoaded) await acquireMediaWindow(payload.conversationKey, signal)
    if (signal?.aborted) return cancelledRun() as T
    return await fn()
  } catch (error) {
    if (signal?.aborted) return cancelledRun() as T
    throw error
  }
}

/** Reads the window without flow narrowing — an awaited swap-back can flip it. */
function windowIsMedia(): boolean {
  return gpuWindow === 'media'
}

async function acquireMediaWindow(conversationKey?: string, signal?: AbortSignal): Promise<void> {
  if (!orchestratorDeps) return
  if (windowIsMedia()) return
  // A release may still be reloading the chat backend; stopping it mid-reload
  // is the race the old wraps shared, and the queue makes it reachable.
  if (swapBackInFlight) await swapBackInFlight.catch(() => {})
  if (windowIsMedia()) return
  await waitForChatRequestsIdle(signal)
  // Nested media for this conversation may take the GPU while its parent text
  // occupancy is still live (tool phase, HTTP idle). An unrelated chat turn
  // must finish first — no proceed-anyway bound, or that stream dies as a
  // network error.
  await waitForUnrelatedTextIdle(conversationKey, signal)
  if (windowIsMedia()) return
  if (signal?.aborted) throw cancelledGeneration()
  // Flip before stopChatForMedia (seconds — two backends). awaitChatWindow is a
  // one-shot wait on this flag; leaving it on 'chat' until after the stop lets
  // a turn pass the gate and then die when the in-flight stop kills its backend.
  gpuWindow = 'media'
  try {
    await orchestratorDeps.stopChatForMedia()
  } catch (error) {
    gpuWindow = 'chat'
    throw error
  }
  if (signal?.aborted) throw cancelledGeneration()
}

const CHAT_REQUEST_POLL_MS = 250

async function waitForChatRequestsIdle(signal?: AbortSignal): Promise<void> {
  if (!orchestratorDeps) return
  while (orchestratorDeps.chatRequestsOpen() > 0) {
    if (signal?.aborted) throw cancelledGeneration()
    await delay(CHAT_REQUEST_POLL_MS, signal, cancelledGeneration)
  }
}

async function waitForUnrelatedTextIdle(
  conversationKey?: string,
  signal?: AbortSignal,
): Promise<void> {
  while (unrelatedLocalTextOpen(conversationKey)) {
    if (signal?.aborted) throw cancelledGeneration()
    await delay(CHAT_REQUEST_POLL_MS, signal, cancelledGeneration)
  }
}

/**
 * The skip rule: a run that still sees media work queued behind it leaves both
 * models where they are and lets the last one out do the swap back — one
 * spritesheet costs one swap, not one per sprite. Queued media requests do
 * NOT skip it: their first LLM step needs the chat backend back.
 */
async function considerRelease(): Promise<void> {
  if (gpuWindow !== 'media') return
  if (runQueue.length > 0) return
  if (!orchestratorDeps) return
  const deps = orchestratorDeps
  gpuWindow = 'chat'
  swapBackInFlight = (async () => {
    try {
      await deps.freeComfyMemory()
    } catch (error) {
      appLogger.warn(`Freeing image models failed: ${String(error)}`, 'electron-backend')
    }
    try {
      await deps.restartChatBackend()
    } catch (error) {
      appLogger.warn(
        `Could not load the chat model again after generating: ${String(error)}`,
        'electron-backend',
      )
    }
  })()
  try {
    await swapBackInFlight
  } finally {
    swapBackInFlight = null
  }
}

/**
 * Resolves once the GPU window is back on chat and no swap-back is running.
 * Chat, Agent, and Home Agent `/load` wait here via `submitTextRequest`.
 * No proceed-anyway bound: abort the signal (cancel the turn) to give up.
 */
export async function awaitChatWindow(signal?: AbortSignal): Promise<void> {
  while (gpuWindow === 'media' || swapBackInFlight) {
    if (signal?.aborted) throw cancelledChatWindow()
    await delay(500, signal)
  }
}

function waitForChatWindow(signal?: AbortSignal): Promise<void> {
  return awaitChatWindow(signal)
}

function cancelledChatWindow(): Error {
  return new Error('Cancelled while waiting for the chat GPU window.')
}

function cancelledGeneration(): Error {
  return new Error('Generation cancelled.')
}

function delay(
  ms: number,
  signal?: AbortSignal,
  abortedError: () => Error = cancelledChatWindow,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
