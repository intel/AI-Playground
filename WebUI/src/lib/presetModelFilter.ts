import type { CapabilityFlags } from '@/assets/js/capabilities'

/** Flags a preset can demand of a model before it appears in the picker. */
export type PresetModelGate = CapabilityFlags & {
  supportsCoding?: boolean
  npuSupport?: boolean
}

export type PresetModelRequirements = {
  vision: boolean
  toolCalling: boolean
  reasoning: boolean
  coding: boolean
  agentic: boolean
  npuSupport: boolean
}

/** Preset gates are AND. An unset flag does not satisfy a requirement. */
export function modelMeetsPresetRequirements(
  model: PresetModelGate,
  requirements: PresetModelRequirements,
): boolean {
  if (requirements.vision && model.supportsVision !== true) return false
  if (requirements.toolCalling && model.supportsToolCalling !== true) return false
  if (requirements.reasoning && model.supportsReasoning !== true) return false
  if (requirements.coding && model.supportsCoding !== true) return false
  if (requirements.agentic && model.supportsAgentic !== true) return false
  if (requirements.npuSupport && model.npuSupport !== true) return false
  return true
}
