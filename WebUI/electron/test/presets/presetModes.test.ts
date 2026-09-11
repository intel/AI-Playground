import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MODE_TO_CATEGORIES,
  MODE_TO_PRESET_TYPE,
  agentEmptyStateKind,
  buttonModeFor,
  presetToMode,
} from '@/lib/presetModes'
import { PresetSchema, type ChatPreset, type Preset } from '@/assets/js/store/presets'
import { ModelSchema } from '@/types/shared'
import z from 'zod'

// The preset is what chooses the view: an agent-backed chat preset renders Agent
// Mode, everything else in the chat category renders Chat. These tests pin that
// mapping and check the presets shipped on disk against it, since a preset with
// `agentPreset` but no workspace policy (or an agent preset filed under a comfy
// category) would land the user in a mode the app cannot serve.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const presetsDir = path.resolve(__dirname, '../../../../modes/base/presets')

function shippedPresets(): { file: string; preset: Preset }[] {
  return readdirSync(presetsDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({
      file,
      preset: PresetSchema.parse(JSON.parse(readFileSync(path.join(presetsDir, file), 'utf-8'))),
    }))
}

function chatPreset(fields: Partial<ChatPreset> = {}): Preset {
  return {
    type: 'chat',
    category: 'chat',
    name: 'stub',
    ...fields,
  } as unknown as Preset
}

describe('presetToMode', () => {
  it('sends a plain chat preset to chat mode', () => {
    expect(presetToMode(chatPreset())).toBe('chat')
    expect(presetToMode(chatPreset({ ttsPreset: true }))).toBe('chat')
  })

  it('sends an agent-backed chat preset to agent mode', () => {
    expect(presetToMode(chatPreset({ agentPreset: true }))).toBe('agent')
  })

  it('maps comfy presets by category', () => {
    const comfy = (category: string) =>
      ({ type: 'comfy', category, name: 'stub' }) as unknown as Preset
    expect(presetToMode(comfy('create-images'))).toBe('imageGen')
    expect(presetToMode(comfy('edit-images'))).toBe('imageEdit')
    expect(presetToMode(comfy('create-videos'))).toBe('video')
    expect(presetToMode(comfy('something-new'))).toBe('imageGen')
  })
})

describe('mode routing tables', () => {
  it('lists agent presets with the chat ones, so there is a single list', () => {
    expect(MODE_TO_CATEGORIES.agent).toEqual(MODE_TO_CATEGORIES.chat)
    expect(MODE_TO_PRESET_TYPE.agent).toBe('chat')
  })

  it('reaches agent mode through the chat button', () => {
    expect(buttonModeFor('agent')).toBe('chat')
    expect(buttonModeFor('imageGen')).toBe('imageGen')
  })

  it('picks empty-state copy from the preset, not the workspace kind', () => {
    expect(agentEmptyStateKind('Agent')).toBe('folder')
    expect(agentEmptyStateKind('Game Agent')).toBe('game-agent')
    expect(agentEmptyStateKind('Quick Coder')).toBe('quick-coder')
    expect(agentEmptyStateKind('Game Maker Quick')).toBe('quick-coder')
    expect(agentEmptyStateKind(undefined)).toBe('folder')
  })

  it('covers every mode a preset can resolve to', () => {
    for (const { preset } of shippedPresets()) {
      const mode = presetToMode(preset)
      expect(MODE_TO_CATEGORIES[mode], `no categories for mode '${mode}'`).toBeDefined()
      expect(MODE_TO_PRESET_TYPE[mode]).toBe(preset.type)
    }
  })
})

describe('shipped agent presets', () => {
  const agentPresets = shippedPresets().filter(
    (entry) => entry.preset.type === 'chat' && (entry.preset as ChatPreset).agentPreset,
  )

  it('ships the Agent and Game Agent presets', () => {
    expect(agentPresets.map((entry) => entry.preset.name).sort()).toEqual([
      'Agent',
      'Game Agent',
      'Quick Coder',
    ])
  })

  it('declares a workspace policy and tool calling', () => {
    for (const { file, preset } of agentPresets) {
      const chat = preset as ChatPreset
      expect(chat.agentWorkspace, `${file}: no agentWorkspace`).toMatch(/^(pick|games)$/)
      expect(chat.requiresToolCalling, `${file}: agent without tools`).toBe(true)
      expect(presetToMode(preset)).toBe('agent')
    }
  })

  it('gives Game Agent a managed folder, coding models and the game capabilities', () => {
    const gameAgent = agentPresets.find((entry) => entry.preset.name === 'Game Agent')
      ?.preset as ChatPreset
    expect(gameAgent.agentWorkspace).toBe('games')
    expect(gameAgent.requiresCoding).toBe(true)
    expect(gameAgent.agentCapabilities).toEqual(
      expect.arrayContaining(['media', 'web-debug', 'game-studio']),
    )
    // The instructions orient the session; the procedure lives in the
    // html-game-studio skill, so this prompt must point at it rather than
    // duplicate the whole workflow.
    const prompt = gameAgent.systemPrompt ?? ''
    expect(prompt).toMatch(/html-game-studio/)
    expect(prompt).toMatch(/design\.md/)
    expect(prompt.length).toBeGreaterThan(0)
    expect(prompt.length).toBeLessThan(1200)
  })

  // The quick preset is the same library, a much thinner session: one capability
  // that owns the whole prompt, no media and no browser to pull in.
  it('gives Quick Coder the games folder and nothing but its own capability', () => {
    const quick = agentPresets.find((entry) => entry.preset.name === 'Quick Coder')
      ?.preset as ChatPreset
    expect(quick.agentWorkspace).toBe('games')
    expect(quick.requiresCoding).toBe(true)
    expect(quick.agentCapabilities).toEqual(['game-studio-quick'])
    // Its prompt replaces Pi's own, so an empty one would leave the model with
    // no instructions at all rather than with generic ones.
    expect(quick.systemPrompt?.length ?? 0).toBeGreaterThan(0)
  })

  it('prefers models the coding filter would keep', () => {
    // Parsed through the schema the main process uses, not the raw JSON: Zod drops
    // unknown keys, so a flag missing from `ModelSchema` reaches the picker as
    // `undefined` and `requiresCoding` then hides every model.
    const models = z
      .array(ModelSchema)
      .parse(
        JSON.parse(readFileSync(path.resolve(__dirname, '../../../external/models.json'), 'utf-8')),
      )
    const coding = new Set(models.filter((m) => m.supportsCoding).map((m) => m.name))
    for (const { preset } of agentPresets) {
      const chat = preset as ChatPreset
      if (!chat.requiresCoding) continue
      for (const preferred of Object.values(chat.preferredModels ?? {})) {
        expect(
          coding,
          `${chat.name}: preferred model '${preferred}' is filtered out by requiresCoding`,
        ).toContain(preferred)
      }
    }
  })
})
