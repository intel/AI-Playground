import fs from 'node:fs'

import { archFromMetadata, archIsSettled } from '@/lib/vram/arch'
import { bytesReader, parseGgufMetadata } from '@/lib/vram/gguf'
import type { LlamaCppVramInputs } from './llamaCppVramInputs'

/**
 * The same facts `readLlamaCppVramInputs` reads off disk, read off HuggingFace
 * instead — a GGUF's header is at the front of the file, so a range request for
 * a few MiB answers "does this model fit" before anything is downloaded.
 */

// A header is a few hundred KiB plus the tokenizer's own arrays, which the parser
// walks rather than skips wholesale; a 250k-token vocab lands in the megabytes.
const PREFIX_LENGTHS = [1 << 20, 4 << 20, 16 << 20]
const REQUEST_TIMEOUT_MS = 20_000
const CACHE_VERSION = 1

export type RemoteModelRef = { name: string; mmproj?: string }

export type RemoteLookupOptions = {
  endpoint: string
  cachePath: string
  token?: string
  fetchImpl?: typeof fetch
}

/** `owner/repo/file.gguf` (as the catalog names it) → the file's resolve URL. */
export function huggingFaceResolveUrl(endpoint: string, name: string): string | undefined {
  const [owner, repo, ...rest] = name.split('/')
  if (!owner || !repo || rest.length === 0) return undefined
  return `${endpoint.replace(/\/+$/, '')}/${owner}/${repo}/resolve/main/${rest.join('/')}`
}

function totalFromContentRange(header: string | null): number | undefined {
  const total = /\/(\d+)\s*$/.exec(header ?? '')?.[1]
  return total ? Number(total) : undefined
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

type Chunk = { bytes: Uint8Array; totalBytes: number }

async function fetchRange(
  url: string,
  from: number,
  to: number,
  options: RemoteLookupOptions,
): Promise<Chunk | undefined> {
  const request = options.fetchImpl ?? fetch
  const response = await request(url, {
    headers: { Range: `bytes=${from}-${to}`, ...authHeaders(options.token) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  // Anything but 206 means the range was ignored, and the body is then the whole
  // model — never read it.
  if (response.status !== 206) {
    await response.body?.cancel()
    return undefined
  }
  const totalBytes = totalFromContentRange(response.headers.get('content-range'))
  if (!totalBytes) return undefined
  return { bytes: new Uint8Array(await response.arrayBuffer()), totalBytes }
}

/** Size without the bytes: HF answers a HEAD with the linked LFS object's size. */
async function remoteFileSize(
  url: string,
  options: RemoteLookupOptions,
): Promise<number | undefined> {
  const request = options.fetchImpl ?? fetch
  const response = await request(url, {
    method: 'HEAD',
    headers: authHeaders(options.token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) return undefined
  const size = response.headers.get('x-linked-size') ?? response.headers.get('content-length')
  return Number(size) || undefined
}

const SHARD_PATTERN = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/

/**
 * A split model is loaded whole, so its weights are every shard — the file the
 * catalog names is only the first. Undefined when a shard cannot be sized: a sum
 * that silently misses 80 GB would show a 122B model as a comfortable fit.
 */
async function shardedWeightsBytes(
  name: string,
  knownShardBytes: number,
  options: RemoteLookupOptions,
): Promise<number | undefined> {
  const parts = name.split('/')
  const shard = SHARD_PATTERN.exec(parts[parts.length - 1])
  if (!shard) return knownShardBytes
  const [, stem, index, count] = shard

  let total = knownShardBytes
  for (let i = 1; i <= Number(count); i++) {
    if (i === Number(index)) continue
    const file = `${stem}-${String(i).padStart(5, '0')}-of-${count}.gguf`
    const url = huggingFaceResolveUrl(options.endpoint, [...parts.slice(0, -1), file].join('/'))
    const size = url ? await remoteFileSize(url, options) : undefined
    if (!size) return undefined
    total += size
  }
  return total
}

type Cache = { version: number; models: Record<string, LlamaCppVramInputs> }

let memoryCache: Cache | undefined

function readCache(cachePath: string): Cache {
  if (memoryCache) return memoryCache
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Cache
    memoryCache = parsed.version === CACHE_VERSION ? parsed : { version: CACHE_VERSION, models: {} }
  } catch {
    memoryCache = { version: CACHE_VERSION, models: {} }
  }
  return memoryCache
}

function writeCache(cachePath: string, name: string, inputs: LlamaCppVramInputs): void {
  const cache = readCache(cachePath)
  cache.models[name] = inputs
  try {
    fs.writeFileSync(cachePath, JSON.stringify(cache))
  } catch {
    // A cache that cannot be written costs one range request per app start.
  }
}

/** Forget what was read; the cache is keyed by model name only. */
export function clearRemoteGgufCache(): void {
  memoryCache = undefined
}

export async function readRemoteLlamaCppVramInputs(
  model: RemoteModelRef,
  options: RemoteLookupOptions,
): Promise<LlamaCppVramInputs | undefined> {
  const cached = readCache(options.cachePath).models[model.name]
  if (cached) return cached
  const url = huggingFaceResolveUrl(options.endpoint, model.name)
  if (!url) return undefined

  // Each step appends to what is already held, so growing the window costs only
  // the bytes it adds.
  let prefix = new Uint8Array(0)
  let weightsBytes = 0
  for (const length of PREFIX_LENGTHS) {
    const chunk = await fetchRange(url, prefix.length, length - 1, options)
    if (!chunk) return undefined
    const grown = new Uint8Array(prefix.length + chunk.bytes.length)
    grown.set(prefix)
    grown.set(chunk.bytes, prefix.length)
    prefix = grown
    weightsBytes = chunk.totalBytes
    let arch
    try {
      const metadata = parseGgufMetadata(bytesReader(prefix), { allowTruncated: true })
      // An unsettled header is worse than none: the missing keys are the ones
      // that decide which KV path the model takes.
      if (!archIsSettled(metadata)) continue
      arch = archFromMetadata(metadata)
    } catch {
      return undefined // Not a GGUF.
    }
    const allShards = await shardedWeightsBytes(model.name, weightsBytes, options)
    if (!allShards) return undefined
    const mmprojUrl = model.mmproj
      ? huggingFaceResolveUrl(options.endpoint, model.mmproj)
      : undefined
    const inputs: LlamaCppVramInputs = {
      arch,
      weightsBytes: allShards,
      mmprojBytes: (mmprojUrl ? await remoteFileSize(mmprojUrl, options) : 0) ?? 0,
    }
    writeCache(options.cachePath, model.name, inputs)
    return inputs
  }
  return undefined
}
