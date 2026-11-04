import { describe, expect, it } from 'vitest'
import { storedSessionInference, type StoredInferenceCatalog } from '@/lib/storedSessionInference'

// What a turn runs on when it is built from an Agent Session's stored settings
// rather than from the live panel controls: the same model, backend, window and
// sampling the session chose, on the machine's selected device, resolved against today's catalogs.

const catalog = (overrides: Partial<StoredInferenceCatalog> = {}): StoredInferenceCatalog => ({
  models: [
    { name: 'First-4B', type: 'llamaCPP' },
    {
      name: 'Stored-27B',
      type: 'llamaCPP',
      supportsVision: true,
      supportsThinkingToggle: true,
      maxContextSize: 32768,
      llamaCppArgs: '--spec-type draft-mtp',
      inferenceDefaults: {
        topP: 0.95,
        thinking: { temperature: 0.6, topK: 20 },
        instruct: { temperature: 0.7, topK: 40 },
      },
    },
    { name: 'Ov-8B', type: 'openVINO', maxContextSize: 65536 },
  ],
  embeddingModels: [
    { name: 'bge-small', type: 'llamaCPP', downloaded: true },
    { name: 'bge-large', type: 'llamaCPP', downloaded: false },
  ],
  services: [
    {
      backend: 'llamaCPP',
      baseUrl: 'http://127.0.0.1:39100',
      devices: [
        { id: '0', name: 'Arc B580', selected: true },
        { id: '1', name: 'Arc A770', uuid: 'uuid-a770' },
      ],
    },
    {
      backend: 'openVINO',
      baseUrl: 'http://127.0.0.1:29000',
      devices: [
        { id: 'GPU.0', name: 'Arc B580', selected: true },
        { id: 'NPU', name: 'Intel NPU' },
      ],
    },
  ],
  cloudProviders: [],
  selectedCloudProviderId: 'custom',
  cloudEmbeddingBackend: 'llamaCPP',
  ...overrides,
})

describe('storedSessionInference', () => {
  it('runs a local session on its stored model and that backend’s server', () => {
    const { inference } = storedSessionInference(
      {
        backend: 'llamaCPP',
        selectedModels: { llamaCPP: 'Stored-27B' },
        contextSize: 131072,
        requestedContextSize: 131072,
      },
      catalog(),
    )

    expect(inference.backend).toBe('llamaCPP')
    expect(inference.activeModel).toBe('Stored-27B')
    expect(inference.localBackendUrl).toBe('http://127.0.0.1:39100')
    expect(inference.modelSupportsVision).toBe(true)
    expect(inference.modelSupportsThinkingToggle).toBe(true)
    expect(inference.activeLlmModel?.llamaCppArgs).toBe('--spec-type draft-mtp')
    // Bounded by the model's ceiling, the way the live controls bound it.
    expect(inference.contextSize).toBe(32768)
    expect(inference.effectiveContextWindow).toBe(32768)
  })

  it('falls back to the backend’s first model when the stored one is gone', () => {
    const { inference } = storedSessionInference(
      { backend: 'llamaCPP', selectedModels: { llamaCPP: 'Deleted-9B' } },
      catalog(),
    )
    expect(inference.activeModel).toBe('First-4B')
  })

  it('samples the way the model recommends for the stored thinking state', () => {
    const thinking = storedSessionInference(
      { backend: 'llamaCPP', selectedModels: { llamaCPP: 'Stored-27B' } },
      catalog(),
    ).inference
    expect(thinking.thinkingEnabled).toBe(true)
    expect(thinking.thinkingActive).toBe(true)
    expect(thinking.temperature).toBe(0.6)
    expect(thinking.samplingRequestBody).toEqual({ top_p: 0.95, top_k: 20 })

    const instruct = storedSessionInference(
      { backend: 'llamaCPP', selectedModels: { llamaCPP: 'Stored-27B' }, thinkingEnabled: false },
      catalog(),
    ).inference
    expect(instruct.thinkingActive).toBe(false)
    expect(instruct.temperature).toBe(0.7)
    expect(instruct.samplingRequestBody).toEqual({ top_p: 0.95, top_k: 40 })
  })

  it('keeps a temperature the user chose', () => {
    const { inference } = storedSessionInference(
      { backend: 'llamaCPP', selectedModels: { llamaCPP: 'Stored-27B' }, temperature: 0.2 },
      catalog(),
    )
    expect(inference.temperature).toBe(0.2)
  })

  it('runs on the selected device, ignoring one an older Session stored', () => {
    const { inference } = storedSessionInference(
      {
        backend: 'llamaCPP',
        selectedModels: { llamaCPP: 'Stored-27B' },
        selectedDeviceId: 'gone',
        selectedDeviceUuid: 'uuid-a770',
      },
      catalog(),
    )
    expect(inference.getCurrentDeviceId()).toBe('0')
    expect(inference.getCurrentDeviceName()).toBe('Arc B580')
  })

  it('caps the window for an OpenVINO session while the NPU is selected', () => {
    const { inference } = storedSessionInference(
      { backend: 'openVINO', selectedModels: { openVINO: 'Ov-8B' }, contextSize: 32768 },
      catalog({
        services: [
          {
            backend: 'openVINO',
            baseUrl: 'http://127.0.0.1:29000',
            devices: [
              { id: 'GPU.0', name: 'Arc B580' },
              { id: 'NPU', name: 'Intel NPU', selected: true },
            ],
          },
        ],
      }),
    )
    expect(inference.localBackendUrl).toBe('http://127.0.0.1:29000')
    expect(inference.contextSize).toBe(32768)
    expect(inference.effectiveContextWindow).toBe(8192)
  })

  it('uses the stored embedding model for document search', () => {
    const { inference } = storedSessionInference(
      {
        backend: 'llamaCPP',
        selectedModels: { llamaCPP: 'Stored-27B' },
        selectedEmbeddingModels: { llamaCPP: 'bge-large' },
      },
      catalog(),
    )
    expect(inference.embeddingBackend).toBe('llamaCPP')
    expect(inference.activeEmbeddingModel).toBe('bge-large')
    expect(inference.llmEmbeddingModels).toHaveLength(2)
  })

  it('runs a cloud session on its stored provider, not the selected one', () => {
    const { inference, cloud } = storedSessionInference(
      { backend: 'cloud', cloudProviderId: 'other', selectedModels: { cloud: 'big-model' } },
      catalog({
        selectedCloudProviderId: 'custom',
        cloudProviders: [
          {
            id: 'custom',
            baseUrl: 'https://custom.example',
            models: ['custom-model'],
            capabilitiesFor: () => ({ supportsVision: true, reasoningAdvertised: false }),
          },
          {
            id: 'other',
            baseUrl: 'https://other.example/v1/',
            authStyle: 'x-api-key',
            models: ['small-model', 'big-model'],
            capabilitiesFor: (name) => ({
              supportsVision: false,
              reasoningAdvertised: name === 'big-model',
              contextLength: 200000,
            }),
          },
        ],
      }),
    )

    expect(inference.backend).toBe('cloud')
    expect(inference.activeModel).toBe('big-model')
    expect(inference.modelSupportsVision).toBe(false)
    expect(inference.samplingRequestBody).toEqual({})
    expect(inference.effectiveContextWindow).toBe(200000)
    expect(cloud.selectedProviderId).toBe('other')
    expect(cloud.activeProviderBaseUrl).toBe('https://other.example')
    expect(cloud.activeProviderAuthStyle).toBe('x-api-key')
    expect(cloud.capabilitiesFor('big-model').reasoningAdvertised).toBe(true)
  })

  it('carries the stored tool toggles', () => {
    const defaults = storedSessionInference({ backend: 'llamaCPP' }, catalog()).tools
    expect(defaults).toEqual({ toolDelegationEnabled: true, builtinToolEnablement: {} })

    const stored = storedSessionInference(
      {
        backend: 'llamaCPP',
        toolDelegationEnabled: false,
        builtinToolEnablement: { transcribeAudio: false },
      },
      catalog(),
    ).tools
    expect(stored).toEqual({
      toolDelegationEnabled: false,
      builtinToolEnablement: { transcribeAudio: false },
    })
  })
})
