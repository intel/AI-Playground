import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import * as filesystem from 'fs-extra'

const execFileAsync = promisify(execFile)

export const binary = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name)

/**
 * Recursively restore owner write (and execute on directories) permissions across
 * a tree. On Linux/macOS, unlink()/rmdir() require write permission on the *parent*
 * directory, so a read-only directory in an extracted archive (e.g. an OVMS or
 * llama.cpp release tarball) makes removal fail with EACCES even though the current
 * user owns the files. Stripping the read-only bit before removal lets a reinstall
 * proceed instead of aborting. Best-effort: individual chmod/readdir failures are
 * ignored so removal can still attempt to continue.
 *
 * No-op on Windows, where the read-only attribute is handled by fs-extra/rimraf
 * itself and the failure mode is EPERM/EBUSY (open handles), not EACCES.
 */
export async function restoreTreeWritePermissions(target: string): Promise<void> {
  if (process.platform === 'win32') return
  let stat: filesystem.Stats
  try {
    stat = await filesystem.lstat(target)
  } catch {
    return
  }
  // Don't follow symlinks: chmod would alter the link target, and unlinking the
  // link itself only needs the parent dir writable (handled by the recursion).
  if (stat.isSymbolicLink()) return
  try {
    // Directories need owner rwx (w+x to delete/traverse children); files rw.
    const extraBits = stat.isDirectory() ? 0o700 : 0o600
    await filesystem.chmod(target, stat.mode | extraBits)
  } catch {
    // Best-effort; proceed even if a single chmod fails.
  }
  if (stat.isDirectory()) {
    // chmod the dir first (above) so it is readable before we list it.
    const entries = await filesystem.readdir(target).catch(() => [] as string[])
    for (const entry of entries) {
      await restoreTreeWritePermissions(path.join(target, entry))
    }
  }
}

// Use execFile (no shell) so paths containing spaces are passed correctly on all platforms.
const winExtract = (zipPath: string, extractTo: string) =>
  execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractTo}' -Force`,
  ])
const unixExtract = (zipPath: string, extractTo: string) =>
  execFileAsync('tar', ['-xf', zipPath, '-C', extractTo])
export const extract = process.platform === 'win32' ? winExtract : unixExtract
