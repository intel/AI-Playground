import type { GgufArch, KvPath, LlamaCppRuntime } from './types.ts'
import { kvBytesPerElem, padKvCells } from './units.ts'

export const DEFAULT_N_UBATCH = 512

const TARGET_KV_EXCLUDES_NEXTN = new Set([
  'qwen3next',
  'qwen35',
  'qwen35moe',
  'minimax-01',
  'nemotron_h',
  'nemotron_h_moe',
  'glm-dsa',
  'deepseek32',
  'glm5next',
  'glm5-next',
  'step35',
  'hy_v3',
  'mimo2',
])

export function canEstimateKv(arch: GgufArch): boolean {
  if (arch.blockCount === undefined) return false
  if (arch.kvLoraRank !== undefined) return true
  if (arch.keyLength !== undefined && arch.valueLength !== undefined) return true
  return (
    arch.embeddingLength !== undefined &&
    (arch.headCountKv !== undefined ||
      arch.headCount !== undefined ||
      (arch.headCountKvByLayer?.length ?? 0) > 0)
  )
}

export function estimateKvCacheBytes(arch: GgufArch, runtime: LlamaCppRuntime): number {
  return kvEstimate(arch, runtime).bytes
}

export function kvEstimate(
  arch: GgufArch,
  runtime: LlamaCppRuntime,
): { bytes: number; path: KvPath } {
  const nCtx = runtime.contextSize
  if (!canEstimateKv(arch) || nCtx <= 0) return { bytes: 0, path: 'none' }

  const flashAttention = runtime.flashAttention !== false
  const nParallel = Math.max(1, runtime.nParallel ?? 1)
  const kvUnified = runtime.kvUnified !== false
  const swaFull = runtime.swaFull === true
  const ubatch = Math.max(0, runtime.nUbatch ?? DEFAULT_N_UBATCH)
  const bpeK = kvBytesPerElem(runtime.cacheTypeKv)
  const bpeV = flashAttention ? bpeK : Math.max(bpeK, kvBytesPerElem('f16'))

  const nLayers = targetLayerCount(arch)
  const shared = arch.sharedKvLayers ?? 0
  const nLayersKv = Math.max(1, nLayers - shared)
  const nKv = arch.headCountKv ?? arch.headCount ?? 1
  const { totalCells, slots, streams, cellsPerStream } = kvCellLayout(nCtx, nParallel, kvUnified)

  if (arch.kvLoraRank !== undefined) {
    const nKvMla = arch.headCountKv ?? 1
    const ropeDim = arch.keyLengthMla ?? 64
    const keyLen = arch.keyLength ?? arch.kvLoraRank + ropeDim
    let nMlaLayers = nLayersKv
    if (arch.headCountKvByLayer) {
      const attn = countLayers(nLayersKv, (i) => kvHeadsForLayer(arch, i, nKvMla) > 0)
      nMlaLayers = Math.max(1, attn)
    }
    return {
      path: 'mla',
      bytes: Math.trunc(nMlaLayers * totalCells * nKvMla * keyLen * bpeK),
    }
  }

  const headDim = legacyHeadDim(arch)
  const keyLen = arch.keyLength ?? headDim
  const valLen = arch.valueLength ?? headDim

  if (arch.ssmInnerSize !== undefined && arch.fullAttentionInterval !== undefined) {
    const fai = arch.fullAttentionInterval
    const nAttn = fai > 0 ? Math.ceil(nLayers / fai) : nLayers
    const recurrent = mambaRecurrentStateBytes(arch, nParallel)
    const vWidth = nKv * valLen
    return {
      path: 'hybrid',
      bytes: Math.trunc(nAttn * totalCells * (nKv * keyLen * bpeK + vWidth * bpeV)) + recurrent,
    }
  }

  if (arch.slidingWindow !== undefined && arch.slidingWindow > 0) {
    const swa = arch.slidingWindow
    const swaCellsTotal = swaFull
      ? totalCells
      : padKvCells(Math.min(cellsPerStream, swa * (kvUnified ? slots : 1) + ubatch)) * streams
    const keyLenSwa = arch.keyLengthSwa ?? keyLen
    const valLenSwa = arch.valueLengthSwa ?? valLen
    const pattern = arch.slidingWindowPattern
    if (pattern) {
      let globalBytes = 0
      let swaBytes = 0
      for (let layerIdx = 0; layerIdx < nLayersKv; layerIdx++) {
        const layerNKv = kvHeadsForLayer(arch, layerIdx, nKv)
        const isSwa = layerIdx < pattern.length && pattern[layerIdx] === true
        const layerKey = layerNKv * (isSwa ? keyLenSwa : keyLen) * bpeK
        const layerVal = layerNKv * (isSwa ? valLenSwa : valLen) * bpeV
        const layerKv = layerKey + layerVal
        if (isSwa) swaBytes += swaCellsTotal * layerKv
        else globalBytes += totalCells * layerKv
      }
      return { path: 'swa', bytes: Math.trunc(globalBytes + swaBytes) }
    }
    const nGlobal = Math.max(1, Math.floor(nLayersKv / 4))
    const nSwa = nLayersKv - nGlobal
    const kvPerToken = nKv * keyLen * bpeK + nKv * valLen * bpeV
    const kvPerTokenSwa = nKv * keyLenSwa * bpeK + nKv * valLenSwa * bpeV
    return {
      path: 'swa',
      bytes: Math.trunc(nGlobal * totalCells * kvPerToken + nSwa * swaCellsTotal * kvPerTokenSwa),
    }
  }

  let bytesPerCell = 0
  for (let layerIdx = 0; layerIdx < nLayersKv; layerIdx++) {
    const layerNKv = kvHeadsForLayer(arch, layerIdx, nKv)
    bytesPerCell += layerNKv * keyLen * bpeK + layerNKv * valLen * bpeV
  }
  return { path: 'gqa', bytes: Math.trunc(totalCells * bytesPerCell) }
}

export function mambaRecurrentStateBytes(arch: GgufArch, nParallel = 1, nRsSeq = 0): number {
  const nLayersRaw = arch.blockCount
  const dInner = arch.ssmInnerSize
  const dState = arch.ssmStateSize
  const nGroup = arch.ssmGroupCount
  const dConv = arch.ssmConvKernel
  const fai = arch.fullAttentionInterval
  if (
    nLayersRaw === undefined ||
    dInner === undefined ||
    dState === undefined ||
    nGroup === undefined ||
    dConv === undefined ||
    fai === undefined
  ) {
    return 0
  }
  const nLayers = Math.max(0, nLayersRaw - (arch.nextnPredictLayers ?? 0))
  const nAttn = fai > 0 ? Math.ceil(nLayers / fai) : nLayers
  const nRecurrent = Math.max(0, nLayers - nAttn)
  if (nRecurrent === 0) return 0
  const nEmbdR = Math.max(0, dConv - 1) * (dInner + 2 * nGroup * dState)
  const nEmbdS = dState * dInner
  return Math.trunc(
    nRecurrent * (nEmbdR + nEmbdS) * 4 * Math.max(1, nParallel) * Math.max(1, 1 + nRsSeq),
  )
}

export function mtpDraftKvBytes(arch: GgufArch, runtime: LlamaCppRuntime): number {
  const nextn = arch.nextnPredictLayers ?? 0
  const nKv = arch.headCountKv ?? arch.headCount
  const keyLen = arch.keyLength
  const valLen = arch.valueLength
  if (!nextn || !nKv || keyLen === undefined || valLen === undefined) return 0
  const nCtx = runtime.contextSize
  if (nCtx <= 0) return 0
  const bpe = Math.max(kvBytesPerElem(runtime.cacheTypeKv), kvBytesPerElem('f16'))
  return Math.trunc(nextn * nKv * (keyLen * bpe + valLen * bpe) * nCtx)
}

export function targetKvExcludesNextn(arch: GgufArch): boolean {
  if (!arch.nextnPredictLayers) return false
  if (arch.ssmInnerSize !== undefined && arch.fullAttentionInterval !== undefined) return true
  const name = arch.architecture?.trim().toLowerCase()
  return name !== undefined && TARGET_KV_EXCLUDES_NEXTN.has(name)
}

function targetLayerCount(arch: GgufArch): number {
  const nLayers = arch.blockCount ?? 0
  if (!targetKvExcludesNextn(arch)) return nLayers
  return Math.max(1, nLayers - (arch.nextnPredictLayers ?? 0))
}

function kvHeadsForLayer(arch: GgufArch, layerIndex: number, fallback: number): number {
  const byLayer = arch.headCountKvByLayer
  if (byLayer && layerIndex < byLayer.length) return byLayer[layerIndex] ?? fallback
  return fallback
}

function countLayers(n: number, pred: (i: number) => boolean): number {
  let count = 0
  for (let i = 0; i < n; i++) if (pred(i)) count += 1
  return count
}

function legacyHeadDim(arch: GgufArch): number {
  if (arch.embeddingLength && arch.headCount) return arch.embeddingLength / arch.headCount
  return 128
}

function kvCellLayout(
  nCtx: number,
  nParallel: number,
  kvUnified: boolean,
): { slots: number; streams: number; cellsPerStream: number; totalCells: number } {
  const slots = Math.max(1, nParallel)
  const paddedCtx = padKvCells(nCtx)
  const streams = kvUnified ? 1 : slots
  const cellsPerStream = kvUnified ? paddedCtx : padKvCells(Math.floor(paddedCtx / slots))
  return { slots, streams, cellsPerStream, totalCells: cellsPerStream * streams }
}
