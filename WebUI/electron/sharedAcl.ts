import { spawnSync } from 'node:child_process'

// BUILTIN\Users. The SID avoids a locale-specific group name.
const usersSid = '*S-1-5-32-545'

// (OI)(CI) is inherited by a file created in the folder. Shared installs set
// UV_LINK_MODE=copy so uv creates those files here instead of hardlinking them.
const inheritableModifyAce = `${usersSid}:(OI)(CI)M`

export function usersModifyIcaclsArgs(dir: string): string[] {
  return [dir, '/grant', inheritableModifyAce, '/T', '/C']
}

/** Best-effort. Used while seeding, before the logger exists. No-op off Windows. */
export function grantUsersModifySync(dir: string): boolean {
  if (process.platform !== 'win32') return true
  const result = spawnSync('icacls', usersModifyIcaclsArgs(dir), { windowsHide: true })
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return true
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ?? result.stderr?.toString().trim() ?? `exit ${result.status}`
    console.error(`[aipg] could not grant all users write access on ${dir}: ${detail}`)
    return false
  }
  return true
}
