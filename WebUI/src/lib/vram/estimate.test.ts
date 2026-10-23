import { describe, expect, it } from 'vitest'
import type { GgufArch } from './types.ts'
import { estimateLlamaCppVram, MTP_SPEC_WEIGHT_FRACTION } from './estimate.ts'
import { estimateComputeBufferBytes } from './computeBuffer.ts'
import { canEstimateKv, kvEstimate, mambaRecurrentStateBytes, mtpDraftKvBytes } from './kvCache.ts'
import { padKvCells } from './units.ts'

const QWEN35_9B: GgufArch = {
  architecture: 'qwen35',
  blockCount: 32,
  embeddingLength: 4096,
  feedForwardLength: 12288,
  vocabSize: 248320,
  headCount: 16,
  headCountKv: 4,
  keyLength: 256,
  valueLength: 256,
  fullAttentionInterval: 4,
  ssmInnerSize: 4096,
  ssmStateSize: 128,
  ssmGroupCount: 16,
  ssmConvKernel: 4,
  contextLength: 262144,
}

const QWEN38_27B: GgufArch = {
  architecture: 'qwen35',
  blockCount: 65,
  embeddingLength: 5120,
  feedForwardLength: 17408,
  vocabSize: 248320,
  headCount: 24,
  headCountKv: 4,
  keyLength: 256,
  valueLength: 256,
  fullAttentionInterval: 4,
  ssmInnerSize: 6144,
  ssmStateSize: 128,
  ssmGroupCount: 16,
  ssmConvKernel: 4,
  nextnPredictLayers: 1,
  contextLength: 262144,
}

const GQA: GgufArch = {
  architecture: 'llama',
  blockCount: 32,
  embeddingLength: 4096,
  vocabSize: 128256,
  headCount: 32,
  headCountKv: 8,
  keyLength: 128,
  valueLength: 128,
}

const MLA: GgufArch = {
  architecture: 'deepseek2',
  blockCount: 60,
  embeddingLength: 5120,
  vocabSize: 102400,
  headCount: 128,
  headCountKv: 1,
  kvLoraRank: 512,
  keyLength: 576,
  keyLengthMla: 64,
}

const CTX = 32768
const CELLS = padKvCells(CTX)

describe('kvEstimate paths', () => {
  it('uses the hybrid path for Qwen3.5 (only 1 in 4 layers hold KV)', () => {
    const { path, bytes } = kvEstimate(QWEN35_9B, { contextSize: CTX })
    expect(path).toBe('hybrid')
    const nAttn = 8
    const kvPerCell = 4 * 256 * 2 + 4 * 256 * 2
    const kv = nAttn * CELLS * kvPerCell
    const recurrent = mambaRecurrentStateBytes(QWEN35_9B)
    expect(bytes).toBe(kv + recurrent)
    expect(recurrent).toBeGreaterThan(0)
  })

  it('would over-count Qwen3.5 if it treated every block as attention', () => {
    const hybrid = kvEstimate(QWEN35_9B, { contextSize: CTX }).bytes
    const asGqa = kvEstimate(
      { ...QWEN35_9B, ssmInnerSize: undefined, fullAttentionInterval: undefined },
      { contextSize: CTX },
    )
    expect(asGqa.path).toBe('gqa')
    expect(asGqa.bytes).toBeGreaterThan(hybrid * 3)
  })

  it('drops the embedded MTP block from Qwen3.8 target KV', () => {
    const withMtpHead = kvEstimate(QWEN38_27B, { contextSize: CTX })
    const trunkOnly = kvEstimate(
      { ...QWEN38_27B, blockCount: 64, nextnPredictLayers: 0 },
      { contextSize: CTX },
    )
    expect(withMtpHead.path).toBe('hybrid')
    expect(withMtpHead.bytes).toBe(trunkOnly.bytes)
    expect(mtpDraftKvBytes(QWEN38_27B, { contextSize: CTX })).toBe(4 * (256 * 2 + 256 * 2) * CTX)
  })

  it('uses MLA (K-only, one latent head) instead of 128 GQA heads', () => {
    const { path, bytes } = kvEstimate(MLA, { contextSize: CTX })
    expect(path).toBe('mla')
    expect(bytes).toBe(60 * CELLS * 1 * 576 * 2)
    const naiveGqaHeads = 128
    expect(bytes).toBeLessThan(naiveGqaHeads * bytes)
  })

  it('sizes SWA layers at the window, not the full context', () => {
    const swa: GgufArch = {
      architecture: 'gemma3',
      blockCount: 18,
      embeddingLength: 2048,
      vocabSize: 262144,
      headCount: 8,
      headCountKv: 2,
      keyLength: 256,
      valueLength: 256,
      slidingWindow: 512,
      slidingWindowPattern: Array.from({ length: 18 }, (_, i) => (i + 1) % 6 !== 0),
    }
    const { path, bytes } = kvEstimate(swa, { contextSize: CTX })
    expect(path).toBe('swa')
    const nGlobal = 3
    const nSwa = 15
    const kvPerToken = 2 * 256 * 2 + 2 * 256 * 2
    const swaCells = padKvCells(Math.min(CELLS, 512 * 1 + 512))
    expect(bytes).toBe(nGlobal * CELLS * kvPerToken + nSwa * swaCells * kvPerToken)
    const fullCtx = kvEstimate(
      { ...swa, slidingWindow: undefined, slidingWindowPattern: undefined },
      { contextSize: CTX },
    )
    expect(bytes).toBeLessThan(fullCtx.bytes)
  })

  it('falls back to embed/n_heads when key/value dims are missing', () => {
    const { path, bytes } = kvEstimate(
      {
        architecture: 'llama',
        blockCount: 4,
        embeddingLength: 1024,
        headCount: 8,
        headCountKv: 2,
      },
      { contextSize: 1024 },
    )
    expect(path).toBe('gqa')
    expect(bytes).toBe(2 * 2 * 128 * 4 * padKvCells(1024) * 2)
  })

  it('skips zero-KV layers when head_count_kv is per-layer (LFM2)', () => {
    const cells = padKvCells(1024)
    const headDim = 1024 / 16
    const withHoles: GgufArch = {
      architecture: 'lfm2',
      blockCount: 4,
      embeddingLength: 1024,
      headCount: 16,
      headCountKv: 16,
      headCountKvByLayer: [0, 0, 16, 0],
    }
    const { path, bytes } = kvEstimate(withHoles, { contextSize: 1024 })
    expect(path).toBe('gqa')
    expect(bytes).toBe(16 * headDim * 2 * 2 * cells)
    const allAttn = kvEstimate(
      { ...withHoles, headCountKvByLayer: undefined },
      { contextSize: 1024 },
    )
    expect(allAttn.bytes).toBe(bytes * 4)
  })

  it('cannot estimate without a layer count', () => {
    expect(canEstimateKv({ embeddingLength: 4096, headCount: 16 })).toBe(false)
  })
})

describe('estimateLlamaCppVram', () => {
  it('adds weights, KV, recurrent state, and compute for Qwen3.5-9B', () => {
    const weights = 6 * 1024 * 1024 * 1024
    const estimate = estimateLlamaCppVram({
      arch: QWEN35_9B,
      weightsBytes: weights,
      contextSize: CTX,
    })
    expect(estimate.kvPath).toBe('hybrid')
    expect(estimate.weightsBytes).toBe(weights)
    expect(estimate.kvCacheBytes).toBe(8 * CELLS * (4 * 256 * 2 + 4 * 256 * 2))
    expect(estimate.recurrentStateBytes).toBe(mambaRecurrentStateBytes(QWEN35_9B))
    expect(estimate.computeBufferBytes).toBe(estimateComputeBufferBytes(QWEN35_9B))
    expect(estimate.mtpBytes).toBe(0)
    expect(estimate.totalBytes).toBe(
      estimate.weightsBytes +
        estimate.kvCacheBytes +
        estimate.recurrentStateBytes +
        estimate.computeBufferBytes,
    )
  })

  it('adds mmproj bytes to weights', () => {
    const estimate = estimateLlamaCppVram({
      arch: GQA,
      weightsBytes: 1000,
      mmprojBytes: 250,
      contextSize: 2048,
    })
    expect(estimate.weightsBytes).toBe(1250)
  })

  it('charges embedded MTP KV plus a fraction of GGUF weights when draft-mtp is on', () => {
    const weights = 8 * 1024 * 1024 * 1024
    const off = estimateLlamaCppVram({
      arch: QWEN38_27B,
      weightsBytes: weights,
      contextSize: CTX,
    })
    const on = estimateLlamaCppVram({
      arch: QWEN38_27B,
      weightsBytes: weights,
      contextSize: CTX,
      mtp: true,
    })
    expect(off.mtpBytes).toBe(0)
    expect(on.mtpBytes).toBe(
      mtpDraftKvBytes(QWEN38_27B, { contextSize: CTX }) +
        Math.trunc(weights * MTP_SPEC_WEIGHT_FRACTION),
    )
    expect(on.totalBytes).toBe(off.totalBytes + on.mtpBytes)
    expect(on.kvCacheBytes).toBe(off.kvCacheBytes)
  })

  it('uses a one-slot compute buffer (no extra logit planes)', () => {
    const one = estimateComputeBufferBytes(QWEN35_9B, { nParallel: 1 })
    const two = estimateComputeBufferBytes(QWEN35_9B, { nParallel: 2 })
    expect(two).toBeGreaterThan(one)
  })
})
