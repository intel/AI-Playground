import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeGgufMetadata } from '@/lib/vram/gguf'
import { archFromMetadata } from '@/lib/vram/arch'
import { readGgufMetadataFromFile } from '../../../adapters/vram/ggufRead.ts'

const tempFiles: string[] = []

afterEach(() => {
  for (const file of tempFiles.splice(0)) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* ignore */
    }
  }
})

describe('readGgufMetadataFromFile', () => {
  it('parses a header from disk without needing the tensor body', () => {
    const bytes = encodeGgufMetadata(
      [
        ['general.architecture', { type: 'string', value: 'qwen35' }],
        ['qwen35.block_count', { type: 'u32', value: 32 }],
        ['qwen35.ssm.inner_size', { type: 'u32', value: 4096 }],
        ['tokenizer.ggml.tokens', { type: 'string[]', value: ['a', 'b', 'c', 'd'] }],
      ],
      { tensorCount: 99 },
    )
    const file = path.join(os.tmpdir(), `aipg-gguf-${process.pid}.gguf`)
    tempFiles.push(file)
    fs.writeFileSync(file, bytes)
    const meta = readGgufMetadataFromFile(file)
    expect(meta.tensorCount).toBe(99)
    expect(meta.vocabSize).toBe(4)
    expect(archFromMetadata(meta)).toMatchObject({
      architecture: 'qwen35',
      blockCount: 32,
      ssmInnerSize: 4096,
      vocabSize: 4,
    })
  })
})
