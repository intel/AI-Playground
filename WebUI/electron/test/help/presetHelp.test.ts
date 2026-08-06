import { describe, expect, it } from 'vitest'
import {
  extendedDescriptionText,
  findPresetByName,
  helpTopicFromPreset,
  helpTopicFromPresetVariant,
} from '@/assets/js/help/presetHelp'
import type { Preset } from '@/assets/js/store/presets'

function makePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    type: 'comfy',
    name: 'Line Art',
    backend: 'comfyui',
    displayPriority: 0,
    tags: [],
    settings: [],
    comfyUiApiWorkflow: {},
    ...overrides,
  } as unknown as Preset
}

describe('extendedDescriptionText', () => {
  it('returns the plain string form as-is', () => {
    expect(extendedDescriptionText(makePreset({ extendedDescription: 'How to use it' }))).toBe(
      'How to use it',
    )
  })

  it('picks the entry for the requested variant', () => {
    const preset = makePreset({ extendedDescription: { fast: 'Quick draft', quality: 'Slow' } })
    expect(extendedDescriptionText(preset, 'quality')).toBe('Slow')
  })

  it('falls back to the first entry when the variant has no text', () => {
    const preset = makePreset({ extendedDescription: { fast: 'Quick draft' } })
    expect(extendedDescriptionText(preset, 'unknown-variant')).toBe('Quick draft')
  })

  it('tolerates a missing preset or missing description', () => {
    expect(extendedDescriptionText(null)).toBeUndefined()
    expect(extendedDescriptionText(makePreset())).toBeUndefined()
  })
})

describe('helpTopicFromPreset', () => {
  it('combines description, extended description and tags', () => {
    const preset = makePreset({
      description: 'Turns photos into line art.',
      extendedDescription: 'Drop in a photo, then hit send.',
      tags: ['fast', 'stylize'],
    })
    const topic = helpTopicFromPreset(preset, 'Line Art')
    expect(topic.title).toBe('Line Art')
    expect(topic.body).toContain('Turns photos into line art.')
    expect(topic.body).toContain('Drop in a photo, then hit send.')
    expect(topic.body).toContain('Tags: fast, stylize')
  })

  it('does not repeat the description when the extended text is identical', () => {
    const preset = makePreset({ description: 'Same text', extendedDescription: 'Same text' })
    const occurrences = helpTopicFromPreset(preset, 'Line Art').body.split('Same text').length - 1
    expect(occurrences).toBe(1)
  })

  it('falls back to the DOM-provided name when the preset is not loaded', () => {
    expect(helpTopicFromPreset(null, 'Some Preset').title).toBe('Some Preset')
  })
})

describe('helpTopicFromPresetVariant', () => {
  // Regression: variant help used to be looked up by the *display* label, so any
  // variant with a `displayName` silently lost its title and extended description.
  it('resolves a variant by internal name even when it has a display label', () => {
    const preset = makePreset({
      name: 'Line Art',
      variants: [{ name: 'ov-fast', displayName: 'Fast', overrides: {} }],
      extendedDescription: { 'ov-fast': 'OpenVINO fast path' },
    } as Partial<Preset>)

    const topic = helpTopicFromPresetVariant(preset, 'Line Art', 'ov-fast')
    expect(topic.title).toBe('Line Art — ov-fast')
    expect(topic.body).toContain('OpenVINO fast path')
  })

  // Guards the binding contract in VariantSelector.vue: it must publish
  // `option.value` (internal name), never `option.name` (display label). A label
  // misses the extendedDescription map, and the fallback-to-first then quietly
  // describes a different variant, which is the bug this documents.
  it('describes the wrong variant when handed a display label', () => {
    const preset = makePreset({
      name: 'Line Art',
      variants: [
        { name: 'ov-quality', displayName: 'Quality', overrides: {} },
        { name: 'ov-fast', displayName: 'Fast', overrides: {} },
      ],
      extendedDescription: { 'ov-quality': 'Slow and detailed', 'ov-fast': 'Quick draft' },
    } as Partial<Preset>)

    expect(helpTopicFromPresetVariant(preset, 'Line Art', 'ov-fast').body).toContain('Quick draft')

    const byLabel = helpTopicFromPresetVariant(preset, 'Line Art', 'Fast')
    expect(byLabel.body).toContain('Slow and detailed')
    expect(byLabel.body).not.toContain('Quick draft')
  })

  it('falls back to the base description when the variant has no extended text', () => {
    const preset = makePreset({
      description: 'Base blurb',
      variants: [{ name: 'fast', overrides: {} }],
    } as Partial<Preset>)
    expect(helpTopicFromPresetVariant(preset, 'Line Art', 'fast').body).toContain('Base blurb')
  })

  it('degrades gracefully when the preset is not loaded', () => {
    const topic = helpTopicFromPresetVariant(null, 'Line Art', 'fast')
    expect(topic.title).toBe('fast')
    expect(topic.body).toContain('Line Art')
  })
})

describe('findPresetByName', () => {
  const chat = makePreset({ type: 'chat', name: 'Sketch' })
  const comfy = makePreset({ type: 'comfy', name: 'Sketch' })

  it('prefers the type matching the active mode when names collide', () => {
    expect(findPresetByName([chat, comfy], 'Sketch', 'comfy')).toBe(comfy)
    expect(findPresetByName([chat, comfy], 'Sketch', 'chat')).toBe(chat)
  })

  it('falls back to the only match when the preferred type is absent', () => {
    expect(findPresetByName([chat], 'Sketch', 'comfy')).toBe(chat)
  })

  it('returns null for an unknown name', () => {
    expect(findPresetByName([chat, comfy], 'Nope', 'chat')).toBeNull()
  })
})
