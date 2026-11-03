import fs from 'node:fs/promises'
import { deleteAgentTasksOfSession } from '../persist/agentTaskFiles'
import { mintHarnessSessionId } from './sessionHarness'
import { mutateSession, onSessionDeleted, sessionPaths } from './sessions'
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
  const { filesDir } = sessionPaths(sessionId)
  await fs.mkdir(filesDir, { recursive: true })
  return { harnessSessionId, workspaceDir: filesDir }
}

/** Deleting a Session deletes its Tasks; returns the unsubscribe. */
export function deleteTasksWithSession(): () => void {
  return onSessionDeleted((id) => deleteAgentTasksOfSession(id))
}
