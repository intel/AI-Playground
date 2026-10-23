import type { BrowserWindow } from 'electron'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { AgentToolAccess } from './piToolOperations.ts'
import type { PlanningEnd } from './planningPhase.ts'

export type ActiveSession = {
  configKey: string
  sessionId: string
  /** Resolved (realpath) workspace folder — the key for session persistence. */
  workspaceDir: string
  session: AgentSession
  access: AgentToolAccess
  /** Preview URL the session's instructions were built with. */
  instructedBaseUrl: string | null
  unsubscribe: () => void
  /**
   * The sampling bag the live model holds. Pi re-reads it per request, so
   * `planningPhase.ts` can end thinking mid-turn by mutating it.
   */
  samplingParams?: Record<string, unknown>
  /**
   * What ends this session's thinking phase, or null when it thinks throughout
   * (the user's setting, or a capability with no plan step of its own).
   */
  planningEnd: PlanningEnd | null
  /**
   * The build request that follows the plan, for a session whose first turn is
   * split in two (`AgentCapability.planHandoff`). Null for every other session.
   */
  planHandoff: string | null
  /** Whether the plan step is still ahead: true until the first turn has run. */
  planPending: boolean
}

export type CurrentTurn = {
  turnId: string
  onEvent: (event: AgentSessionEvent) => void
  /** Host-side text (an extension's slash command output) for the transcript. */
  notice?: (text: string) => void
}

export let mainWin: BrowserWindow | null = null
export let active: ActiveSession | null = null
export let lastSessionId: string | null = null
export let currentTurn: CurrentTurn | null = null
export let activeAbort: AbortController | null = null

export function setMainWin(win: BrowserWindow | null): void {
  mainWin = win
}

export function setActive(next: ActiveSession | null): void {
  active = next
}

export function setLastSessionId(id: string | null): void {
  lastSessionId = id
}

export function setCurrentTurn(turn: CurrentTurn | null): void {
  currentTurn = turn
}

export function setActiveAbort(controller: AbortController | null): void {
  activeAbort = controller
}
