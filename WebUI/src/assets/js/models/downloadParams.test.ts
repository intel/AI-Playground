import { describe, expect, it } from 'vitest'
import { entriesToDownloadParams } from './downloadParams'
import { modelEntryId, modelLabel } from './library'
import type { ModelEntry } from './types'

const resolvePath = (type: string, backend: string) => `/models/${backend}/${type}`

const entry = (name: string, overrides: Partial<ModelEntry> = {}): ModelEntry => ({
  id: modelEntryId(overrides.pathKey ?? 'ggufLLM', name),
  name,
  label: modelLabel(name),
  useCase: 'llm',
  pathKey: 'ggufLLM',
  serviceBackend: 'llama_cpp',
  source: 'catalog',
  downloaded: false,
  capabilities: {},
  hasCapabilityOverrides: false,
  favorite: false,
  requiredBy: [],
  ...overrides,
})

describe('entriesToDownloadParams', () => {
  it('builds one download per model, with the resolved target directory', () => {
    const params = entriesToDownloadParams([entry('org/repo/model.gguf')], resolvePath)

    expect(params).toEqual([
      {
        repo_id: 'org/repo/model.gguf',
        type: 'ggufLLM',
        backend: 'llama_cpp',
        model_path: '/models/llama_cpp/ggufLLM',
        additionalLicenseLink: undefined,
      },
    ])
  })

  it('queues the mmproj companion, since a vision model is useless without it', () => {
    const params = entriesToDownloadParams(
      [entry('org/repo/vision.gguf', { capabilities: { mmproj: 'org/repo/mmproj.gguf' } })],
      resolvePath,
    )

    expect(params.map((p) => p.repo_id)).toEqual(['org/repo/vision.gguf', 'org/repo/mmproj.gguf'])
  })

  it('deduplicates by repo id, which is what the download dialog keys its rows on', () => {
    const shared = { mmproj: 'org/repo/mmproj.gguf' }
    const params = entriesToDownloadParams(
      [
        entry('org/repo/a.gguf', { capabilities: shared }),
        entry('org/repo/b.gguf', { capabilities: shared }),
      ],
      resolvePath,
    )

    expect(params.map((p) => p.repo_id)).toEqual([
      'org/repo/a.gguf',
      'org/repo/mmproj.gguf',
      'org/repo/b.gguf',
    ])
  })

  it('skips models that are already on disk', () => {
    const params = entriesToDownloadParams(
      [entry('org/repo/here.gguf', { downloaded: true }), entry('org/repo/missing.gguf')],
      resolvePath,
    )

    expect(params.map((p) => p.repo_id)).toEqual(['org/repo/missing.gguf'])
  })

  it('carries the extra licence a media model needs acknowledged', () => {
    const params = entriesToDownloadParams(
      [
        entry('org/repo/sd.safetensors', {
          useCase: 'media',
          pathKey: 'checkpoints',
          serviceBackend: 'comfyui',
          additionalLicenseLink: 'https://example.invalid/licence',
        }),
      ],
      resolvePath,
    )

    expect(params[0]).toMatchObject({
      type: 'checkpoints',
      backend: 'comfyui',
      model_path: '/models/comfyui/checkpoints',
      additionalLicenseLink: 'https://example.invalid/licence',
    })
  })

  it('fetches Qwen3-TTS weights into the OpenVINO tree its sidecar reads from', () => {
    const params = entriesToDownloadParams(
      [
        entry('Qwen/Qwen3-TTS', {
          useCase: 'speech',
          pathKey: 'TTS',
          serviceBackend: 'qwen3_tts',
        }),
      ],
      resolvePath,
    )

    // The download API has no 'qwen3_tts' backend: the sidecar is its own service
    // but its weights live under the OpenVINO directories like every speech model.
    expect(params[0]).toMatchObject({
      repo_id: 'Qwen/Qwen3-TTS',
      type: 'TTS',
      backend: 'openvino',
      model_path: '/models/openvino/TTS',
    })
  })

  it('returns nothing when there is nothing to download', () => {
    expect(entriesToDownloadParams([], resolvePath)).toEqual([])
    expect(
      entriesToDownloadParams([entry('org/repo/a.gguf', { downloaded: true })], resolvePath),
    ).toEqual([])
  })
})
