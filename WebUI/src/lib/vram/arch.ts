import type { GgufMetadata, GgufScalar } from './gguf.ts'
import { canEstimateKv } from './kvCache.ts'
import type { GgufArch } from './types.ts'

const DEFAULT_SWA_PERIOD: Record<string, number> = {
  gemma3: 6,
  gemma3n: 6,
}

const ARCH_FIELDS = [
  ['context_length', 'contextLength'],
  ['block_count', 'blockCount'],
  ['embedding_length', 'embeddingLength'],
  ['feed_forward_length', 'feedForwardLength'],
  ['vocab_size', 'vocabSize'],
  ['attention.head_count', 'headCount'],
  ['attention.head_count_kv', 'headCountKv'],
  ['attention.key_length', 'keyLength'],
  ['attention.value_length', 'valueLength'],
  ['attention.sliding_window', 'slidingWindow'],
  ['attention.sliding_window_pattern', 'slidingWindowPattern'],
  ['full_attention_interval', 'fullAttentionInterval'],
  ['attention.kv_lora_rank', 'kvLoraRank'],
  ['attention.key_length_mla', 'keyLengthMla'],
  ['attention.key_length_swa', 'keyLengthSwa'],
  ['attention.value_length_swa', 'valueLengthSwa'],
  ['attention.shared_kv_layers', 'sharedKvLayers'],
  ['ssm.inner_size', 'ssmInnerSize'],
  ['ssm.state_size', 'ssmStateSize'],
  ['ssm.group_count', 'ssmGroupCount'],
  ['ssm.conv_kernel', 'ssmConvKernel'],
  ['nextn_predict_layers', 'nextnPredictLayers'],
] as const satisfies ReadonlyArray<readonly [string, keyof GgufArch]>

export function archFromMetadata(meta: GgufMetadata): GgufArch {
  const arch: GgufArch = { architecture: meta.architecture, vocabSize: meta.vocabSize }
  if (!meta.architecture) return arch
  const prefix = `${meta.architecture}.`

  for (const [suffix, field] of ARCH_FIELDS) {
    const raw = meta.values.get(prefix + suffix)
    if (raw === undefined) continue
    assignArchField(arch, field, raw)
  }

  if (arch.slidingWindowPattern === undefined && arch.blockCount && arch.slidingWindow) {
    const period =
      numberOf(meta.values.get(`${prefix}attention.sliding_window_pattern`)) ??
      (arch.architecture ? DEFAULT_SWA_PERIOD[arch.architecture] : undefined)
    if (period) {
      arch.slidingWindowPattern = Array.from(
        { length: arch.blockCount },
        (_, i) => (i + 1) % period !== 0,
      )
    }
  }

  if (arch.vocabSize === undefined) arch.vocabSize = meta.vocabSize
  return arch
}

/**
 * Whether a header that was cut short still describes the model. GGUF writers
 * emit every `<arch>.*` key before the tokenizer's, and the vocabulary's size is
 * known from the array's length before its (megabytes of) contents — so a parse
 * that reached the tokenizer holds everything the estimator reads. A parse that
 * stopped earlier does not, and the caller must fetch more.
 */
export function archIsSettled(meta: GgufMetadata): boolean {
  if (!meta.truncated) return true
  const reachedTokenizer = [...meta.values.keys()].some((key) => key.startsWith('tokenizer.'))
  return reachedTokenizer && meta.vocabSize !== undefined && canEstimateKv(archFromMetadata(meta))
}

function assignArchField(arch: GgufArch, field: keyof GgufArch, raw: GgufScalar): void {
  if (field === 'slidingWindowPattern') {
    if (Array.isArray(raw)) {
      arch.slidingWindowPattern = raw.map(Boolean)
    }
    return
  }
  if (field === 'headCountKv') {
    if (Array.isArray(raw) && raw.every((n) => typeof n === 'number')) {
      arch.headCountKvByLayer = raw
      arch.headCountKv = Math.max(...raw)
      return
    }
  }
  if (typeof raw === 'number') {
    ;(arch as Record<string, unknown>)[field] = raw
  }
}

function numberOf(raw: GgufScalar | undefined): number | undefined {
  return typeof raw === 'number' ? raw : undefined
}
