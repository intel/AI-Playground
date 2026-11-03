import {
  agentSessionStatus,
  pausedStatusLabel,
  queueOrdinal,
  type AgentSessionStatus,
  type SessionDownload,
} from '@/assets/js/store/historyEntries'
import type { AgentTurnState, PauseReason } from '@/types/kernelEvents'
import type { SessionTurn } from '@/types/sessionIpc'

export type SessionRowStatus = ReturnType<typeof agentSessionStatus>

export type SessionRowMarker = { status: AgentSessionStatus; label: string; short?: string }

/**
 * A Sessions panel row's status: its turn in flight (its queue place, and for an agent
 * turn what it waits on), else whether a turn ended while it was not open.
 */
export function sessionRowStatus(input: {
  turn?: SessionTurn
  agentTurn?: { state: AgentTurnState; queuePosition?: number | null; pauseReason?: PauseReason }
  mediaQueued?: boolean
  mediaQueuePosition?: number
  download?: SessionDownload | null
  unseen?: 'done' | 'failed'
}): SessionRowStatus {
  const { turn } = input
  const state: AgentTurnState = input.mediaQueued ? 'queued' : 'running'
  const live = turn
    ? turn.kind === 'agent' && input.agentTurn
      ? input.agentTurn
      : { state, queuePosition: input.mediaQueuePosition }
    : undefined
  return agentSessionStatus({
    turn: live,
    unseen: turn ? undefined : input.unseen,
    download: turn ? input.download : null,
  })
}

export function sessionRowMarker(
  row: SessionRowStatus,
  labels: Record<string, string>,
  locale: string,
): SessionRowMarker | null {
  const { status, queuePosition, pauseReason, download } = row
  switch (status) {
    case 'running':
      return { status, label: labels.HISTORY_STATUS_RUNNING }
    case 'queued':
      return queuePosition
        ? {
            status,
            label: labels.HISTORY_STATUS_QUEUED_AT.replace('{position}', String(queuePosition)),
            short: queueOrdinal(queuePosition, locale, labels),
          }
        : { status, label: labels.HISTORY_STATUS_QUEUED }
    case 'paused':
      return { status, ...pausedStatusLabel(pauseReason, labels) }
    case 'downloading':
      if (!download || download.queued) {
        return { status, label: labels.HISTORY_STATUS_DOWNLOAD_QUEUED }
      }
      return {
        status,
        label: labels.HISTORY_STATUS_DOWNLOADING.replace('{percent}', String(download.percent)),
        short: `${download.percent}%`,
      }
    case 'unseen':
      return { status, label: labels.HISTORY_STATUS_UNSEEN }
    case 'unseenFailed':
      return { status, label: labels.HISTORY_STATUS_UNSEEN_FAILED }
  }
  return null
}
