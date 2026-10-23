import { describe, expect, it } from 'vitest'
import {
  chatBackendSelectionLoad,
  skipGpuAdmissionFromKeepModelsLoaded,
} from '@/lib/chatBackendSelection'

describe('chatBackendSelectionLoad', () => {
  it('disarms cloud without a load snapshot', () => {
    expect(
      chatBackendSelectionLoad({
        backend: 'cloud',
        llmModelName: 'gpt-4',
        embeddingModelName: 'bge',
        willUseRag: true,
        contextSize: 8192,
        llamaCppArgs: '--jinja',
      }),
    ).toEqual({ kind: 'cloud' })
  })

  it('leaves last-load alone when no model is selected', () => {
    expect(
      chatBackendSelectionLoad({
        backend: 'llamaCPP',
        llmModelName: undefined,
        embeddingModelName: 'bge',
        willUseRag: false,
        contextSize: 8192,
        llamaCppArgs: '--jinja',
      }),
    ).toEqual({ kind: 'none' })
  })

  it('notes the dropdown for a local llama.cpp selection', () => {
    expect(
      chatBackendSelectionLoad({
        backend: 'llamaCPP',
        llmModelName: 'Qwen3-9B',
        embeddingModelName: 'bge',
        willUseRag: true,
        contextSize: 8192,
        llamaCppArgs: '--jinja',
      }),
    ).toEqual({
      kind: 'local',
      load: {
        serviceName: 'llamacpp-backend',
        llmModelName: 'Qwen3-9B',
        embeddingModelName: 'bge',
        contextSize: 8192,
        modelArgs: '--jinja',
      },
    })
  })

  it('omits embedding and llama.cpp args for OpenVINO without RAG', () => {
    expect(
      chatBackendSelectionLoad({
        backend: 'openVINO',
        llmModelName: 'Qwen3-8B',
        embeddingModelName: 'bge',
        willUseRag: false,
        contextSize: 4096,
        llamaCppArgs: '--jinja',
      }),
    ).toEqual({
      kind: 'local',
      load: {
        serviceName: 'openvino-backend',
        llmModelName: 'Qwen3-8B',
        embeddingModelName: undefined,
        contextSize: 4096,
        modelArgs: undefined,
      },
    })
  })
})

describe('skipGpuAdmissionFromKeepModelsLoaded', () => {
  it('admits the GPU when Keep Models Loaded is off', () => {
    expect(skipGpuAdmissionFromKeepModelsLoaded(false)).toBe(false)
  })

  it('skips GPU admission when Keep Models Loaded is on', () => {
    expect(skipGpuAdmissionFromKeepModelsLoaded(true)).toBe(true)
  })
})
