import type { GgufArch } from './types.ts'
import { DEFAULT_N_UBATCH } from './kvCache.ts'

const COMPUTE_BUFFER_SAFETY = 1.15

/** Vocab-width logits + a few hidden-width scratch tensors. Independent of context. */
export function estimateComputeBufferBytes(
  arch: GgufArch,
  options?: { nUbatch?: number; nParallel?: number },
): number {
  const nVocab = arch.vocabSize ?? 0
  const nEmbd = arch.embeddingLength ?? 0
  if (nVocab <= 0 || nEmbd <= 0) return 0
  const ub = Math.max(1, options?.nUbatch ?? DEFAULT_N_UBATCH)
  const par = Math.max(1, options?.nParallel ?? 1)
  const outBuffer = nVocab * ub * 4
  const actScratch = 4 * nEmbd * ub * 4
  const outputSlots = Math.max(0, par - 1)
  return Math.trunc((actScratch + outBuffer * outputSlots) * COMPUTE_BUFFER_SAFETY)
}
