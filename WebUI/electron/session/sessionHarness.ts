import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getGamesDir } from '../persist/userDataPaths'
import { mutateSession, onSessionDeleted, sessionPaths } from './sessions'
import type { HarnessGameWorkspace, HarnessSessionRef, SessionFile } from '@/types/sessionIpc'

export function mintHarnessSessionId(): string {
  return `aipg-agent-${randomUUID()}`
}

function requireGameFolder(dir: string): string {
  const resolved = path.resolve(dir)
  const inLibrary = path.relative(path.resolve(getGamesDir()), resolved)
  if (!inLibrary || inLibrary.startsWith('..') || path.isAbsolute(inLibrary)) {
    throw new Error(`not a game folder in the games library: ${dir}`)
  }
  return resolved
}

function withGameHarness(
  current: SessionFile,
  presetName: string,
  game: HarnessGameWorkspace,
  gameDir: string | undefined,
): SessionFile {
  const existing = current.harnessSessions[presetName]
  const replace = !!game.fresh && !!existing
  if (existing && !replace && (current.harnessWorkspaces[presetName] || !gameDir)) return current
  return {
    ...current,
    harnessSessions: {
      ...current.harnessSessions,
      [presetName]: existing && !replace ? existing : mintHarnessSessionId(),
    },
    harnessWorkspaces: gameDir
      ? { ...current.harnessWorkspaces, [presetName]: gameDir }
      : current.harnessWorkspaces,
    retiredHarnessSessions: replace
      ? [...current.retiredHarnessSessions, existing]
      : current.retiredHarnessSessions,
  }
}

/**
 * One Harness Session per (Session, agent preset), so Agent → Image Gen → Agent
 * continues the same agent conversation. The Session stores only the pointer;
 * Pi's own session files stay where the Pi harness keeps them. The Agent preset
 * works in the Session's `files/`; a games preset in its game folder, which lives
 * in the games library and is never the Session's to delete.
 */
export async function harnessSessionFor(
  sessionId: string,
  presetName: string,
  game?: HarnessGameWorkspace,
): Promise<HarnessSessionRef> {
  if (game) {
    const gameDir = game.gameDir ? requireGameFolder(game.gameDir) : undefined
    const file = await mutateSession(sessionId, (current) =>
      withGameHarness(current, presetName, game, gameDir),
    )
    return {
      harnessSessionId: file.harnessSessions[presetName],
      workspaceDir: file.harnessWorkspaces[presetName] ?? '',
    }
  }
  const file = await mutateSession(sessionId, (current) =>
    current.harnessSessions[presetName]
      ? current
      : {
          ...current,
          harnessSessions: {
            ...current.harnessSessions,
            [presetName]: mintHarnessSessionId(),
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
    const ids = [
      ...Object.values(deleted?.harnessSessions ?? {}),
      ...(deleted?.retiredHarnessSessions ?? []),
      ...(deleted?.taskRunHarnessSessions ?? []),
    ]
    for (const harnessSessionId of ids) {
      await cleanup(harnessSessionId)
    }
  })
}
