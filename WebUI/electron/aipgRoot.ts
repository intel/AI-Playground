import { app } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { readInstallConfig } from './installConfig.ts'

/**
 * Resolves the packaged "resources root" — the directory the app treats as both
 * its bundled resources AND its writable working tree (Python interpreter,
 * backend venvs, LlamaCPP/ComfyUI installs, preset edits, settings, logs).
 *
 * The install directory is used directly when it is writable — the default for
 * a per-user Windows install and for dev — so this is simply
 * `process.resourcesPath` (unchanged behaviour).
 *
 * When the install directory is **not** writable we relocate the root to a
 * per-user writable directory and seed it once (per app version) from the
 * read-only bundle. Two cases hit this path:
 *   - Linux: the app ships as a read-only bundle (AppImage squashfs mount, or a
 *     `/opt` install owned by root), so writes fail with EROFS/ENOENT.
 *   - Windows all-users install: the app lives under `Program Files` and a
 *     standard (unelevated) user cannot write there.
 * Runtime data created later (venvs, models, `python-interpreter/`, …) is never
 * part of the bundle, so it is preserved across reseeds.
 *
 * **Shared all-users install** (`install-config.json` = `"shared"`): the
 * resources root instead points at the machine-wide
 * `%PUBLIC%/AI Playground/resources` (under `C:\Users\Public`), which is
 * writable by all users out of the box via its default ACLs. The heavy
 * artifacts are provisioned there once (by whichever user
 * launches first) and read by everyone else. Each user's *mutable* config
 * (settings, logs, model_config, mcp, embeddingCache, ComfyUI scratch) is kept
 * private via `writableConfigRoot()` so users do not clobber each other. See
 * `userConfig.ts`.
 */

/** `%PUBLIC%` (`C:\Users\Public`, or a sensible fallback) — machine-wide, world-writable by default. */
const publicDir = (): string => process.env.PUBLIC?.trim() || 'C:\\Users\\Public'

/**
 * Whether this is a Windows all-users install configured to share the heavy
 * runtime artifacts across users. Cached — the install config never changes
 * while the app is running.
 */
let sharedMode: boolean | undefined
const sharedModeActive = (): boolean => {
  if (sharedMode !== undefined) return sharedMode
  sharedMode = process.platform === 'win32' && readInstallConfig()?.modelFolderMode === 'shared'
  return sharedMode
}

/**
 * Machine-wide shared resources root. The base directory defaults to
 * `%PUBLIC%/AI Playground` but the admin can point it elsewhere (e.g. a
 * roomier drive) via the installer's folder picker — see `installConfig.ts`.
 * The `resources` leaf is always appended so relative model paths in
 * `model_config.json` (`./resources/models/...`), anchored to `path.dirname(root)`,
 * resolve to `<base>/resources/models`, exactly mirroring the per-user layout.
 */
const sharedInstallRoot = (): string => {
  const base =
    readInstallConfig()?.sharedResourcesDir?.trim() || path.join(publicDir(), 'AI Playground')
  return path.join(base, 'resources')
}

/**
 * Per-user writable root. No spaces in the path — Python venvs dislike them.
 * `%LOCALAPPDATA%/ai-playground/resources` on Windows,
 * `$XDG_DATA_HOME/ai-playground/resources` (or `~/.local/share/...`) elsewhere.
 */
const writableUserRoot = (): string => {
  if (process.platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(localAppData, 'ai-playground', 'resources')
  }
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share')
  return path.join(dataHome, 'ai-playground', 'resources')
}

/**
 * Whether `process.resourcesPath` is writable by the current user. Per-user
 * Windows installs and dev checkouts are writable; a read-only Linux bundle and
 * an all-users `Program Files` install run unelevated are not. Electron ships
 * with UAC file/registry virtualization disabled, so a failed write to
 * `Program Files` surfaces as an error here instead of being silently
 * redirected to a VirtualStore. Probed once and cached.
 */
let installDirWritable: boolean | undefined
const isInstallDirWritable = (): boolean => {
  if (installDirWritable !== undefined) return installDirWritable
  const probe = path.join(process.resourcesPath, `.aipg-write-probe-${process.pid}`)
  try {
    fs.writeFileSync(probe, '')
    fs.rmSync(probe, { force: true })
    installDirWritable = true
  } catch {
    installDirWritable = false
  }
  return installDirWritable
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
 * The packaged resources root. When the install directory is writable this is
 * `process.resourcesPath`; otherwise it is a per-user writable directory
 * (seeded from the read-only bundle on first use). Safe to call before `app` is
 * ready.
 *
 * Only meaningful when `app.isPackaged` is true; callers keep their own
 * development-mode paths for the unpackaged case.
 */
export function packagedResourcesRoot(): string {
  if (!app.isPackaged) return process.resourcesPath

  // Shared all-users install: use the machine-wide root and seed it once from
  // the read-only bundle. The root lives under C:\Users\Public and is writable
  // by all users by default, so the first user provisions it (bundle + venvs +
  // backends + models) and later users read it; a stale seed marker after an
  // app update triggers a reseed.
  const root = sharedModeActive() ? sharedInstallRoot() : writableUserRoot()

  if (sharedModeActive() || !isInstallDirWritable()) {
    if (!seeded) {
      try {
        seedWritableRoot(root)
      } catch (e) {
        // Logger may not exist this early; fall back to console so the failure is
        // visible without crashing startup.
        console.error('[aipgRoot] failed to seed resources dir:', e)
      }
      seeded = true
    }
    return root
  }

  // Writable install dir (per-user Windows install, dev): use it directly.
  return process.resourcesPath
}

/**
 * Root for this user's *mutable* config — settings, logs, model_config, mcp,
 * embeddingCache and ComfyUI scratch. In a shared all-users install this is a
 * private per-user directory so users never overwrite each other's config; in
 * every other mode it equals `packagedResourcesRoot()`, keeping current
 * behaviour unchanged. Callers seed individual files from the shared defaults on
 * first use (see `userConfig.ts`).
 */
export function writableConfigRoot(): string {
  if (app.isPackaged && sharedModeActive()) {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(localAppData, 'ai-playground', 'config')
  }
  return packagedResourcesRoot()
}
