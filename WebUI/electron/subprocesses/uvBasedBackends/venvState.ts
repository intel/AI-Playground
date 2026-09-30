import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { restoreTreeWritePermissions } from '../tools.ts'

const execFileAsync = promisify(execFile)

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

function venvIsWritable(venvDir: string): boolean {
  const probe = path.join(venvDir, `.aipg-write-probe-${process.pid}`)
  try {
    fs.writeFileSync(probe, '')
    fs.rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/** `pyvenv.cfg` `home` is the base interpreter. Missing is fine; unreadable is not. */
function venvHomeIsReadable(venvDir: string): boolean {
  let raw: string
  try {
    raw = fs.readFileSync(path.join(venvDir, 'pyvenv.cfg'), 'utf-8')
  } catch {
    return true
  }
  const line = raw.split(/\r?\n/).find((entry) => entry.trim().toLowerCase().startsWith('home'))
  if (!line) return true
  const value = line.slice(line.indexOf('=') + 1).trim()
  if (!value) return true
  const home = path.isAbsolute(value) ? value : path.resolve(venvDir, value)
  try {
    fs.readdirSync(home)
    return true
  } catch {
    return false
  }
}

/**
 * True when this account can boot and maintain the venv. Another Windows
 * account's tree still contains python.exe, but repair cannot delete it, and
 * `home` may point at that account's private Python.
 */
export function venvIsUsable(venvDir: string): boolean {
  if (!fs.existsSync(venvInterpreterPath(venvDir))) return false
  if (!venvIsWritable(venvDir)) return false
  return venvHomeIsReadable(venvDir)
}

export const isUsableVenv = venvIsUsable

export function requireUsableVenv(venvDir: string): void {
  if (venvIsUsable(venvDir)) return
  const interpreter = venvInterpreterPath(venvDir)
  if (!fs.existsSync(interpreter)) {
    throw new Error(`Virtual environment at ${venvDir} is missing ${interpreter}`)
  }
  throw new Error(
    `Virtual environment at ${venvDir} is not writable by this account, or its base Python is not readable`,
  )
}

function toWindowsLongPath(target: string): string {
  const resolved = path.resolve(target)
  if (resolved.startsWith('\\\\?\\')) return resolved
  if (resolved.startsWith('\\\\')) return `\\\\?\\UNC\\${resolved.slice(2)}`
  return `\\\\?\\${resolved}`
}

async function clearWindowsReadOnly(target: string): Promise<void> {
  try {
    await execFileAsync('attrib', ['-R', '/S', '/D', target], { windowsHide: true })
  } catch {
    // Best-effort. Deep site-packages trees are still removed via the long-path prefix.
  }
}

/**
 * Delete a venv tree. Windows removal clears the read-only bit and uses the
 * `\\?\` prefix so a deep ComfyUI site-packages path does not fail the way
 * `RMDir` does.
 */
export async function removeVenvTree(venvDir: string): Promise<void> {
  if (!fs.existsSync(venvDir)) return

  await restoreTreeWritePermissions(venvDir)
  if (process.platform === 'win32') await clearWindowsReadOnly(venvDir)

  const rmTarget = process.platform === 'win32' ? toWindowsLongPath(venvDir) : venvDir
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.promises.rm(rmTarget, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'EACCES' || code === 'EPERM') {
        await restoreTreeWritePermissions(venvDir)
        if (process.platform === 'win32') await clearWindowsReadOnly(venvDir)
      }
      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
      }
    }
  }
  throw lastError
}

/**
 * Remove a leftover `.venv` this account cannot use: no interpreter, not
 * writable, or `pyvenv.cfg` `home` pointing at a Python this account cannot
 * read. `uv venv --allow-existing` would keep that directory. Returns true
 * when a broken venv was removed.
 */
export async function removeBrokenVenv(venvDir: string): Promise<boolean> {
  if (!fs.existsSync(venvDir)) return false
  if (venvIsUsable(venvDir)) return false
  await removeVenvTree(venvDir)
  return true
}
