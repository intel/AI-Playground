import fs from 'node:fs'
import path from 'node:path'

/**
 * Reads the machine-wide install configuration written by the all-users
 * installer. It records a single choice: whether the heavy runtime artifacts
 * (Python interpreter, backend venvs, backend installs and models — tens of GB)
 * are shared across all users of the machine or kept per-user.
 *
 * The installer writes a small JSON file to a machine-readable location
 * (`%PUBLIC%/AI Playground/install-config.json`, i.e. under `C:\Users\Public`,
 * on Windows). A per-user install writes no such file, so `readInstallConfig()`
 * returns null and the app keeps its default per-user paths.
 *
 * In "shared" mode `aipgRoot.ts` points the resources root at
 * `%PUBLIC%/AI Playground/resources`. `C:\Users\Public` inherits permissive
 * all-users ACLs out of the box, so it is read/write for every user without the
 * installer having to grant a custom ACL. Each user's mutable config is
 * relocated to a private per-user folder. See `aipgRoot.ts` and `userConfig.ts`.
 */

export type ModelFolderMode = 'shared' | 'per-user'

export interface InstallConfig {
  modelFolderMode: ModelFolderMode
  /**
   * Admin-chosen base directory for the shared resources tree (the parent of
   * the `resources` folder). Only meaningful in "shared" mode; absent means the
   * default `%PUBLIC%/AI Playground`. Lets the admin place the tens-of-GB
   * shared tree on a different drive, mirroring the customizable install folder.
   */
  sharedResourcesDir?: string
}

/**
 * `%PUBLIC%` (`C:\Users\Public`, or a sensible fallback) — machine-wide and
 * writable by all users out of the box thanks to its default ACLs.
 */
function publicDir(): string {
  return process.env.PUBLIC?.trim() || 'C:\\Users\\Public'
}

/** Machine-wide config directory the installer writes to. */
function configDir(): string {
  if (process.platform === 'win32') {
    return path.join(publicDir(), 'AI Playground')
  }
  // No all-users installer flow on non-Windows yet; keep a conventional path so
  // the reader is platform-safe.
  return '/etc/ai-playground'
}

/** Location of the machine-wide install config written by the installer. */
function installConfigPath(): string {
  return path.join(configDir(), 'install-config.json')
}

/**
 * Sidecar written by the installer's folder picker: the admin-chosen shared
 * resources base directory as a raw path. Kept out of `install-config.json`
 * because NSIS cannot easily emit the backslash-escaping valid JSON needs.
 * Used as a fallback when the JSON carries no explicit `sharedResourcesDir`.
 */
function readSharedResourcesDirFile(): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(configDir(), 'shared-resources-dir.txt'), 'utf-8').trim()
    return raw || undefined
  } catch {
    return undefined
  }
}

export function readInstallConfig(): InstallConfig | null {
  try {
    const raw = fs.readFileSync(installConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<InstallConfig>
    if (parsed.modelFolderMode !== 'shared' && parsed.modelFolderMode !== 'per-user') {
      return null
    }
    return {
      modelFolderMode: parsed.modelFolderMode,
      sharedResourcesDir: parsed.sharedResourcesDir?.trim() || readSharedResourcesDirFile(),
    }
  } catch {
    return null
  }
}
