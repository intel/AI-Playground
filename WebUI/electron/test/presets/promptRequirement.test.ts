import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PresetSchema,
  presetRequiresUserPrompt,
  type ComfyUiPreset,
} from '@/assets/js/store/presets'

// Pin test for the "does this preset require a user prompt?" contract.
//
// Source of truth: the structured prompt setting on the preset
// (`settings[].settingName === 'prompt'` with `modifiable: true`).
//
// The `"no-prompt"` tag is intentionally NOT consulted - it is human-readable
// documentation only. This test asserts that the runtime helper agrees with
// the structured signal on every preset shipped under modes/base/presets/,
// catching both regressions in the helper and contributors who forget that
// emptying/disabling the prompt setting makes the workflow no-prompt.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const presetsDir = path.resolve(__dirname, '../../../../modes/base/presets')

function loadAllPresets() {
  const files = readdirSync(presetsDir).filter((f) => f.endsWith('.json'))
  return files.map((file) => {
    const raw = readFileSync(path.join(presetsDir, file), 'utf-8')
    const parsed = JSON.parse(raw)
    const validated = PresetSchema.parse(parsed)
    return { file, preset: validated }
  })
}

function expectedRequiresPrompt(preset: ComfyUiPreset): boolean {
  return preset.settings.some(
    (s) => 'settingName' in s && s.settingName === 'prompt' && s.modifiable === true,
  )
}

describe('presetRequiresUserPrompt', () => {
  it('returns false when the preset has no prompt setting', () => {
    const stub = {
      type: 'comfy',
      name: 'stub',
      backend: 'comfyui',
      settings: [],
      comfyUiApiWorkflow: {},
    } as unknown as ComfyUiPreset
    expect(presetRequiresUserPrompt(stub)).toBe(false)
  })

  it('returns false when the prompt setting is not modifiable', () => {
    const stub = {
      type: 'comfy',
      name: 'stub',
      backend: 'comfyui',
      settings: [
        {
          type: 'string',
          label: 'Prompt',
          displayed: false,
          modifiable: false,
          defaultValue: '',
          settingName: 'prompt',
        },
      ],
      comfyUiApiWorkflow: {},
    } as unknown as ComfyUiPreset
    expect(presetRequiresUserPrompt(stub)).toBe(false)
  })

  it('returns true when the prompt setting is modifiable', () => {
    const stub = {
      type: 'comfy',
      name: 'stub',
      backend: 'comfyui',
      settings: [
        {
          type: 'string',
          label: 'Prompt',
          displayed: true,
          modifiable: true,
          defaultValue: '',
          settingName: 'prompt',
        },
      ],
      comfyUiApiWorkflow: {},
    } as unknown as ComfyUiPreset
    expect(presetRequiresUserPrompt(stub)).toBe(true)
  })

  it('agrees with the structured signal on every shipped preset', () => {
    const presets = loadAllPresets()
    expect(presets.length, 'no presets discovered on disk').toBeGreaterThan(0)

    const mismatches: string[] = []
    for (const { file, preset } of presets) {
      if (preset.type !== 'comfy') continue
      const actual = presetRequiresUserPrompt(preset)
      const expected = expectedRequiresPrompt(preset)
      if (actual !== expected) {
        mismatches.push(`${file}: helper=${actual}, structured signal=${expected}`)
      }
    }

    expect(mismatches, mismatches.join('\n')).toEqual([])
  })

  it('covers at least one no-prompt and one prompt-driven preset', () => {
    // Sanity guard: if both buckets aren't represented, the contract test above
    // could silently pass on an unbalanced fixture set.
    const comfyPresets = loadAllPresets()
      .map(({ preset }) => preset)
      .filter((p): p is ComfyUiPreset => p.type === 'comfy')
    expect(comfyPresets.some((p) => presetRequiresUserPrompt(p))).toBe(true)
    expect(comfyPresets.some((p) => !presetRequiresUserPrompt(p))).toBe(true)
  })
})
