import { describe, expect, it } from 'vitest'
import { repairChatSettings, type ChatSettingsAvailability } from '@/lib/chatSettingsRepair'

const available = (
  overrides: Partial<ChatSettingsAvailability> = {},
): ChatSettingsAvailability => ({
  presetBackends: ['llamaCPP', 'openVINO'],
  cloudEnabled: false,
  runningBackends: [],
  models: [],
  ...overrides,
})

describe('repairChatSettings: backend', () => {
  it('keeps a saved backend the preset allows', () => {
    expect(repairChatSettings({ backend: 'openVINO' }, available()).backend).toBe('openVINO')
  })

  it('replaces a disallowed saved backend with the running one', () => {
    const result = repairChatSettings(
      { backend: 'cloud' },
      available({ runningBackends: ['openVINO'] }),
    )
    expect(result.backend).toBe('openVINO')
  })

  it("falls back to the preset's first backend when none is running", () => {
    expect(repairChatSettings({ backend: 'cloud' }, available()).backend).toBe('llamaCPP')
  })

  it('picks the only allowed backend without looking at what runs', () => {
    const result = repairChatSettings(
      {},
      available({ presetBackends: ['openVINO'], runningBackends: ['llamaCPP'] }),
    )
    expect(result.backend).toBe('openVINO')
  })

  it('keeps a saved cloud backend only while Cloud Mode is on', () => {
    expect(
      repairChatSettings({ backend: 'cloud' }, available({ cloudEnabled: true })).backend,
    ).toBe('cloud')
    expect(repairChatSettings({ backend: 'cloud' }, available()).backend).toBe('llamaCPP')
  })

  it('leaves the backend unset when the preset declares none', () => {
    expect(repairChatSettings({}, available({ presetBackends: [] })).backend).toBeUndefined()
  })
})

describe('repairChatSettings: model', () => {
  const models = [
    { name: 'Qwen3-9B', type: 'llamaCPP' as const },
    { name: 'Phi-4', type: 'openVINO' as const },
  ]

  it('keeps a saved model that exists for the backend', () => {
    const result = repairChatSettings(
      { backend: 'llamaCPP', model: 'Qwen3-9B' },
      available({ models }),
    )
    expect(result.model).toBe('Qwen3-9B')
  })

  it('drops a saved model that is gone, leaving the choice to the model picker', () => {
    const result = repairChatSettings(
      { backend: 'llamaCPP', model: 'Deleted-7B' },
      available({ models, presetPreferredModels: { llamaCPP: 'Qwen3-9B' } }),
    )
    expect(result.model).toBeUndefined()
  })

  it("uses the preset's preferred model when none was saved and it exists", () => {
    const result = repairChatSettings(
      { backend: 'llamaCPP' },
      available({ models, presetPreferredModels: { llamaCPP: 'Qwen3-9B' } }),
    )
    expect(result.model).toBe('Qwen3-9B')
  })

  it('ignores a preferred model that belongs to another backend', () => {
    const result = repairChatSettings(
      { backend: 'llamaCPP' },
      available({ models, presetPreferredModels: { llamaCPP: 'Phi-4' } }),
    )
    expect(result.model).toBeUndefined()
  })
})
