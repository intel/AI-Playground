import {
  REMOTE_DOWNLOAD_GRANT,
  vramWarningGrantKey,
  type PermissionGrant,
  type PermissionGrantOrigin,
} from '@/types/permissionsIpc'
import {
  grantPermission,
  hasPermissionGrant,
  listPermissionGrants,
  migratePermissionGrants,
  revokePermissionGrant,
} from '../persist/grantsStore'
import { requestPermissionsPrompt } from './promptAdapter'

/**
 * Permissions policy in main (architecture-target §4.7, step 13). Named verbs
 * stay. The renderer is the dialog / channel adapter — this module decides
 * whether a grant already answers, then asks the adapter to prompt (and, for
 * downloads, to run the download). No silent auto-allow: a skip of the
 * in-channel question exists only because the user pre-granted
 * `download:remote-turns`. A hidden window still has Chromium; without a
 * window a download cannot run even with a pre-grant (weights still go through
 * the shared download path).
 */

export type RequestDownloadOptions = {
  onProgress?: () => void
}

export async function requestDownloadConsent(
  models: unknown[],
  options: RequestDownloadOptions = {},
): Promise<void> {
  const remote = await isRemoteTurnActive()
  const skipConfirmation = remote && (await hasPermissionGrant(REMOTE_DOWNLOAD_GRANT))
  await requestPermissionsPrompt<void>(
    { kind: 'download', models, skipConfirmation },
    { onProgress: options.onProgress },
  )
}

export async function requestVramWarningConsent(req: {
  presetName: string
  message: string
}): Promise<boolean> {
  const key = vramWarningGrantKey(req.presetName)
  if (await hasPermissionGrant(key)) return true
  const answer = await requestPermissionsPrompt<{ confirmed: boolean; remember: boolean }>({
    kind: 'vram-warning',
    presetName: req.presetName,
    message: req.message,
  })
  if (answer.confirmed && answer.remember) {
    await grantPermission(key, 'remember')
  }
  return answer.confirmed === true
}

async function isRemoteTurnActive(): Promise<boolean> {
  try {
    return (await requestPermissionsPrompt<boolean>({ kind: 'is-remote' })) === true
  } catch {
    return false
  }
}

export async function listGrants(): Promise<PermissionGrant[]> {
  return listPermissionGrants()
}

export async function grant(key: string, origin: PermissionGrantOrigin): Promise<PermissionGrant> {
  return grantPermission(key, origin)
}

export async function revoke(key: string): Promise<void> {
  return revokePermissionGrant(key)
}

export async function migrateGrants(incoming: Record<string, PermissionGrant>): Promise<number> {
  return migratePermissionGrants(incoming)
}
