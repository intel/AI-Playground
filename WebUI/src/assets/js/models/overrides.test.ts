import { describe, expect, it } from 'vitest'
import { hasCapabilityOverrides, mergeCapabilities, pickDefined } from './overrides'

describe('pickDefined', () => {
  it('drops undefined values so a layer can only set, never blank', () => {
    expect(pickDefined({ a: 1, b: undefined, c: false })).toEqual({ a: 1, c: false })
  })

  it('handles a missing source', () => {
    expect(pickDefined(undefined)).toEqual({})
  })
})

describe('mergeCapabilities', () => {
  it('lets a later layer win', () => {
    const merged = mergeCapabilities({ supportsVision: false }, { supportsVision: true })
    expect(merged.supportsVision).toBe(true)
  })

  it('lets a user override beat the models.json value', () => {
    // The bug this exists to prevent: models.json used to win unconditionally, so
    // editing a predefined model's capabilities was discarded on the next refresh.
    const customMetadata = { supportsToolCalling: false }
    const predefined = { supportsToolCalling: false, maxContextSize: 4096 }
    const userOverride = { supportsToolCalling: true }

    const merged = mergeCapabilities(customMetadata, predefined, userOverride)

    expect(merged.supportsToolCalling).toBe(true)
    expect(merged.maxContextSize).toBe(4096)
  })

  it('lets a user declare coding fitness the catalog withheld', () => {
    // Coding is what a coding preset's picker filters on, so a user-added model
    // is unusable there until this override sticks.
    const merged = mergeCapabilities({ supportsCoding: undefined }, { supportsCoding: true })
    expect(merged.supportsCoding).toBe(true)
  })

  it('never blanks a lower layer with an undefined from a higher one', () => {
    const merged = mergeCapabilities({ maxContextSize: 8192 }, { maxContextSize: undefined })
    expect(merged.maxContextSize).toBe(8192)
  })

  it('keeps an explicit false, which is a real capability answer', () => {
    const merged = mergeCapabilities({ supportsVision: true }, { supportsVision: false })
    expect(merged.supportsVision).toBe(false)
  })

  it('takes only capability keys, so a full Model contributes no other fields', () => {
    const modelLikeLayer = {
      name: 'org/repo/model.gguf',
      downloaded: true,
      type: 'llamaCPP',
      favorite: true,
      supportsVision: true,
    } as unknown as Parameters<typeof mergeCapabilities>[0]

    const merged = mergeCapabilities(modelLikeLayer)

    expect(merged).toEqual({ supportsVision: true })
  })

  it('ignores absent layers', () => {
    expect(mergeCapabilities(undefined, { npuSupport: true }, undefined)).toEqual({
      npuSupport: true,
    })
  })
})

describe('hasCapabilityOverrides', () => {
  it('is false for no overrides and for an all-undefined object', () => {
    expect(hasCapabilityOverrides(undefined)).toBe(false)
    expect(hasCapabilityOverrides({})).toBe(false)
    expect(hasCapabilityOverrides({ supportsVision: undefined })).toBe(false)
  })

  it('is true once any capability is set', () => {
    expect(hasCapabilityOverrides({ supportsVision: false })).toBe(true)
    expect(hasCapabilityOverrides({ maxContextSize: 1024 })).toBe(true)
  })
})
