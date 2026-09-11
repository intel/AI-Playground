import { describe, it, expect } from 'vitest'
import {
  isToolEnabled,
  readLegacyToolEnablement,
  seedToolEnablementPerPreset,
  toolEnablementForPreset,
} from './builtinToolEnablement'

describe('isToolEnabled', () => {
  it('defaults every tool on except the opt-in ones', () => {
    expect(isToolEnabled({}, 'comfyUI')).toBe(true)
    expect(isToolEnabled({}, 'captureScreenshot')).toBe(false)
  })

  it('honours an override either way', () => {
    expect(isToolEnabled({ comfyUI: false }, 'comfyUI')).toBe(false)
    expect(isToolEnabled({ captureScreenshot: true }, 'captureScreenshot')).toBe(true)
  })
})

describe('toolEnablementForPreset', () => {
  // The cross-talk this replaces: an agent preset that never made a choice must
  // start from the defaults, not from the last chat preset's map.
  it("does not carry one preset's choice into a preset that has none", () => {
    const assistant = toolEnablementForPreset({ comfyUI: false }, null)
    const gameAgent = toolEnablementForPreset(undefined, null)

    expect(isToolEnabled(assistant, 'comfyUI')).toBe(false)
    expect(isToolEnabled(gameAgent, 'comfyUI')).toBe(true)
  })

  it('copies rather than shares the stored map', () => {
    const saved = { comfyUI: false }
    const live = toolEnablementForPreset(saved, null)
    live.comfyUI = true
    expect(saved.comfyUI).toBe(false)
  })

  it('falls back to the legacy global while one is still around', () => {
    expect(toolEnablementForPreset(undefined, { comfyUI: false })).toEqual({ comfyUI: false })
  })

  it("prefers the preset's own choice over the legacy global", () => {
    expect(toolEnablementForPreset({ comfyUI: true }, { comfyUI: false })).toEqual({
      comfyUI: true,
    })
  })

  it('ignores stored junk', () => {
    expect(toolEnablementForPreset('nonsense', null)).toEqual({})
    expect(toolEnablementForPreset({ comfyUI: 'yes' }, null)).toEqual({})
  })
})

describe('seedToolEnablementPerPreset', () => {
  it('gives every stored preset the legacy global it used to share', () => {
    const seeded = seedToolEnablementPerPreset(
      { Assistant: { temperature: 0.7 }, 'Game Agent': {} },
      { comfyUiImageEdit: false },
    )

    expect(seeded).toEqual({
      Assistant: { temperature: 0.7, builtinToolEnablement: { comfyUiImageEdit: false } },
      'Game Agent': { builtinToolEnablement: { comfyUiImageEdit: false } },
    })
  })

  it('seeds each preset its own copy', () => {
    const legacy = { comfyUI: false }
    const seeded = seedToolEnablementPerPreset({ Assistant: {}, 'Game Agent': {} }, legacy)

    expect(seeded.Assistant.builtinToolEnablement).not.toBe(legacy)
    expect(seeded.Assistant.builtinToolEnablement).not.toBe(
      seeded['Game Agent'].builtinToolEnablement,
    )
  })

  it('leaves a preset that already chose alone, so it can run twice', () => {
    const settings = { Assistant: { builtinToolEnablement: { comfyUI: true } } }
    expect(seedToolEnablementPerPreset(settings, { comfyUI: false })).toBe(settings)
  })
})

describe('readLegacyToolEnablement', () => {
  it('reads the global map an older build persisted at the root', () => {
    const raw = JSON.stringify({ backend: 'llamaCPP', builtinToolEnablement: { comfyUI: false } })
    expect(readLegacyToolEnablement(raw)).toEqual({ comfyUI: false })
  })

  it('has nothing to migrate for an install that never toggled a tool', () => {
    expect(readLegacyToolEnablement(null)).toBeNull()
    expect(readLegacyToolEnablement('{}')).toBeNull()
    expect(readLegacyToolEnablement(JSON.stringify({ builtinToolEnablement: {} }))).toBeNull()
  })

  it('survives an unreadable payload', () => {
    expect(readLegacyToolEnablement('{ not json')).toBeNull()
  })
})
