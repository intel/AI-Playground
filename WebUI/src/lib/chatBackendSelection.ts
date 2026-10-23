import type { ChatModelConfig } from '@/types/chatIpc'

type ChatReadinessArgs = NonNullable<ChatModelConfig['readiness']>

export type ChatBackendSelection =
  { kind: 'cloud' } | { kind: 'none' } | { kind: 'local'; load: ChatReadinessArgs }

/**
 * Dropdown → last-load snapshot, without starting a backend. Cloud disarms
 * swap-back; a missing model name leaves the previous snapshot alone.
 */
export function chatBackendSelectionLoad(input: {
  backend: 'llamaCPP' | 'openVINO' | 'cloud'
  llmModelName: string | undefined | null
  embeddingModelName: string | undefined | null
  willUseRag: boolean
  contextSize: number | undefined
  llamaCppArgs: string | undefined
}): ChatBackendSelection {
  if (input.backend === 'cloud') return { kind: 'cloud' }
  if (!input.llmModelName) return { kind: 'none' }
  return {
    kind: 'local',
    load: {
      serviceName: input.backend === 'openVINO' ? 'openvino-backend' : 'llamacpp-backend',
      llmModelName: input.llmModelName,
      embeddingModelName: input.willUseRag ? (input.embeddingModelName ?? undefined) : undefined,
      contextSize: input.contextSize,
      modelArgs: input.backend === 'llamaCPP' ? input.llamaCppArgs : undefined,
    },
  }
}

/** Keep Models Loaded skips GPU admission. The 6th IPC arg is this, not inverted. */
export function skipGpuAdmissionFromKeepModelsLoaded(keepModelsLoaded: boolean): boolean {
  return keepModelsLoaded
}
