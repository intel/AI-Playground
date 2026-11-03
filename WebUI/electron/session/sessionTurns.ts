import { emitSessionTurns } from '../kernel/kernelBus'
import type { SessionTurn, SessionTurns } from '@/types/sessionIpc'

/**
 * A Session admits one turn in flight at a time, whatever its kind; the Turn Queue
 * (ADR-0002) still decides when that turn runs. Turns outside a Session (Home Agent)
 * and media nested in a chat or agent turn never claim one.
 */

export const SESSION_BUSY_MESSAGE = 'This Session already has a turn in flight.'

let turns: SessionTurns = {}

function publish(next: SessionTurns): void {
  turns = next
  emitSessionTurns(turns)
}

/** False when the Session already has a turn; the caller refuses its turn. */
export function claimSessionTurn(sessionId: string, turn: SessionTurn): boolean {
  if (turns[sessionId]) return false
  publish({ ...turns, [sessionId]: { ...turn } })
  return true
}

export function releaseSessionTurn(sessionId: string, turnId: string): void {
  if (turns[sessionId]?.turnId !== turnId) return
  const { [sessionId]: _released, ...rest } = turns
  publish(rest)
}

export function sessionTurnOf(sessionId: string): SessionTurn | undefined {
  return turns[sessionId]
}

/** Runs `run` as the Session's turn, or returns `refused` when another holds it. */
export async function inSessionTurn<T>(
  sessionId: string | undefined,
  turn: SessionTurn,
  run: () => Promise<T>,
  refused: () => T,
): Promise<T> {
  if (!sessionId) return run()
  if (!claimSessionTurn(sessionId, turn)) return refused()
  try {
    return await run()
  } finally {
    releaseSessionTurn(sessionId, turn.turnId)
  }
}

export function resetSessionTurnsForTest(): void {
  turns = {}
}
