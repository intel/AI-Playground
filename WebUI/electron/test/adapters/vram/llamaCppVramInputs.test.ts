import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeGgufMetadata } from '@/lib/vram/gguf'
import {
  readLlamaCppVramInputs,
  resolveGgufPath,
} from '../../../adapters/vram/llamaCppVramInputs.ts'

const tempDirs: string[] = []

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-vram-inputs-'))
  tempDirs.push(dir)
  return dir
}

function writeGguf(target: string, architecture: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(
    target,
    encodeGgufMetadata(
      [
        ['general.architecture', { type: 'string', value: architecture }],
        [`${architecture}.block_count`, { type: 'u32', value: 28 }],
        [`${architecture}.embedding_length`, { type: 'u32', value: 2048 }],
      ],
      { tensorCount: 3 },
    ),
  )
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveGgufPath', () => {
  it('finds the downloaded spelling of a catalog name', () => {
    const dir = makeDir()
    writeGguf(path.join(dir, 'bartowski---Model-GGUF', 'Model-Q4_K_M.gguf'), 'llama')
    expect(resolveGgufPath(dir, 'bartowski/Model-GGUF/Model-Q4_K_M.gguf')).toBe(
      path.join(dir, 'bartowski---Model-GGUF', 'Model-Q4_K_M.gguf'),
    )
  })

  it('falls back to a scan when the on-disk layout is flat', () => {
    const dir = makeDir()
    writeGguf(path.join(dir, 'owner---repo---weights.gguf'), 'llama')
    expect(resolveGgufPath(dir, 'owner/repo/weights.gguf')).toBe(
      path.join(dir, 'owner---repo---weights.gguf'),
    )
  })

  it('returns undefined for a model that is not downloaded', () => {
    expect(resolveGgufPath(makeDir(), 'owner/repo/missing.gguf')).toBeUndefined()
  })
})

describe('readLlamaCppVramInputs', () => {
  it('reads the architecture and the file size', () => {
    const dir = makeDir()
    const file = path.join(dir, 'owner---repo', 'model.gguf')
    writeGguf(file, 'qwen3')
    const inputs = readLlamaCppVramInputs(dir, 'owner/repo/model.gguf')
    expect(inputs?.arch).toMatchObject({ architecture: 'qwen3', blockCount: 28 })
    expect(inputs?.weightsBytes).toBe(fs.statSync(file).size)
    expect(inputs?.mmprojBytes).toBe(0)
  })

  it('reads past its window when the arch keys sit behind the vocabulary', () => {
    const dir = makeDir()
    const file = path.join(dir, 'owner---repo', 'model.gguf')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // ~2 MiB of vocabulary first, so the bounded first read cannot settle.
    fs.writeFileSync(
      file,
      encodeGgufMetadata([
        [
          'tokenizer.ggml.tokens',
          { type: 'string[]', value: Array.from({ length: 140_000 }, (_, i) => `token${i}`) },
        ],
        ['general.architecture', { type: 'string', value: 'llama' }],
        ['llama.block_count', { type: 'u32', value: 28 }],
        ['llama.embedding_length', { type: 'u32', value: 2048 }],
        ['llama.attention.head_count', { type: 'u32', value: 16 }],
      ]),
    )

    expect(readLlamaCppVramInputs(dir, 'owner/repo/model.gguf')?.arch).toMatchObject({
      architecture: 'llama',
      blockCount: 28,
      headCount: 16,
    })
  })

  it('adds a sibling mmproj and sums the shards of a split model', () => {
    const dir = makeDir()
    const modelDir = path.join(dir, 'owner---repo')
    writeGguf(path.join(modelDir, 'model-00001-of-00002.gguf'), 'qwen3')
    writeGguf(path.join(modelDir, 'model-00002-of-00002.gguf'), 'qwen3')
    writeGguf(path.join(modelDir, 'mmproj-f16.gguf'), 'clip')
    const shards = ['model-00001-of-00002.gguf', 'model-00002-of-00002.gguf'].reduce(
      (sum, name) => sum + fs.statSync(path.join(modelDir, name)).size,
      0,
    )
    const inputs = readLlamaCppVramInputs(dir, 'owner/repo/model-00001-of-00002.gguf')
    expect(inputs?.weightsBytes).toBe(shards)
    expect(inputs?.mmprojBytes).toBe(fs.statSync(path.join(modelDir, 'mmproj-f16.gguf')).size)
  })
})
