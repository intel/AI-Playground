import { app } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

/**
 * Resolves the packaged "resources root" — the directory the app treats as both
 * its bundled resources AND its writable working tree (Python interpreter,
 * backend venvs, LlamaCPP/ComfyUI installs, preset edits, settings, logs).
 *
 * On Windows the per-user install directory is writable, so this is simply
 * `process.resourcesPath` (unchanged behaviour).
 *
 * On Linux the app ships as a **read-only** bundle (AppImage squashfs mount, or
 * a `/opt` install owned by root), so writing backends into `process.resourcesPath`
 * fails with EROFS/ENOENT. To support this we relocate the root to a per-user
 * writable directory and seed it once (per app version) from the read-only
 * bundle. Runtime data created later (venvs, models, `python-interpreter/`, …) is
 * never part of the bundle, so it is preserved across reseeds.
 */

const isLinuxPackaged = (): boolean => app.isPackaged && process.platform === 'linux'

/** `$XDG_DATA_HOME/ai-playground` (no spaces — Python venvs dislike spaces). */
const writableLinuxRoot = (): string => {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share')
  return path.join(dataHome, 'ai-playground', 'resources')
}

// Binaries that must keep their executable bit after being copied out of the
// read-only bundle (filenames are kept as `*.exe` on all platforms by the
// fetch-external-resources script for naming consistency).
const EXECUTABLE_RESOURCE_FILES = ['uv.exe', 'uvw.exe', 'uvx.exe', '7zr.exe']

let seeded = false

function seedWritableRoot(root: string): void {
  const bundle = process.resourcesPath
  const markerPath = path.join(root, '.aipg-seed-version')
  const currentVersion = app.getVersion()

  let alreadySeeded = false
  try {
    alreadySeeded = fs.readFileSync(markerPath, 'utf-8').trim() === currentVersion
  } catch {
    alreadySeeded = false
  }
  if (alreadySeeded) return

  fs.mkdirSync(root, { recursive: true })

  // Copy the bundled (shipped) files over the writable root. `force: true`
  // refreshes shipped files on app update; runtime-created directories that are
  // not part of the bundle are left untouched because cpSync only walks `bundle`.
  // Skip the packed Electron app itself (`app.asar`, `app.asar.unpacked`) — it is
  // not part of the backend working tree and would needlessly bloat the copy.
  fs.cpSync(bundle, root, {
    recursive: true,
    force: true,
    filter: (src) => {
      const name = path.basename(src)
      return name !== 'app.asar' && name !== 'app.asar.unpacked'
    },
  })

  // cpSync does not reliably preserve the executable bit across filesystems,
  // so restore it for the bundled binaries the backends spawn.
  for (const name of EXECUTABLE_RESOURCE_FILES) {
    const file = path.join(root, name)
    try {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o755)
    } catch {
      // best effort
    }
  }

  fs.writeFileSync(markerPath, currentVersion, 'utf-8')
}

/**
 * The packaged resources root. Writable on Linux (seeded on first use), and
 * `process.resourcesPath` on Windows/macOS. Safe to call before `app` is ready.
 *
 * Only meaningful when `app.isPackaged` is true; callers keep their own
 * development-mode paths for the unpackaged case.
 */
export function packagedResourcesRoot(): string {
  if (!isLinuxPackaged()) return process.resourcesPath

  const root = writableLinuxRoot()
  if (!seeded) {
    try {
      seedWritableRoot(root)
    } catch (e) {
      // Logger may not exist this early; fall back to console so the failure is
      // visible without crashing startup.
      console.error('[aipgRoot] failed to seed writable resources dir:', e)
    }
    seeded = true
  }
  return root
}
