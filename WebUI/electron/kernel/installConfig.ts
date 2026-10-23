import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Machine-wide install choice written by the all-users installer: whether the
 * heavy runtime (Python, backend venvs, models) is shared or kept per-user.
 *
 * The choice lives in HKLM\SOFTWARE\AI Playground. A standard user cannot
 * create that key, so a per-user install — which writes nothing — cannot be
 * redirected by a file planted under %PUBLIC%. `sharedResourcesDir` is honored
 * only when it is a local, non-reparse directory owned by Administrators,
 * SYSTEM, or TrustedInstaller. Anything else is ignored and the app stays on
 * per-user paths.
 *
 * In shared mode `aipgRoot.ts` points the resources root at
 * `<sharedResourcesDir>/resources`. The installer grants inheritable Modify to
 * BUILTIN\Users there. Each user's mutable config stays in a private folder.
 * See `aipgRoot.ts` and `userConfig.ts`.
 */

export type ModelFolderMode = 'shared' | 'per-user'

export type InstallConfig = {
  modelFolderMode: ModelFolderMode
  /**
   * Admin-chosen base directory for the shared resources tree (the parent of
   * the `resources` folder). Present only for a validated shared install.
   */
  sharedResourcesDir?: string
}

const INSTALL_CONFIG_KEY = 'HKLM\\SOFTWARE\\AI Playground'

// Drive-letter absolute path. `C:relative` and UNC both fail this.
const DRIVE_ABSOLUTE = /^[a-zA-Z]:[\\/]/

type DirectoryStat = {
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
}

type LstatFn = (dir: string) => DirectoryStat

/** Test seam. Production reads HKLM and the directory owner itself. */
export type InstallConfigProbe = {
  registryStdout: string | null
  ownerSid: (dir: string) => string | null
  lstat: LstatFn
}

let cached: InstallConfig | null | undefined

/** Local absolute path, or null for UNC, device, relative, or `..` paths. */
export function normalizeLocalAbsolutePath(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed || trimmed.includes('\0')) return null
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) return null
  if (!DRIVE_ABSOLUTE.test(trimmed)) return null
  if (trimmed.split(/[\\/]/).includes('..')) return null
  const resolved = path.win32.resolve(trimmed)
  if (!/^[a-zA-Z]:\\/.test(resolved) || resolved.startsWith('\\\\')) return null
  return resolved
}

/** Administrators, SYSTEM, or a TrustedInstaller service SID. */
export function isTrustedOwnerSid(sid: string | null | undefined): boolean {
  if (!sid) return false
  const normalized = sid.trim().toUpperCase()
  if (normalized === 'S-1-5-18' || normalized === 'S-1-5-32-544') return true
  return normalized.startsWith('S-1-5-80-') && normalized.length > 'S-1-5-80-'.length
}

/** `reg query` text for the install-config values. */
export function parseInstallRegistry(stdout: string): {
  modelFolderMode?: string
  sharedResourcesDir?: string
} {
  const values = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s+(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*?)\s*$/)
    if (!match) continue
    values.set(match[1], match[2].trim())
  }
  return {
    modelFolderMode: values.get('modelFolderMode'),
    sharedResourcesDir: values.get('sharedResourcesDir'),
  }
}

function readRegistryStdout(): string | null {
  try {
    return execFileSync('reg.exe', ['query', INSTALL_CONFIG_KEY, '/reg:64'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

function readOwnerSid(dir: string): string | null {
  if (process.platform !== 'win32') return null
  try {
    const ownerCommand = [
      '(Get-Acl -LiteralPath $env:AIPG_TRUST_PATH)',
      '.GetOwner([System.Security.Principal.SecurityIdentifier])',
      '.Value',
    ].join('')
    const stdout = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ownerCommand],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
        env: { ...process.env, AIPG_TRUST_PATH: dir },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    return stdout.trim() || null
  } catch (error) {
    console.error('[installConfig] could not read directory owner:', error)
    return null
  }
}

function isUnredirectedDirectory(resolved: string, lstat: LstatFn): boolean {
  let current = resolved
  for (let depth = 0; depth < 64; depth++) {
    let stats: DirectoryStat
    try {
      stats = lstat(current)
    } catch {
      return false
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false
    const parent = path.win32.dirname(current)
    if (parent === current) return true
    current = parent
  }
  return false
}

function resourcesLeafIsUsable(base: string, lstat: LstatFn): boolean {
  const leaf = path.win32.join(base, 'resources')
  try {
    const stats = lstat(leaf)
    return !stats.isSymbolicLink() && stats.isDirectory()
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

function rejectShared(reason: string): null {
  console.error(`[installConfig] ignoring shared install config: ${reason}`)
  return null
}

function loadInstallConfig(probe?: InstallConfigProbe): InstallConfig | null {
  if (!probe && process.platform !== 'win32') return null
  const stdout = probe ? probe.registryStdout : readRegistryStdout()
  if (!stdout) return null
  const parsed = parseInstallRegistry(stdout)
  if (parsed.modelFolderMode === 'per-user') return { modelFolderMode: 'per-user' }
  if (parsed.modelFolderMode !== 'shared') {
    if (parsed.modelFolderMode) {
      console.error(
        `[installConfig] ignoring machine install config: unknown mode "${parsed.modelFolderMode}"`,
      )
    }
    return null
  }

  const dir = normalizeLocalAbsolutePath(parsed.sharedResourcesDir ?? '')
  if (!dir) return rejectShared('sharedResourcesDir is not a local absolute path')

  const lstat = probe?.lstat ?? ((dirPath: string) => fs.lstatSync(dirPath))
  if (!isUnredirectedDirectory(dir, lstat)) {
    return rejectShared(`${dir} is not a local directory`)
  }
  if (!resourcesLeafIsUsable(dir, lstat)) {
    return rejectShared(`${dir}\\resources is a link or not a directory`)
  }
  const sid = (probe?.ownerSid ?? readOwnerSid)(dir)
  if (!isTrustedOwnerSid(sid)) {
    return rejectShared(`${dir} is not owned by an administrator`)
  }
  return { modelFolderMode: 'shared', sharedResourcesDir: dir }
}

export function readInstallConfig(probe?: InstallConfigProbe): InstallConfig | null {
  if (probe) return loadInstallConfig(probe)
  if (cached !== undefined) return cached
  cached = loadInstallConfig()
  return cached
}
