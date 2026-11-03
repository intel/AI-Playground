import fs from 'node:fs/promises'
import path from 'node:path'
import { serializeSession } from '../persist/sessionFiles'
import { readHistoryEntries } from './sessionHistory'
import { listSessions, sessionPaths } from './sessions'
import { sessionMediaUrl } from '@/lib/comfyWorkflow'
import type {
  ArtifactMediaType,
  HistoryEntry,
  NewestArtifact,
  SessionArtifact,
  SessionSummary,
} from '@/types/sessionIpc'

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile()
  } catch {
    return false
  }
}

async function artifactsOf(session: SessionSummary): Promise<SessionArtifact[]> {
  const root = sessionPaths(session.id).root
  const entries = await readHistoryEntries(session.id)
  const listed = entries.flatMap((entry: HistoryEntry) =>
    entry.artifacts.map((artifact) => ({
      sessionId: session.id,
      sessionTitle: session.title,
      entryId: entry.id,
      timestamp: entry.timestamp,
      preset: entry.preset,
      kind: entry.kind,
      prompt: entry.prompt,
      path: artifact.path,
      mediaType: artifact.mediaType,
      url: sessionMediaUrl(session.id, artifact.path),
    })),
  )
  const present = await Promise.all(
    listed.map((artifact) => isFile(path.join(root, artifact.path))),
  )
  return listed.filter((_artifact, index) => present[index])
}

/** Every artifact of every Session whose file still exists, newest History Entry first. */
export async function listAllArtifacts(): Promise<SessionArtifact[]> {
  const sessions = await listSessions()
  const perSession = await Promise.all(sessions.map(artifactsOf))
  return perSession.flat().sort((a, b) => b.timestamp - a.timestamp)
}

/** URLs of the Session's recorded artifacts whose file is gone; the timeline shows them as deleted. */
export async function missingArtifactUrls(sessionId: string): Promise<string[]> {
  const root = sessionPaths(sessionId).root
  const artifacts = (await readHistoryEntries(sessionId)).flatMap((entry) => entry.artifacts)
  const present = await Promise.all(
    artifacts.map((artifact) => isFile(path.join(root, artifact.path))),
  )
  return artifacts
    .filter((_artifact, index) => !present[index])
    .map((artifact) => sessionMediaUrl(sessionId, artifact.path))
}

function resolveArtifactFile(sessionId: string, relativePath: string): string {
  const filesDir = path.resolve(sessionPaths(sessionId).filesDir)
  const target = path.resolve(sessionPaths(sessionId).root, relativePath)
  const relative = path.relative(filesDir, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`not an artifact of ${sessionId}: ${relativePath}`)
  }
  return target
}

/** Deletes the artifact's file only: its History Entry stays, so the Session still remembers it. */
export async function deleteArtifact(sessionId: string, relativePath: string): Promise<void> {
  const file = resolveArtifactFile(sessionId, relativePath)
  await serializeSession(sessionId, async () => {
    try {
      if (!(await fs.lstat(file)).isFile()) throw new Error(`not a file: ${relativePath}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    await fs.rm(file)
  })
}

/** The Session's newest artifact of a media type, from any preset, whose file still exists. */
export async function newestArtifact(
  sessionId: string,
  mediaType: ArtifactMediaType,
): Promise<NewestArtifact | null> {
  const entries = await readHistoryEntries(sessionId)
  for (let i = entries.length - 1; i >= 0; i--) {
    const artifacts = entries[i].artifacts.filter((artifact) => artifact.mediaType === mediaType)
    for (let j = artifacts.length - 1; j >= 0; j--) {
      const relativePath = artifacts[j].path
      let file: string
      try {
        file = resolveArtifactFile(sessionId, relativePath)
      } catch {
        continue
      }
      if (!(await isFile(file))) continue
      return {
        entryId: entries[i].id,
        path: relativePath,
        url: sessionMediaUrl(sessionId, relativePath),
      }
    }
  }
  return null
}
