import fs from 'node:fs'
import path from 'node:path'

// ── what a media tool actually produced ──────────────────────────────────────
//
// The generator names its own files, so a workspace path under `generated/` is
// only real once a call has reported it. A model that was shown an example
// filename passes that example back instead, and when the file turns out not to
// exist it reaches for the shell to create one — which is how a game ended up
// with a cover the model had written byte by byte. Recording the paths the media
// tools saved is what lets a consumer tell those two apart.

const savedByWorkspace = new Map<string, Set<string>>()

/** Files already on disk when the app started cannot be ones invented this run. */
const PROCESS_START = Date.now()

function workspaceKey(workspaceDir: string): string {
  return path.resolve(workspaceDir)
}

export function normalizeWorkspacePath(relativePath: string): string {
  return path.posix.normalize(relativePath.replace(/\\/g, '/').replace(/^\.\//, ''))
}

export function noteGeneratedMedia(workspaceDir: string, relativePaths: string[]): void {
  const key = workspaceKey(workspaceDir)
  const known = savedByWorkspace.get(key) ?? new Set<string>()
  for (const relativePath of relativePaths) known.add(normalizeWorkspacePath(relativePath))
  savedByWorkspace.set(key, known)
}

/**
 * Whether this file can be taken for generated media: a media tool reported it
 * this session, or it predates the session and so came from an earlier run.
 */
export function isGeneratedMedia(workspaceDir: string, relativePath: string): boolean {
  const normalized = normalizeWorkspacePath(relativePath)
  if (savedByWorkspace.get(workspaceKey(workspaceDir))?.has(normalized)) return true
  if (!normalized.startsWith('generated/')) return false
  try {
    return fs.statSync(path.resolve(workspaceDir, normalized)).mtimeMs < PROCESS_START
  } catch {
    return false
  }
}

export function resetGeneratedMediaForTest(): void {
  savedByWorkspace.clear()
}
