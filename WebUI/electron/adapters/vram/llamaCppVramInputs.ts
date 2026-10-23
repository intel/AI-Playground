import fs from 'node:fs'
import path from 'node:path'

import { archFromMetadata, archIsSettled } from '@/lib/vram/arch'
import type { LlamaCppVramInputs } from '@/lib/vram/types'
import { normalizeModelKey } from '@/assets/js/models/library'
import { readGgufMetadataFromFile } from './ggufRead.ts'

export type { LlamaCppVramInputs }

/** `owner/repo/file.gguf` as the downloader wrote it: `owner---repo/file.gguf`. */
function downloadedPath(dir: string, name: string): string | undefined {
  const [namespace, repo, ...rest] = name.split('/')
  if (!namespace || !repo || rest.length === 0) return undefined
  const candidate = path.join(dir, `${namespace}---${repo}`, ...rest)
  return fs.existsSync(candidate) ? candidate : undefined
}

/** Catalog names and on-disk spellings differ; both reduce to the same key. */
function scannedPath(dir: string, name: string): string | undefined {
  const wanted = normalizeModelKey(name)
  for (const entry of fs.readdirSync(dir, { encoding: 'utf-8', recursive: true })) {
    if (!entry.endsWith('.gguf')) continue
    if (normalizeModelKey(entry) === wanted) return path.join(dir, entry)
  }
  return undefined
}

export function resolveGgufPath(dir: string, name: string): string | undefined {
  if (!dir || !fs.existsSync(dir)) return undefined
  return downloadedPath(dir, name) ?? scannedPath(dir, name)
}

function fileSize(target: string): number {
  try {
    return fs.statSync(target).size
  } catch {
    return 0
  }
}

/**
 * A sharded model is loaded whole, so its weights are every shard: llama.cpp
 * follows `-00001-of-000NN` from the file it is given.
 */
export function weightsBytesFor(modelPath: string): number {
  const shard = /^(.*)-\d{5}-of-\d{5}\.gguf$/.exec(path.basename(modelPath))
  if (!shard) return fileSize(modelPath)
  const dir = path.dirname(modelPath)
  let total = 0
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith(`${shard[1]}-`) && entry.endsWith('.gguf')) {
      total += fileSize(path.join(dir, entry))
    }
  }
  return total || fileSize(modelPath)
}

/** Same rule the server uses when it adds `--mmproj`: first `mmproj*.gguf` sibling. */
export function mmprojBytesFor(modelPath: string): number {
  const dir = path.dirname(modelPath)
  let entries: string[] = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return 0
  }
  const mmproj = entries.find((file) => file.startsWith('mmproj') && file.endsWith('.gguf'))
  return mmproj ? fileSize(path.join(dir, mmproj)) : 0
}

/** Enough for the `<arch>.*` keys of every model in the catalog; see `archIsSettled`. */
const ARCH_WINDOW_BYTES = 1 << 20

export function readLlamaCppVramInputs(
  ggufDir: string,
  modelName: string,
): LlamaCppVramInputs | undefined {
  const modelPath = resolveGgufPath(ggufDir, modelName)
  if (!modelPath) return undefined
  // Reading past the tokenizer costs a syscall per token, so stop as soon as the
  // header has said what the estimator needs.
  let metadata = readGgufMetadataFromFile(modelPath, {
    limit: ARCH_WINDOW_BYTES,
    allowTruncated: true,
  })
  if (!archIsSettled(metadata)) metadata = readGgufMetadataFromFile(modelPath)
  const arch = archFromMetadata(metadata)
  return {
    arch,
    weightsBytes: weightsBytesFor(modelPath),
    mmprojBytes: mmprojBytesFor(modelPath),
  }
}
