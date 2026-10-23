import type { GgufArch, LlamaCppRuntime, LlamaCppVramEstimate } from './types.ts'
import { estimateComputeBufferBytes } from './computeBuffer.ts'
import { kvEstimate, mambaRecurrentStateBytes, mtpDraftKvBytes } from './kvCache.ts'

// GGUF-header math only: no llama-server, no GPU sampler, no media pipeline.
// Weights ≈ file size because AIPG launches with `--gpu-layers 999 --no-mmap`.

/** Extra working set for `--spec-type draft-mtp` on top of nextn KV (~23–25% of GGUF). */
export const MTP_SPEC_WEIGHT_FRACTION = 0.25

export type EstimateInput = LlamaCppRuntime & {
  arch: GgufArch
  /** GGUF file size (sum of shards). Full offload + `--no-mmap` ≈ VRAM weights. */
  weightsBytes: number
  mmprojBytes?: number
}

export function estimateLlamaCppVram(input: EstimateInput): LlamaCppVramEstimate {
  const { arch, weightsBytes, mmprojBytes = 0, ...runtime } = input
  const kv = kvEstimate(arch, runtime)
  const recurrent = mambaRecurrentStateBytes(arch, runtime.nParallel ?? 1)
  const kvBytes = kv.path === 'hybrid' ? Math.max(0, kv.bytes - recurrent) : kv.bytes
  const compute = estimateComputeBufferBytes(arch, {
    nUbatch: runtime.nUbatch,
    nParallel: runtime.nParallel,
  })
  const weights = Math.max(0, weightsBytes) + Math.max(0, mmprojBytes)
  const mtp =
    runtime.mtp && (arch.nextnPredictLayers ?? 0) > 0
      ? mtpDraftKvBytes(arch, runtime) +
        Math.trunc(Math.max(0, weightsBytes) * MTP_SPEC_WEIGHT_FRACTION)
      : 0
  return {
    weightsBytes: weights,
    kvCacheBytes: kvBytes,
    recurrentStateBytes: recurrent,
    computeBufferBytes: compute,
    mtpBytes: mtp,
    totalBytes: weights + kvBytes + recurrent + compute + mtp,
    kvPath: kv.path,
  }
}
