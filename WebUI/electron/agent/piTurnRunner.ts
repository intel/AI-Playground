import fs from 'node:fs'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { appLoggerInstance } from '../observability/logger.ts'
import {
  beginAgentTurnSnapshot,
  emitAgentChunk,
  emitAgentToolProgress,
  emitAgentTurnDone,
  emitAgentTurnState,
} from '../kernel/kernelBus.ts'
import { closeAllBrowserSessions, closeBrowserSession } from './agentBrowser.ts'
import { closeWorkspaceRuntime } from './piWorkspaceRuntime.ts'
import {
  endsPlanning,
  endThinking,
  isWritingTool,
  planExists,
  PLAN_FILE,
  thinkingIsOn,
} from './planningPhase.ts'
import {
  createStreamTranslator,
  type StepUsage,
  type StreamChunk,
  type TurnSummary,
} from './piStreamTranslate.ts'
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { IpcMutationResult } from '@/types/ipcChannels'
import { clearPointer, readSessionStore, savePointer } from './piSessionStore.ts'
import { briefly, LOG_SOURCE, verboseLogging } from './piAgentLog.ts'
import {
  active,
  agentTurns,
  lastSessionId,
  type ActiveSession,
  type AgentTurn,
} from './piAgentState.ts'
import {
  endActiveSession,
  ensureSession,
  reapplySession,
  releaseTurnSession,
} from './piSessionLifecycle.ts'
import { agentRunIdentity } from './agentRunIdentity.ts'
import { reportAgentTurnEnd, type AgentTurnEnd } from './agentTurnOutcome.ts'
import { trackAgentTurnInSession } from '../session/sessionAgentTurns.ts'
import {
  claimSessionTurn,
  releaseSessionTurn,
  SESSION_BUSY_MESSAGE,
} from '../session/sessionTurns.ts'
import { takeSessionUpdate } from '../session/sessionUpdate.ts'
import { noteAnswerTurn } from './notifier.ts'
import { downloadedMissingReadinessModels } from './agentModelConsent.ts'
import { setAgentRunIdentity } from '../observability/laminarAttributes.ts'
import {
  finishTextRequest,
  reclaimTurnPlace,
  submitTextRequest,
  turnQueueHolder,
  type TurnPause,
} from '../kernel/orchestrator.ts'
import {
  ensureChatBackendReady,
  setLastChatBackendLoadActive,
  setTurnChatBackendLoad,
} from '../chat/chatReadiness.ts'

const logger = appLoggerInstance

/**
 * Thinking pays for itself while the agent decides what to build and stops
 * paying once that decision has been committed to a file: `design.md` for the
 * session that then edits its way down the checklist in it, the game itself for
 * the session that writes everything in one go (planningPhase.ts). Returns the
 * event sink that watches for that write; a plan already on disk ends the phase
 * before the turn's first request.
 */
function watchPlanningPhase(current: ActiveSession): PlanningWatch {
  const end = current.planningEnd
  const stop = (reason: string) => {
    if (!endThinking(current.samplingParams)) return
    logger.info(
      `planning done (${reason}): thinking off for the rest of the session`,
      LOG_SOURCE,
      true,
    )
  }
  const thinking = thinkingIsOn(current.samplingParams)
  if (end === 'plan-file' && thinking && planExists(current.workspaceDir)) {
    stop(`${PLAN_FILE} already written`)
  }

  // `tool_execution_end` carries no arguments, so what a call means is worked out
  // when it starts and acted on only once it has succeeded.
  const writes = new Map<string, boolean>()
  let wrote = false
  return {
    wrote: () => wrote,
    onEvent: (event) => {
      if (event.type === 'tool_execution_start') {
        if (isWritingTool(event.toolName)) {
          writes.set(
            event.toolCallId,
            end !== null && endsPlanning(end, event.toolName, event.args),
          )
        }
        return
      }
      if (event.type !== 'tool_execution_end') return
      const endsPhase = writes.get(event.toolCallId)
      if (endsPhase === undefined || event.isError) return
      writes.delete(event.toolCallId)
      wrote = true
      if (endsPhase) stop(end === 'plan-file' ? `${PLAN_FILE} written` : 'the game is on disk')
    },
  }
}

/** Watches one turn: ends the thinking phase, and reports what the turn wrote. */
type PlanningWatch = {
  onEvent: (event: AgentSessionEvent) => void
  /** Whether a file has been written since the turn began. */
  wrote: () => boolean
}

/**
 * Approve the plan on the user's behalf and ask for the build — the second half
 * of a turn that was split in two (planningPhase.ts). Nothing to approve if the
 * model built instead of planning: it has already done what the handoff asks
 * for, and asking again would only get the same file written twice.
 */
async function handOffToBuild(current: ActiveSession, planning: PlanningWatch): Promise<boolean> {
  if (!current.planPending || !current.planHandoff) return false
  current.planPending = false
  if (planning.wrote()) {
    logger.info('plan step built instead of planning; no handoff needed', LOG_SOURCE)
    return false
  }
  // The split is the capability's; whether the build also gets cheaper by
  // dropping thinking is the user's setting, which is what planningEnd carries.
  if (current.planningEnd && endThinking(current.samplingParams)) {
    logger.info('plan accepted: thinking off for the build', LOG_SOURCE, true)
  }
  await current.session.prompt(current.planHandoff)
  return true
}

function logEvent(event: AgentSessionEvent): void {
  switch (event.type) {
    case 'turn_start':
      logger.info('[pi] ── turn start ──', LOG_SOURCE)
      break
    case 'tool_execution_start':
      logger.info(`[pi] → tool ${event.toolName}(${briefly(event.args)})`, LOG_SOURCE)
      break
    case 'tool_execution_end':
      if (event.isError) {
        logger.warn(`[pi] ✗ ${event.toolName} error: ${briefly(event.result)}`, LOG_SOURCE)
      } else {
        logger.info(`[pi] ← ${event.toolName} result: ${briefly(event.result)}`, LOG_SOURCE)
      }
      break
    case 'compaction_end': {
      const before = event.result?.tokensBefore
      const after = event.result?.estimatedTokensAfter
      const sizes =
        before !== undefined && after !== undefined
          ? `${before.toLocaleString('en-US')} → ${after.toLocaleString('en-US')} tokens`
          : 'no token counts reported'
      logger.info(`[pi] ⧉ context compacted (${event.reason}): ${sizes}`, LOG_SOURCE)
      break
    }
    case 'auto_retry_start':
      logger.warn(
        `[pi] retry ${event.attempt}/${event.maxAttempts} after error: ${briefly(event.errorMessage)}`,
        LOG_SOURCE,
      )
      break
    default:
      break
  }
}

/** Usage + context occupancy at this moment, read off the live session. */
function turnSummary(session: AgentSession): TurnSummary {
  const summary: TurnSummary = {}
  try {
    const stats = session.getSessionStats()
    const tokens = stats.tokens
    if (tokens) {
      summary.usage = {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheReadTokens: tokens.cacheRead,
        cacheWriteTokens: tokens.cacheWrite,
        costUsd: stats.cost,
      }
    }
  } catch (error) {
    logger.warn(`failed to read session stats: ${error}`, LOG_SOURCE)
  }
  try {
    const context = session.getContextUsage()
    if (context) {
      summary.contextUsage = {
        tokens: context.tokens,
        contextWindow: context.contextWindow,
        percent: context.percent,
      }
    }
  } catch (error) {
    logger.warn(`failed to read context usage: ${error}`, LOG_SOURCE)
  }
  try {
    summary.lastStep = lastStepUsage(session)
  } catch (error) {
    logger.warn(`failed to read last step usage: ${error}`, LOG_SOURCE)
  }
  return summary
}

/**
 * Usage of the newest assistant message. Chat mode's gauge reports the last
 * model call, so Agent Mode reports the same thing next to Pi's session totals
 * instead of only the totals (which are ~100x larger over an agentic run).
 */
function lastStepUsage(session: AgentSession): StepUsage | undefined {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index] as { role?: string; usage?: Record<string, unknown> }
    if (message.role !== 'assistant') continue
    const usage = message.usage
    if (!usage) return undefined
    const number = (value: unknown) => (typeof value === 'number' ? value : 0)
    return {
      inputTokens: number(usage.input),
      outputTokens: number(usage.output),
      cacheReadTokens: number(usage.cacheRead),
    }
  }
  return undefined
}

/**
 * A turn ends when the model stops asking for tools, so a reply that carries
 * neither an answer nor a tool call ends it mid-task: the model meant to call a
 * tool but emitted the call markup inside its thinking channel, the provider
 * reported a plain `stop` with no tool call, and Pi's loop had nothing left to
 * run. Nothing failed, so without this check the UI simply goes idle halfway
 * through the job — which reads as the agent being interrupted.
 */
function endedWithoutReplyOrToolCall(session: AgentSession): boolean {
  const last = session.messages.at(-1) as { role?: string; content?: unknown } | undefined
  if (last?.role !== 'assistant') return false
  const content = last.content
  if (typeof content === 'string') return content.trim() === ''
  if (!Array.isArray(content)) return false
  return !content.some((entry) => {
    const part = entry as { type?: string; text?: string }
    if (part.type === 'toolCall') return true
    return part.type === 'text' && (part.text ?? '').trim() !== ''
  })
}

/** The last assistant text since the latest prompt, so a turn that wrote none never repeats an older one. */
function finalReplyText(session: AgentSession): string | undefined {
  for (const message of [...session.messages].reverse()) {
    const { role, content } = message as { role?: string; content?: unknown }
    if (role === 'user') return undefined
    if (role !== 'assistant') continue
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((entry) => entry as { type?: string; text?: string })
              .filter((part) => part.type === 'text')
              .map((part) => part.text ?? '')
              .join('')
          : ''
    if (text.trim()) return text.trim()
  }
  return undefined
}

/**
 * The provider's complaint when the model call itself failed. Pi records a
 * failed call as an assistant message with `stopReason: 'error'` and resolves
 * the prompt normally instead of throwing, so an unusable model — a model id the
 * provider has retired, a revoked key, a rejected payload — arrives here looking
 * exactly like a turn that ended without a reply, and the nudge above would
 * answer a 422 with "the model ended its turn without an answer".
 */
function modelCallError(session: AgentSession): string | undefined {
  const last = session.messages.at(-1) as
    { role?: string; stopReason?: string; errorMessage?: string } | undefined
  if (last?.role !== 'assistant' || last.stopReason !== 'error') return undefined
  return readableProviderError(last.errorMessage) ?? 'The model call failed without a reason.'
}

/**
 * The part of a provider error worth reading. OpenAI-compatible endpoints answer
 * with `{"error": {"message": …}}`, usually wrapped in status text and routing
 * metadata that buries the one sentence naming the actual problem.
 */
function readableProviderError(raw: string | undefined): string | undefined {
  const text = raw?.trim()
  if (!text) return undefined
  const jsonStart = text.indexOf('{')
  if (jsonStart !== -1) {
    try {
      const payload = JSON.parse(text.slice(jsonStart)) as {
        error?: { message?: string }
        message?: string
      }
      const message = payload.error?.message ?? payload.message
      if (message) {
        const prefix = text
          .slice(0, jsonStart)
          .replace(/[\s:]+$/, '')
          .trim()
        return prefix ? `${prefix}: ${message}` : message
      }
    } catch {
      // Not JSON, or truncated mid-payload: fall through to the raw text.
    }
  }
  return text.length > PROVIDER_ERROR_MAX ? `${text.slice(0, PROVIDER_ERROR_MAX)}…` : text
}

const PROVIDER_ERROR_MAX = 1000

/** Spent once per turn to buy back a task that a malformed tool call cut short. */
const CONTINUE_AFTER_SILENT_TURN =
  'Your previous message ended without a reply and without a tool call, so nothing ran — the ' +
  'tool call you meant to make did not come through. Pick the task back up: either make that ' +
  'call again, with all of its required arguments, or write your answer.'

/**
 * Points in the turn where context occupancy has moved enough to be worth
 * re-reading: the prompt landing, each assistant reply (the only source of real
 * usage numbers), every tool result the reply pulled in, and compaction.
 */
const USAGE_SAMPLE_EVENTS = new Set([
  'turn_start',
  'message_end',
  'tool_execution_end',
  'compaction_end',
])

/** The Session Update rides on the user message only: the system prompt is the KV-cache prefix. */
async function withSessionUpdate(prompt: string, config: AgentModeTurnConfig): Promise<string> {
  if (!config.sessionRef || config.taskRun) return prompt
  try {
    const update = await takeSessionUpdate(config.sessionRef, {
      key: config.sessionId,
      ownPreset: config.presetName,
      workspaceDir: config.workspaceDir,
    })
    return update ? `${update}\n\n${prompt}` : prompt
  } catch (error) {
    logger.warn(`no Session Update for this turn: ${briefly(error)}`, LOG_SOURCE)
    return prompt
  }
}

export async function startAgentTurn(
  turnId: string,
  prompt: string,
  config: AgentModeTurnConfig,
): Promise<IpcMutationResult> {
  const { sessionId } = config
  if (agentTurns.has(sessionId)) {
    return { success: false, error: 'This session already has a turn in flight.' }
  }
  const sessionRef = config.sessionRef
  if (
    sessionRef &&
    !claimSessionTurn(sessionRef, {
      turnId,
      kind: 'agent',
      presetName: config.presetName,
      harnessSessionId: sessionId,
    })
  ) {
    return { success: false, error: SESSION_BUSY_MESSAGE }
  }
  const abortController = new AbortController()
  const turn: AgentTurn = { sessionId, turnId, abort: abortController, live: null }
  agentTurns.set(sessionId, turn)
  if (config.answer) noteAnswerTurn(sessionId, turnId, config.workspaceDir, config.answer)
  beginAgentTurnSnapshot(sessionId, turnId)
  emitAgentTurnState(sessionId, turnId, 'queued')
  const verbose = verboseLogging()
  const inSession = config.sessionRef
    ? trackAgentTurnInSession({
        sessionRef: config.sessionRef,
        presetName: config.presetName ?? '',
        workspaceDir: config.workspaceDir,
        prompt,
        ...(config.taskRun ? { taskRun: config.taskRun } : {}),
      })
    : null
  const translator = createStreamTranslator({
    emit: (chunk: StreamChunk) => emitAgentChunk(sessionId, turnId, chunk),
    onToolProgress: ({ toolCallId, toolName, text }) => {
      emitAgentToolProgress(sessionId, turnId, toolCallId, toolName, text)
    },
  })
  // Readiness runs when the turn takes its place, and again whenever it takes it
  // back after a pause, so a turn on another model swaps the server only while
  // nothing else is streaming.
  const ready = async () => {
    if (config.modelConfig.source === 'cloud') {
      setLastChatBackendLoadActive(false)
    } else if (config.readiness) {
      setTurnChatBackendLoad(config.readiness)
      await ensureChatBackendReady(config.readiness, {
        abortSignal: abortController.signal,
        skipGpuAdmission: true,
        conversationKey: sessionId,
      })
    }
  }
  const pause: TurnPause = {
    onUserWait: (waiting, reason) =>
      emitAgentTurnState(sessionId, turnId, waiting ? 'paused' : 'running', reason),
    onRequeued: () => emitAgentTurnState(sessionId, turnId, 'queued'),
    onHolding: () => emitAgentTurnState(sessionId, turnId, 'running'),
    readyAgain: async () => {
      emitAgentTurnState(sessionId, turnId, 'running')
      // Before the session exists the turn is still starting, and the start loads.
      if (!turn.live) return
      await ready()
      await reapplySession(turn.live, config)
      setAgentRunIdentity(agentRunIdentity(config))
    },
  }
  // Pi swallows a failing `context` handler and makes the request anyway, so a
  // reclaim that fails stops the session itself and the turn reports it.
  let reclaimFailure: unknown = null
  turn.reclaim = async () => {
    try {
      await reclaimTurnPlace(turnId, abortController.signal)
    } catch (error) {
      if (!abortController.signal.aborted) {
        reclaimFailure = error
        void turn.live?.session.abort()
      }
      throw error
    }
  }
  let failedWith: string | undefined
  let reply: string | undefined
  try {
    await submitTextRequest(
      {
        runId: turnId,
        conversationKey: sessionId,
        needsGpu: config.modelConfig.source !== 'cloud' && Boolean(config.readiness),
        joinsTurnQueue: true,
        work: 'agent',
        pause,
      },
      abortController.signal,
    )
    emitAgentTurnState(sessionId, turnId, 'running')
    // Pi's context hook, which reclaims later pauses, does not exist yet.
    if (await downloadedMissingReadinessModels(config, prompt, abortController.signal)) {
      await reclaimTurnPlace(turnId, abortController.signal)
    }
    await ready()
    const current = await ensureSession(config)
    turn.live = current
    // Per turn, not per session: a resumed session keeps its trace context but
    // its game may have been named since, and the preset can differ.
    setAgentRunIdentity(agentRunIdentity(config))
    let lastSample = ''
    const sampleUsage = () => {
      const summary = turnSummary(current.session)
      const fingerprint = JSON.stringify(summary)
      if (fingerprint === lastSample) return
      lastSample = fingerprint
      translator.update(summary)
    }
    const planning = watchPlanningPhase(current)
    turn.onEvent = (event) => {
      if (verbose) logEvent(event)
      planning.onEvent(event)
      translator.handle(event)
      if (USAGE_SAMPLE_EVENTS.has(event.type)) sampleUsage()
    }
    turn.notice = (text) => translator.notice(text)
    const onAbort = () => current.session.abort()
    abortController.signal.addEventListener('abort', onAbort, { once: true })
    try {
      // A failed model call is reported, not nudged: asking a model the provider
      // just refused to serve only produces the same refusal again.
      const failIfModelErrored = () => {
        if (reclaimFailure) throw reclaimFailure
        if (abortController.signal.aborted) return
        const failure = modelCallError(current.session)
        if (failure) throw new Error(failure)
      }
      await current.session.prompt(await withSessionUpdate(prompt, config))
      failIfModelErrored()
      // A session that plans first has only been asked for the plan so far; the
      // build is a second request, sent from here rather than by the user.
      if (!abortController.signal.aborted && (await handOffToBuild(current, planning))) {
        failIfModelErrored()
      }
      const stalled = () =>
        !abortController.signal.aborted && endedWithoutReplyOrToolCall(current.session)
      if (stalled()) {
        logger.warn('turn ended with neither a reply nor a tool call; nudging once', LOG_SOURCE)
        await current.session.prompt(CONTINUE_AFTER_SILENT_TURN)
        failIfModelErrored()
        if (stalled()) {
          translator.notice(
            'The model ended its turn without an answer and without running a tool, and did not ' +
              'pick the task back up when asked to continue. Send a message to carry on.',
          )
        }
      }
    } finally {
      abortController.signal.removeEventListener('abort', onAbort)
    }
    translator.finish(turnSummary(current.session))
    reply = finalReplyText(current.session)
    savePointer({
      sessionId: current.sessionId,
      workspaceDir: current.workspaceDir,
      sessionFilePath: current.session.getSessionStats().sessionFile ?? '',
      updatedAt: Date.now(),
    })
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Stopped before it took its place (or while readying): nothing to report.
    if (abortController.signal.aborted && !turn.live) {
      logger.info(`agent turn cancelled before it ran: ${message}`, LOG_SOURCE)
      return { success: false, error: message }
    }
    logger.error(`agent turn failed: ${message}`, LOG_SOURCE)
    // Deliver the failure as a stream error chunk BEFORE the finally block sends
    // turnDone (which closes the renderer-side stream).
    translator.fail(message)
    if (!abortController.signal.aborted) failedWith = message
    return { success: false, error: message }
  } finally {
    if (turnQueueHolder() === turnId) setTurnChatBackendLoad(null)
    finishTextRequest(turnId)
    if (agentTurns.get(sessionId) === turn) agentTurns.delete(sessionId)
    // Decided by the abort, not the thrown error: a stop or shutdown is never a failure.
    const end: AgentTurnEnd =
      failedWith !== undefined
        ? { sessionId, turnId, outcome: 'failed', error: failedWith }
        : abortController.signal.aborted
          ? { sessionId, turnId, outcome: 'cancelled' }
          : { sessionId, turnId, outcome: 'completed', reply }
    reportAgentTurnEnd(end)
    if (inSession) await inSession.settle(end)
    if (sessionRef) releaseSessionTurn(sessionRef, turnId)
    if (turn.live) await releaseTurnSession(turn.live)
    emitAgentTurnDone(sessionId, turnId)
  }
}

/** Abort the open turn of one Agent Session; `turnId` narrows it to that turn. */
export function cancelAgentTurn(sessionId: string, turnId?: string): void {
  const turn = agentTurns.get(sessionId)
  if (!turn || (turnId !== undefined && turn.turnId !== turnId)) return
  turn.abort.abort()
}

/** Abort every open agent turn — for shutdown only. */
export function cancelAllAgentTurns(): void {
  for (const turn of agentTurns.values()) turn.abort.abort()
}

/** Whether main holds any agent turn open — input to the hidden-window close policy. */
export function hasOpenAgentTurn(): boolean {
  return agentTurns.size > 0
}

/**
 * Hard reset: discard the live session AND its persisted pointer, and tear down
 * the workspace runtime (preview server + browser) so the next turn starts a
 * brand-new Pi conversation.
 */
export async function resetAgentSession(): Promise<void> {
  const sessionId = active?.sessionId ?? lastSessionId
  if (sessionId) cancelAgentTurn(sessionId)
  await endActiveSession()
  if (sessionId) clearPointer(sessionId)
  closeWorkspaceRuntime()
}

/**
 * Shut the agent down for app exit: the live session gets its extension
 * `session_shutdown` (persistent memory flushes there) and the preview
 * server/browser are closed. Unlike `resetAgentSession` the persisted pointer
 * survives, so the conversation resumes on the next launch.
 */
export async function shutdownAgentMode(): Promise<void> {
  cancelAllAgentTurns()
  await endActiveSession()
  closeWorkspaceRuntime()
  // Windows left open by any earlier session too: a hidden survivor keeps the
  // whole app alive (see closeAllBrowserSessions).
  closeAllBrowserSessions()
}

/**
 * Delete one archived session's main-side state: the persisted pointer and Pi's
 * session file. If the session is currently live it is disposed first.
 * Renderer-side state (the transcript record) is the agentMode store's business.
 */
export async function deleteAgentSession(
  sessionId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    cancelAgentTurn(sessionId)
    if (active?.sessionId === sessionId) {
      await endActiveSession()
      closeWorkspaceRuntime()
    }
    const pointer = readSessionStore()[sessionId]
    if (pointer) {
      if (pointer.sessionFilePath && fs.existsSync(pointer.sessionFilePath)) {
        fs.rmSync(pointer.sessionFilePath)
      }
      clearPointer(sessionId)
    }
    closeBrowserSession(sessionId)
    logger.info(`deleted agent session ${sessionId}`, LOG_SOURCE)
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(`failed to delete agent session ${sessionId}: ${message}`, LOG_SOURCE)
    return { success: false, error: message }
  }
}
