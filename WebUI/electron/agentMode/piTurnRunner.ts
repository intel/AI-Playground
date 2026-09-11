import fs from 'node:fs'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { appLoggerInstance } from '../logging/logger.ts'
import { closeAllBrowserSessions, closeBrowserSession } from '../subprocesses/agentBrowser.ts'
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
import { clearPointer, readSessionStore, savePointer } from './piSessionStore.ts'
import { briefly, LOG_SOURCE, verboseLogging } from './piAgentLog.ts'
import {
  active,
  activeAbort,
  lastSessionId,
  mainWin,
  setActiveAbort,
  setCurrentTurn,
  type ActiveSession,
} from './piAgentState.ts'
import { endActiveSession, ensureSession } from './piSessionLifecycle.ts'
import { agentRunIdentity } from './agentRunIdentity.ts'
import { setAgentRunIdentity } from '../laminarAttributes.ts'

const logger = appLoggerInstance

export type AgentModeStreamChunk = {
  turnId: string
  chunk: unknown
}

export type AgentModeToolProgress = {
  turnId: string
  toolCallId: string
  toolName: string
  text: string
}

export type AgentModeTurnResult = {
  success: boolean
  error?: string
}

function sendChunk(turnId: string, chunk: StreamChunk): void {
  mainWin?.webContents.send('agentMode:streamChunk', { turnId, chunk } as AgentModeStreamChunk)
}

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

export async function startAgentTurn(
  turnId: string,
  prompt: string,
  config: AgentModeTurnConfig,
): Promise<AgentModeTurnResult> {
  if (activeAbort) {
    return { success: false, error: 'An agent turn is already running.' }
  }
  const abortController = new AbortController()
  setActiveAbort(abortController)
  const verbose = verboseLogging()
  const translator = createStreamTranslator({
    emit: (chunk) => sendChunk(turnId, chunk),
    onToolProgress: ({ toolCallId, toolName, text }) => {
      mainWin?.webContents.send('agentMode:toolProgress', {
        turnId,
        toolCallId,
        toolName,
        text,
      } as AgentModeToolProgress)
    },
  })
  try {
    const current = await ensureSession(config)
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
    setCurrentTurn({
      turnId,
      onEvent: (event) => {
        if (verbose) logEvent(event)
        planning.onEvent(event)
        translator.handle(event)
        if (USAGE_SAMPLE_EVENTS.has(event.type)) sampleUsage()
      },
      notice: (text) => translator.notice(text),
    })
    const onAbort = () => current.session.abort()
    abortController.signal.addEventListener('abort', onAbort, { once: true })
    try {
      // A failed model call is reported, not nudged: asking a model the provider
      // just refused to serve only produces the same refusal again.
      const failIfModelErrored = () => {
        if (abortController.signal.aborted) return
        const failure = modelCallError(current.session)
        if (failure) throw new Error(failure)
      }
      await current.session.prompt(prompt)
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
    savePointer({
      sessionId: current.sessionId,
      workspaceDir: current.workspaceDir,
      sessionFilePath: current.session.getSessionStats().sessionFile ?? '',
      updatedAt: Date.now(),
    })
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`agent turn failed: ${message}`, LOG_SOURCE)
    // Deliver the failure as a stream error chunk BEFORE the finally block sends
    // turnDone (which closes the renderer-side stream).
    translator.fail(message)
    return { success: false, error: message }
  } finally {
    setCurrentTurn(null)
    setActiveAbort(null)
    mainWin?.webContents.send('agentMode:turnDone', { turnId })
  }
}

export function cancelAgentTurn(): void {
  activeAbort?.abort()
}

/**
 * Hard reset: discard the live session AND its persisted pointer, and tear down
 * the workspace runtime (preview server + browser) so the next turn starts a
 * brand-new Pi conversation.
 */
export async function resetAgentSession(): Promise<void> {
  cancelAgentTurn()
  const sessionId = active?.sessionId ?? lastSessionId
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
  cancelAgentTurn()
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
): Promise<{ success: boolean; error?: string }> {
  try {
    if (active?.sessionId === sessionId) {
      cancelAgentTurn()
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
