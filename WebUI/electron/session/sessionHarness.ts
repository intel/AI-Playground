import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { mutateSession, onSessionDeleted, sessionPaths } from './sessions'
import type { HarnessSessionRef } from '@/types/sessionIpc'

/**
 * One Harness Session per (Session, agent preset), so Agent → Image Gen → Agent
 * continues the same agent conversation. The Session stores only the pointer;
 * Pi's own session files stay where the Pi harness keeps them.
 */
export async function harnessSessionFor(
  sessionId: string,
  presetName: string,
): Promise<HarnessSessionRef> {
  const file = await mutateSession(sessionId, (current) =>
    current.harnessSessions[presetName]
      ? current
      : {
          ...current,
          harnessSessions: {
            ...current.harnessSessions,
            [presetName]: `aipg-agent-${randomUUID()}`,
          },
        },
  )
  const { filesDir } = sessionPaths(sessionId)
  await fs.mkdir(filesDir, { recursive: true })
  return { harnessSessionId: file.harnessSessions[presetName], workspaceDir: filesDir }
}

export type HarnessCleanup = (harnessSessionId: string) => Promise<unknown>

/** Deleting a Session deletes its Harness Sessions' Pi files and records; returns the unsubscribe. */
export function cleanUpHarnessSessionsOnDelete(cleanup: HarnessCleanup): () => void {
  return onSessionDeleted(async (_id, deleted) => {
    for (const harnessSessionId of Object.values(deleted?.harnessSessions ?? {})) {
      await cleanup(harnessSessionId)
    }
  })
}
