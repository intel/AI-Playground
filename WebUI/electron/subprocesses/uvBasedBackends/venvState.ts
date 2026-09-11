import fs from 'node:fs'
import path from 'node:path'
import { restoreTreeWritePermissions } from '../tools.ts'

/**
 * Path to a venv's own interpreter. A venv is only usable if this exists — the
 * `.venv` *directory* can survive as an empty husk (e.g. the Windows
 * uninstaller's `RMDir /r` cannot delete the deeply nested `site-packages`
 * paths a ComfyUI install creates, so it removes what it can and leaves the
 * rest behind), and treating that husk as an installed environment makes the
 * app auto-start a backend that cannot possibly boot.
 */
export function venvInterpreterPath(venvDir: string): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python')
}

/** True only for a venv that still has its interpreter — see `venvInterpreterPath`. */
export function venvIsUsable(venvDir: string): boolean {
  return fs.existsSync(venvInterpreterPath(venvDir))
}

export const isUsableVenv = venvIsUsable

export function requireUsableVenv(venvDir: string): void {
  if (venvIsUsable(venvDir)) return
  throw new Error(`Virtual environment at ${venvDir} is missing ${venvInterpreterPath(venvDir)}`)
}

/**
 * Remove a leftover `.venv` that has no interpreter. `uv venv --allow-existing`
 * preserves that directory instead of recreating python.exe — the state an
 * incomplete uninstall / app upgrade leaves behind (dir exists, spawn ENOENT).
 * Returns true when a broken venv was removed.
 */
export async function removeBrokenVenv(venvDir: string): Promise<boolean> {
  if (!fs.existsSync(venvDir)) return false
  if (venvIsUsable(venvDir)) return false

  await restoreTreeWritePermissions(venvDir)

  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.promises.rm(venvDir, { recursive: true, force: true })
      return true
    } catch (error) {
      lastError = error
      if ((error as NodeJS.ErrnoException)?.code === 'EACCES') {
        await restoreTreeWritePermissions(venvDir)
      }
      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
      }
    }
  }
  throw lastError
}
