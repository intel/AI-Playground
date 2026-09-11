import { AUDIO_CATEGORY, type ChatPreset, type Preset } from '@/assets/js/store/presets'
import { currentPresetName } from '@/lib/presetRenames'

// ── Which view a preset belongs to ───────────────────────────────────────────
//
// The preset is what selects the mode, so this mapping is consulted by the preset
// switching orchestrator, the prompt store and the quick picker alike — hence a
// module of its own (types only, no store imports, so it stays testable).

/**
 * The UI mode a preset runs in.
 *
 * Chat presets normally mean chat mode, but an `agentPreset` runs on the agent
 * harness instead: it is listed with the chat presets (one list for the user)
 * while rendering Agent Mode. The speech presets (Text to Speech / Speech to
 * Text) are chat-type too but live in their own Audio mode. This is the only
 * place those distinctions are made — everything downstream keys off the mode.
 */
export function presetToMode(preset: Preset): ModeType {
  if (preset.type === 'chat') {
    if ((preset as ChatPreset).agentPreset) return 'agent'
    return preset.category === AUDIO_CATEGORY ? 'audio' : 'chat'
  }

  // ComfyUI presets - map by category
  switch (preset.category) {
    case 'create-images':
      return 'imageGen'
    case 'edit-images':
      return 'imageEdit'
    case 'create-videos':
      return 'video'
    default:
      // Default to imageGen for unknown categories
      return 'imageGen'
  }
}

/**
 * Preset categories a mode lists. Chat and agent share one category: the preset
 * the user picks from that list decides which of the two renders.
 */
export const MODE_TO_CATEGORIES: Record<ModeType, string[]> = {
  chat: ['chat'],
  agent: ['chat'],
  audio: [AUDIO_CATEGORY],
  imageGen: ['create-images'],
  imageEdit: ['edit-images'],
  video: ['create-videos'],
}

export const MODE_TO_PRESET_TYPE: Record<ModeType, 'chat' | 'comfy'> = {
  chat: 'chat',
  agent: 'chat',
  audio: 'chat',
  imageGen: 'comfy',
  imageEdit: 'comfy',
  video: 'comfy',
}

/**
 * The mode button a mode is reached through. Agent Mode has no button of its own
 * — it is entered by picking an agent preset from the chat button's list.
 */
export function buttonModeFor(mode: ModeType): ModeType {
  return mode === 'agent' ? 'chat' : mode
}

/**
 * Empty-state copy for Agent Mode. Workspace kind only says whether the app
 * minted a game folder; Quick Coder and Game Agent share that kind but not the
 * workflow the hint should describe.
 */
export type AgentEmptyStateKind = 'folder' | 'game-agent' | 'quick-coder'

export function agentEmptyStateKind(presetName: string | undefined): AgentEmptyStateKind {
  const name = currentPresetName(presetName ?? '')
  if (name === 'Quick Coder') return 'quick-coder'
  if (name === 'Game Agent') return 'game-agent'
  return 'folder'
}
