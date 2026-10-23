import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeGgufMetadata } from '@/lib/vram/gguf'
import {
  clearRemoteGgufCache,
  huggingFaceResolveUrl,
  readRemoteLlamaCppVramInputs,
} from '../../../adapters/vram/remoteGgufMeta.ts'

const MODEL = { name: 'owner/repo/model.gguf', mmproj: 'owner/repo/mmproj-BF16.gguf' }
const ENDPOINT = 'https://huggingface.co'
const WEIGHTS_BYTES = 4_294_967_296
const MMPROJ_BYTES = 921_704_928

function ggufHeader(tokens = 0): Uint8Array {
  return encodeGgufMetadata([
    ['general.architecture', { type: 'string', value: 'llama' }],
    ['llama.block_count', { type: 'u32', value: 32 }],
    ['llama.embedding_length', { type: 'u32', value: 4096 }],
    ['llama.attention.head_count', { type: 'u32', value: 32 }],
    ['llama.attention.head_count_kv', { type: 'u32', value: 8 }],
    ['llama.vocab_size', { type: 'u32', value: 128256 }],
    // A vocab is what pushes a real header past a megabyte.
    [
      'tokenizer.ggml.tokens',
      { type: 'string[]', value: Array.from({ length: tokens }, (_, i) => `token${i}`) },
    ],
  ])
}

let cachePath: string
let requests: { url: string; method: string; range: string | null }[]

/** HuggingFace as far as this module is concerned: ranged GET + HEAD. */
function fakeHuggingFace(options?: { header?: Uint8Array; status?: number }): typeof fetch {
  const file = options?.header ?? ggufHeader()
  return (async (url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('Range')
    requests.push({ url, method: init?.method ?? 'GET', range })
    if (init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'x-linked-size': `${MMPROJ_BYTES}` } })
    }
    if (options?.status && options.status !== 206) {
      return new Response('the whole model', { status: options.status })
    }
    const [from, to] = (/bytes=(\d+)-(\d+)/.exec(range ?? '') ?? []).slice(1).map(Number)
    return new Response(file.slice(from, to + 1).buffer as ArrayBuffer, {
      status: 206,
      headers: { 'content-range': `bytes ${from}-${to}/${WEIGHTS_BYTES}` },
    })
  }) as unknown as typeof fetch
}

beforeEach(() => {
  clearRemoteGgufCache()
  requests = []
  cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-gguf-')), 'cache.json')
})

afterEach(() => {
  fs.rmSync(path.dirname(cachePath), { recursive: true, force: true })
})

describe('huggingFaceResolveUrl', () => {
  it('builds a resolve URL from a catalog name, mirror endpoint included', () => {
    expect(huggingFaceResolveUrl('https://hf-mirror.com/', MODEL.name)).toBe(
      'https://hf-mirror.com/owner/repo/resolve/main/model.gguf',
    )
    expect(huggingFaceResolveUrl(ENDPOINT, 'owner/repo/sub/dir/model.gguf')).toBe(
      'https://huggingface.co/owner/repo/resolve/main/sub/dir/model.gguf',
    )
  })

  it('refuses a name that is not owner/repo/file', () => {
    expect(huggingFaceResolveUrl(ENDPOINT, 'owner/repo')).toBeUndefined()
  })
})

describe('readRemoteLlamaCppVramInputs', () => {
  it('reads architecture and both file sizes without downloading the model', async () => {
    const inputs = await readRemoteLlamaCppVramInputs(MODEL, {
      endpoint: ENDPOINT,
      cachePath,
      fetchImpl: fakeHuggingFace(),
    })

    expect(inputs?.arch.architecture).toBe('llama')
    expect(inputs?.arch.headCountKv).toBe(8)
    // The file's size comes from the range response, so no extra request for it.
    expect(inputs?.weightsBytes).toBe(WEIGHTS_BYTES)
    expect(inputs?.mmprojBytes).toBe(MMPROJ_BYTES)
    expect(requests[0].range).toBe(`bytes=0-${(1 << 20) - 1}`)
    expect(requests.filter((r) => r.method === 'HEAD')).toHaveLength(1)
  })

  it('asks for the rest of a header a megabyte does not hold, not for it again', async () => {
    // ~2 MiB of vocab: the first window ends mid-array.
    const inputs = await readRemoteLlamaCppVramInputs(MODEL, {
      endpoint: ENDPOINT,
      cachePath,
      fetchImpl: fakeHuggingFace({ header: ggufHeader(140_000) }),
    })

    expect(inputs?.arch.vocabSize).toBe(128256)
    expect(requests.filter((r) => r.method === 'GET').map((r) => r.range)).toEqual([
      `bytes=0-${(1 << 20) - 1}`,
      `bytes=${1 << 20}-${(4 << 20) - 1}`,
    ])
  })

  it('gives up rather than read a body when the range was ignored', async () => {
    const cancel = vi.fn()
    const fetchImpl = (async () =>
      new Response(new ReadableStream({ cancel }), { status: 200 })) as unknown as typeof fetch

    const inputs = await readRemoteLlamaCppVramInputs(MODEL, {
      endpoint: ENDPOINT,
      cachePath,
      fetchImpl,
    })

    expect(inputs).toBeUndefined()
    expect(cancel).toHaveBeenCalled()
  })

  it('counts every shard of a split model', async () => {
    const name = 'owner/repo/Q4_K_M/model-00001-of-00003.gguf'
    const inputs = await readRemoteLlamaCppVramInputs(
      { name },
      { endpoint: ENDPOINT, cachePath, fetchImpl: fakeHuggingFace() },
    )

    expect(inputs?.weightsBytes).toBe(WEIGHTS_BYTES + 2 * MMPROJ_BYTES)
    expect(requests.filter((r) => r.method === 'HEAD').map((r) => r.url)).toEqual([
      `${ENDPOINT}/owner/repo/resolve/main/Q4_K_M/model-00002-of-00003.gguf`,
      `${ENDPOINT}/owner/repo/resolve/main/Q4_K_M/model-00003-of-00003.gguf`,
    ])
  })

  it('says nothing at all when a shard cannot be sized', async () => {
    const missingShard = (async (url: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return new Response(null, { status: 404 })
      return fakeHuggingFace()(url, init)
    }) as unknown as typeof fetch

    const inputs = await readRemoteLlamaCppVramInputs(
      { name: 'owner/repo/model-00001-of-00002.gguf' },
      { endpoint: ENDPOINT, cachePath, fetchImpl: missingShard },
    )

    expect(inputs).toBeUndefined()
  })

  it('remembers a header across app starts, and re-reads nothing', async () => {
    const options = { endpoint: ENDPOINT, cachePath, fetchImpl: fakeHuggingFace() }
    await readRemoteLlamaCppVramInputs(MODEL, options)
    const reads = requests.length
    clearRemoteGgufCache()

    const inputs = await readRemoteLlamaCppVramInputs(MODEL, options)

    expect(inputs?.weightsBytes).toBe(WEIGHTS_BYTES)
    expect(requests).toHaveLength(reads)
    expect(JSON.parse(fs.readFileSync(cachePath, 'utf8')).models[MODEL.name]).toBeTruthy()
  })

  it('sends the token for a gated repo', async () => {
    const fetchImpl = vi.fn(fakeHuggingFace())
    await readRemoteLlamaCppVramInputs(MODEL, {
      endpoint: ENDPOINT,
      cachePath,
      token: 'hf_secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const headers = new Headers(fetchImpl.mock.calls[0][1]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer hf_secret')
  })
})
