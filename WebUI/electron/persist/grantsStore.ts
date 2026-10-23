import fs from 'node:fs/promises'
import { appLoggerInstance } from '../observability/logger'
import { getPermissionGrantsDemoFile, getPermissionGrantsFile } from './userDataPaths.ts'
import {
  PermissionGrantsFileSchema,
  type PermissionGrant,
  type PermissionGrantOrigin,
} from '@/types/permissionsIpc'
import { atomicWriteJson, makeWriteChains, readJson } from './fsJsonStore'
import { emitStored } from '../kernel/kernelBus'

/**
 * The kernel's one-writer permission-grants store (architecture-target §4.7,
 * step 13). Every remembered or pre-granted consent lives here; the renderer
 * Settings page is a projection. Same correctness contract as the other
 * user-data files: atomic writes, schema validation on read, one chain.
 */

const appLogger = appLoggerInstance
const LOG_SCOPE = 'permissions'

export type PermissionGrantsDeps = {
  isDemoMode: () => boolean
}

let grantsDeps: PermissionGrantsDeps | null = null

export function setPermissionGrantsDeps(deps: PermissionGrantsDeps): void {
  grantsDeps = deps
}

const { serialize, clear: clearChains } = makeWriteChains()
const FILE_CHAIN = 'file'

function grantsFile(): string {
  return grantsDeps?.isDemoMode() ? getPermissionGrantsDemoFile() : getPermissionGrantsFile()
}

function emptyDoc() {
  return { schemaVersion: 1 as const, grants: {} as Record<string, PermissionGrant> }
}

async function readDoc(): Promise<{
  schemaVersion: 1
  grants: Record<string, PermissionGrant>
}> {
  const read = await readJson(grantsFile(), LOG_SCOPE)
  if (read.status === 'missing') return emptyDoc()
  if (read.status === 'ok') {
    const parsed = PermissionGrantsFileSchema.safeParse(read.value)
    if (parsed.success) return parsed.data
  }
  appLogger.warn('permission-grants file failed schema; treated as empty', LOG_SCOPE)
  return emptyDoc()
}

function assertSafeGrantKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > 200 || /[\\/]/.test(key)) {
    throw new Error(`invalid permission grant key: ${String(key)}`)
  }
}

export async function listPermissionGrants(): Promise<PermissionGrant[]> {
  const doc = await readDoc()
  return Object.values(doc.grants).sort((a, b) => b.createdAt - a.createdAt)
}

export async function hasPermissionGrant(key: string): Promise<boolean> {
  assertSafeGrantKey(key)
  const doc = await readDoc()
  return Boolean(doc.grants[key])
}

export async function grantPermission(
  key: string,
  origin: PermissionGrantOrigin,
): Promise<PermissionGrant> {
  assertSafeGrantKey(key)
  return serialize(FILE_CHAIN, async () => {
    const doc = await readDoc()
    const grant: PermissionGrant = { key, origin, createdAt: Date.now() }
    doc.grants[key] = grant
    await atomicWriteJson(grantsFile(), doc)
    emitStored('grants')
    return grant
  })
}

export async function revokePermissionGrant(key: string): Promise<void> {
  assertSafeGrantKey(key)
  return serialize(FILE_CHAIN, async () => {
    const doc = await readDoc()
    delete doc.grants[key]
    await atomicWriteJson(grantsFile(), doc)
    emitStored('grants')
  })
}

/**
 * One-shot leftover upload: merge keys that the file does not already own, so
 * a retried migrate of Pinia persist / localStorage memory-alerts cannot
 * overwrite a later Settings change.
 */
export async function migratePermissionGrants(
  incoming: Record<string, PermissionGrant>,
): Promise<number> {
  return serialize(FILE_CHAIN, async () => {
    const doc = await readDoc()
    let added = 0
    for (const [key, grant] of Object.entries(incoming)) {
      if (typeof key !== 'string' || key.length === 0 || /[\\/]/.test(key)) continue
      if (doc.grants[key]) continue
      const parsed = {
        key,
        origin: grant.origin === 'pre-grant' ? ('pre-grant' as const) : ('remember' as const),
        createdAt: typeof grant.createdAt === 'number' ? grant.createdAt : Date.now(),
      }
      doc.grants[key] = parsed
      added += 1
    }
    if (added > 0) {
      await atomicWriteJson(grantsFile(), doc)
      emitStored('grants')
    }
    return added
  })
}

export async function wipeDemoPermissionGrants(): Promise<void> {
  try {
    await fs.rm(getPermissionGrantsDemoFile(), { force: true })
  } catch (error) {
    appLogger.warn(`demo permission-grants wipe failed: ${String(error)}`, LOG_SCOPE)
  }
}

export function resetPermissionGrantsForTest(): void {
  grantsDeps = null
  clearChains()
}
