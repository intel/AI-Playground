import { describe, expect, it } from 'vitest'
import {
  fillMissingSessionSettings,
  keepUneditedSettings,
  sessionSettingsFromBag,
  sessionSettingsToBag,
  updateSessionSettingsFromBag,
  usesSessionSettings,
  withoutSessionOwnedKeys,
} from '@/lib/agentSessionSettings'

describe('usesSessionSettings', () => {
  it('is true for the Agent preset only', () => {
    expect(usesSessionSettings({ name: 'Agent', agentPreset: true })).toBe(true)
    expect(usesSessionSettings({ name: 'Game Agent', agentPreset: true })).toBe(false)
    expect(usesSessionSettings({ name: 'Quick Coder', agentPreset: true })).toBe(false)
    expect(usesSessionSettings({ name: 'Assistant' })).toBe(false)
    expect(usesSessionSettings(null)).toBe(false)
  })

  it('is true for an agent preset saved from an Agent', () => {
    expect(
      usesSessionSettings({ name: 'Morning news', agentPreset: true, agentTaskId: 't1' }),
    ).toBe(true)
    expect(usesSessionSettings({ name: 'Morning news', agentTaskId: 't1' })).toBe(false)
  })
})

describe('Session Settings ↔ settings bag', () => {
  it('reads the backend and the model selected for that backend', () => {
    const bag = {
      backend: 'openVINO',
      selectedModels: { llamaCPP: 'Qwen3-9B', openVINO: 'Phi-4', cloud: null },
      temperature: 0.7,
    }
    expect(sessionSettingsFromBag(bag)).toEqual({ backend: 'openVINO', model: 'Phi-4' })
  })

  it('leaves the model out while none is selected for the backend', () => {
    expect(
      sessionSettingsFromBag({ backend: 'llamaCPP', selectedModels: { llamaCPP: null } }),
    ).toEqual({ backend: 'llamaCPP' })
  })

  it('writes the session model into the backend slot, keeping the other backends', () => {
    const bag = sessionSettingsToBag(
      { backend: 'llamaCPP', model: 'Qwen3-9B' },
      { selectedModels: { llamaCPP: 'Other', openVINO: 'Phi-4' }, contextSize: 4096 },
    )
    expect(bag).toEqual({
      backend: 'llamaCPP',
      selectedModels: { llamaCPP: 'Qwen3-9B', openVINO: 'Phi-4' },
      contextSize: 4096,
    })
  })

  it('drops the keys a session owns, so editing a session never rewrites the defaults', () => {
    expect(
      withoutSessionOwnedKeys({
        backend: 'llamaCPP',
        selectedModels: { llamaCPP: 'X' },
        selectedEmbeddingModels: { llamaCPP: 'bge' },
        contextSize: 4096,
        requestedContextSize: 4096,
        contextSizeEdited: true,
        thinkingEnabled: false,
        toolDelegationEnabled: true,
        builtinToolEnablement: {},
        builtinToolPresetEnablement: {},
        builtinToolDefaultPresets: {},
        cloudProviderId: 'zai',
        temperature: 0.7,
      }),
    ).toEqual({ temperature: 0.7 })
  })

  it('does not count the device among the keys a Session owns', () => {
    expect(
      withoutSessionOwnedKeys({ selectedDeviceId: 'GPU.0', selectedDeviceUuid: 'u-arc' }),
    ).toEqual({ selectedDeviceId: 'GPU.0', selectedDeviceUuid: 'u-arc' })
  })

  it('clears a model that no longer matches the backend after a backend change', () => {
    const next = updateSessionSettingsFromBag(
      { backend: 'llamaCPP', model: 'Qwen3-9B', capabilities: ['web'] },
      { backend: 'openVINO', selectedModels: { llamaCPP: 'Qwen3-9B', openVINO: null } },
    )
    expect(next).toEqual({ backend: 'openVINO', capabilities: ['web'] })
  })

  const fullBag = {
    backend: 'llamaCPP',
    selectedModels: { llamaCPP: 'Qwen3-9B', openVINO: 'Phi-4' },
    selectedDeviceId: 'GPU.1',
    selectedDeviceUuid: 'u-igpu',
    selectedEmbeddingModels: { llamaCPP: 'bge-small', openVINO: 'bge-ov' },
    contextSize: 16384,
    requestedContextSize: 65536,
    contextSizeEdited: true,
    thinkingEnabled: false,
    toolDelegationEnabled: false,
    builtinToolEnablement: { captureScreenshot: true },
    builtinToolPresetEnablement: { Flux: false },
    builtinToolDefaultPresets: { 'comfyUI:image': 'Z-Image' },
    cloudProviderId: 'zai',
    temperature: 0.7,
  }
  const fullSettings = {
    backend: 'llamaCPP',
    model: 'Qwen3-9B',
    embeddingModel: 'bge-small',
    contextSize: 65536,
    contextSizeEdited: true,
    thinkingEnabled: false,
    toolDelegationEnabled: false,
    builtinToolEnablement: { captureScreenshot: true },
    builtinToolPresetEnablement: { Flux: false },
    builtinToolDefaultPresets: { 'comfyUI:image': 'Z-Image' },
    cloudProviderId: 'zai',
  }

  it('reads every model setting, keeping the context size the user asked for', () => {
    expect(sessionSettingsFromBag(fullBag, 'llamaCPP')).toEqual(fullSettings)
  })

  it('reads the embedding model of the embedding backend, which a cloud session keeps local', () => {
    const settings = sessionSettingsFromBag({ ...fullBag, backend: 'cloud' }, 'openVINO')
    expect(settings.embeddingModel).toBe('bge-ov')
  })

  it('lays every model setting over the defaults so the chat store can load it', () => {
    const bag = sessionSettingsToBag(
      fullSettings as never,
      { selectedEmbeddingModels: { openVINO: 'bge-ov' }, temperature: 0.2 },
      'llamaCPP',
    )
    expect(bag).toMatchObject({
      backend: 'llamaCPP',
      selectedEmbeddingModels: { llamaCPP: 'bge-small', openVINO: 'bge-ov' },
      contextSize: 65536,
      requestedContextSize: 65536,
      contextSizeEdited: true,
      thinkingEnabled: false,
      toolDelegationEnabled: false,
      builtinToolEnablement: { captureScreenshot: true },
      cloudProviderId: 'zai',
      temperature: 0.2,
    })
  })

  it('ignores a device in the bag, since the device is a Machine Setting', () => {
    expect(
      sessionSettingsFromBag({ backend: 'llamaCPP', selectedDeviceId: 'GPU.1' }, 'llamaCPP'),
    ).toEqual({ backend: 'llamaCPP' })
  })

  it('ignores the device an older Session stored, so loading it never picks a device', () => {
    const bag = sessionSettingsToBag(
      { backend: 'llamaCPP', device: { id: 'NPU', uuid: 'u-npu' } },
      { selectedDeviceId: 'GPU.0' },
    )
    expect(bag).toEqual({ backend: 'llamaCPP', selectedDeviceId: 'GPU.0' })
  })

  it('keeps the device an older Session stored when the bag changes', () => {
    const next = updateSessionSettingsFromBag(
      { backend: 'llamaCPP', device: { id: 'NPU', uuid: 'u-npu' } },
      { backend: 'openVINO', selectedDeviceId: 'GPU.0' },
    )
    expect(next).toEqual({ backend: 'openVINO', device: { id: 'NPU', uuid: 'u-npu' } })
  })

  it('round-trips: what is laid into the bag reads back unchanged', () => {
    const bag = sessionSettingsToBag(fullSettings as never, {}, 'llamaCPP')
    expect(sessionSettingsFromBag(bag, 'llamaCPP')).toEqual(fullSettings)
  })
})

describe('fillMissingSessionSettings', () => {
  it('fills only the fields the session lacks', () => {
    const result = fillMissingSessionSettings(
      { backend: 'llamaCPP', model: 'Own-4B' },
      { backend: 'openVINO', model: 'Phi-4', thinkingEnabled: false },
    )
    expect(result).toEqual({
      changed: true,
      settings: { backend: 'llamaCPP', model: 'Own-4B', thinkingEnabled: false },
    })
  })

  it('reports no change for a session that already has every default field', () => {
    const current = { backend: 'llamaCPP' as const, thinkingEnabled: true }
    expect(fillMissingSessionSettings(current, { thinkingEnabled: false })).toEqual({
      changed: false,
      settings: current,
    })
  })
})

describe('keepUneditedSettings', () => {
  it('keeps the stored value of a field that still equals the post-load baseline', () => {
    const stored = { backend: 'llamaCPP' as const, model: 'Gone-7B', thinkingEnabled: true }
    const baseline = { backend: 'llamaCPP' as const, model: 'Substitute-9B', thinkingEnabled: true }
    const next = { backend: 'llamaCPP' as const, model: 'Substitute-9B', thinkingEnabled: false }
    expect(keepUneditedSettings(stored, next, baseline).settings).toEqual({
      backend: 'llamaCPP',
      model: 'Gone-7B',
      thinkingEnabled: false,
    })
  })

  it('takes a field the user changed', () => {
    const stored = { model: 'Gone-7B' }
    expect(
      keepUneditedSettings(stored, { model: 'Picked-4B' }, { model: 'Substitute-9B' }).settings,
    ).toEqual({ model: 'Picked-4B' })
  })

  it('takes a field changed back to the value the session loaded with', () => {
    const baseline = { model: 'Loaded-9B' }
    const first = keepUneditedSettings({ model: 'Loaded-9B' }, { model: 'Missing-27B' }, baseline)
    expect(first.settings).toEqual({ model: 'Missing-27B' })
    const back = keepUneditedSettings(
      first.settings,
      { model: 'Loaded-9B' },
      baseline,
      first.edited,
    )
    expect(back.settings).toEqual({ model: 'Loaded-9B' })
  })

  it('takes the substitute once the user picked another model and then the substitute', () => {
    const baseline = { model: 'Substitute-9B' }
    const first = keepUneditedSettings({ model: 'Gone-7B' }, { model: 'Picked-4B' }, baseline)
    const back = keepUneditedSettings(
      first.settings,
      { model: 'Substitute-9B' },
      baseline,
      first.edited,
    )
    expect(back.settings).toEqual({ model: 'Substitute-9B' })
  })
})
