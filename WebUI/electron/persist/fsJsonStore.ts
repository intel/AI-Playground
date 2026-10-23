import fs from 'node:fs/promises'
import path from 'node:path'
import { appLoggerInstance } from '../observability/logger'

/**
 * Shared primitives for the kernel's user-data file stores (§6.1, step 8):
 * torn-write-safe JSON writes, read-with-status, per-key write chains, and the
 * id guard that keeps an IPC-supplied id from ever becoming a path. The
 * per-domain stores (conversations, agent sessions, media records) own their
 * schemas and index shapes; these are the mechanics they share.
 */

export const fsJsonLogger = appLoggerInstance

/** Torn-write-safe JSON write: a crash mid-write leaves the old file intact. */
export async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(tmp, `${JSON.stringify(data)}\n`, 'utf8')
  await fs.rename(tmp, file)
}

export type JsonRead =
  { status: 'missing' } | { status: 'ok'; value: unknown } | { status: 'corrupt' }

export async function readJson(file: string, scope: string): Promise<JsonRead> {
  try {
    return { status: 'ok', value: JSON.parse(await fs.readFile(file, 'utf8')) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    fsJsonLogger.warn(`${scope} file unreadable (${file}): ${String(error)}`, scope)
    return { status: 'corrupt' }
  }
}

/** Timestamp ids, uuids, the legacy Home Agent singleton; never a path or `index`. */
export function isSafeFileId(id: string): boolean {
  return id.length > 0 && id.length <= 200 && id !== 'index' && /^[\w.-]+$/.test(id)
}

export function assertSafeFileId(id: string, what: string): void {
  if (!isSafeFileId(id)) throw new Error(`invalid ${what} id: ${id}`)
}

/** Every non-index `.json` in the directory whose stem is a safe id, sorted by name. */
export async function listFileIds(
  dir: string,
  isSafe: (id: string) => boolean = isSafeFileId,
): Promise<string[]> {
  try {
    const names = await fs.readdir(dir)
    return names
      .filter((name) => name.endsWith('.json') && name !== 'index.json')
      .map((name) => name.slice(0, -'.json'.length))
      .filter(isSafe)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * Per-key FIFO write chains: mutations of one key run in order, and the index
 * chain can be nested inside a key's chain (never the reverse), so the chains
 * cannot deadlock. See conversationFiles.ts for the nesting direction.
 */
export type WriteChains = {
  serialize<T>(id: string, run: () => Promise<T>): Promise<T>
  clear(): void
  pendingCountForTest(): number
}

export function makeWriteChains(): WriteChains {
  const chains = new Map<string, Promise<unknown>>()
  return {
    serialize<T>(id: string, run: () => Promise<T>): Promise<T> {
      const previous = chains.get(id) ?? Promise.resolve()
      const next = previous.then(run, run)
      chains.set(id, next)
      void next
        .finally(() => {
          if (chains.get(id) === next) chains.delete(id)
        })
        .catch(() => {})
      return next
    },
    clear(): void {
      chains.clear()
    },
    pendingCountForTest(): number {
      return chains.size
    },
  }
}
