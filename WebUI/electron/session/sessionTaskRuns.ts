import { deleteAgentTasksOfSession } from '../persist/agentTaskFiles'
import { ensureSessionFilesDir } from '../persist/sessionMediaFiles'
import { mintHarnessSessionId } from './sessionHarness'
import { mutateSession, onSessionDeleted } from './sessions'
import type { HarnessSessionRef } from '@/types/sessionIpc'

/**
 * A Task Run's own Harness Session: fresh every run, so a run carries no context
 * from the Session or from earlier runs, and working in the Session's `files/`.
 */
export async function taskRunHarnessFor(sessionId: string): Promise<HarnessSessionRef> {
  const harnessSessionId = mintHarnessSessionId()
  await mutateSession(sessionId, (current) => ({
    ...current,
    taskRunHarnessSessions: [...current.taskRunHarnessSessions, harnessSessionId],
  }))
  return { harnessSessionId, workspaceDir: await ensureSessionFilesDir(sessionId) }
}

/** Deleting a Session deletes its Tasks; returns the unsubscribe. */
export function deleteTasksWithSession(): () => void {
  return onSessionDeleted((id) => deleteAgentTasksOfSession(id))
}
