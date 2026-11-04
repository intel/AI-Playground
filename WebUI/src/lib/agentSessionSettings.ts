import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import { llmBackendTypes } from '@/types/shared'

/** A chat preset's saved-settings bag, as `textInference.settingsPerPreset` stores it. */
export type SettingsBag = Record<string, unknown>

/** The one gate for per-session settings: the folder-picking Agent preset and those saved from it. */
export function usesSessionSettings(
  preset: { name: string; agentPreset?: boolean; agentTaskId?: string } | null | undefined,
): boolean {
  return (
    preset?.agentPreset === true &&
    (presetNameUsesSessionSettings(preset.name) || preset.agentTaskId !== undefined)
  )
}

/** The same gate by name, for session records read before the preset catalog has loaded. */
export function presetNameUsesSessionSettings(name: string | undefined): boolean {
  return name === 'Agent'
}

/**
 * Bag keys holding the capability and planning parts of the Default Settings. Not
 * `planningThinkingOnly`: that key is a legacy chat-bag field the agent store strips.
 */
export const DEFAULT_CAPABILITIES_KEY = 'agentCapabilities'
export const DEFAULT_PLANNING_THINKING_ONLY_KEY = 'agentPlanningThinkingOnly'

/** Bag keys whose values belong to the session rather than to the Default Settings. */
const SESSION_OWNED_KEYS = [
  'backend',
  'selectedModels',
  'selectedEmbeddingModels',
  'contextSize',
  'requestedContextSize',
  'contextSizeEdited',
  'thinkingEnabled',
  'toolDelegationEnabled',
  'builtinToolEnablement',
  'builtinToolPresetEnablement',
  'builtinToolDefaultPresets',
  'cloudProviderId',
] as const

type Backend = (typeof llmBackendTypes)[number]
type LocalBackend = Exclude<Backend, 'cloud'>

function isBackend(value: unknown): value is Backend {
  return (llmBackendTypes as readonly unknown[]).includes(value)
}

/** Session Settings fields read from the bag; they are replaced, never merged, on an edit. */
const BAG_DERIVED_SETTINGS = [
  'backend',
  'model',
  'embeddingModel',
  'contextSize',
  'contextSizeEdited',
  'thinkingEnabled',
  'toolDelegationEnabled',
  'builtinToolEnablement',
  'builtinToolPresetEnablement',
  'builtinToolDefaultPresets',
  'cloudProviderId',
] as const

/** Take the bag's values for the fields it owns, keeping the session's other settings. */
export function updateSessionSettingsFromBag(
  current: AgentSessionSettings | null,
  bag: SettingsBag,
  embeddingBackend?: LocalBackend,
): AgentSessionSettings {
  const kept: AgentSessionSettings = { ...current }
  for (const key of BAG_DERIVED_SETTINGS) delete kept[key]
  return { ...kept, ...sessionSettingsFromBag(bag, embeddingBackend) }
}

const asRecord = <T>(value: unknown): Record<string, T> | undefined =>
  value && typeof value === 'object' ? { ...(value as Record<string, T>) } : undefined

/** `embeddingBackend` is the local backend document search runs on (a cloud session keeps one). */
export function sessionSettingsFromBag(
  bag: SettingsBag,
  embeddingBackend?: LocalBackend,
): AgentSessionSettings {
  const settings: AgentSessionSettings = {}
  if (isBackend(bag.backend)) {
    settings.backend = bag.backend
    const model = asRecord<string | null>(bag.selectedModels)?.[bag.backend]
    if (typeof model === 'string') settings.model = model
  }
  const embeddingSlot = embeddingBackend ?? (bag.backend === 'cloud' ? undefined : bag.backend)
  const embedding = embeddingSlot
    ? asRecord<string | null>(bag.selectedEmbeddingModels)?.[embeddingSlot as string]
    : undefined
  if (typeof embedding === 'string') settings.embeddingModel = embedding
  const contextSize = bag.requestedContextSize ?? bag.contextSize
  if (typeof contextSize === 'number') settings.contextSize = contextSize
  if (typeof bag.contextSizeEdited === 'boolean') settings.contextSizeEdited = bag.contextSizeEdited
  if (typeof bag.thinkingEnabled === 'boolean') settings.thinkingEnabled = bag.thinkingEnabled
  if (typeof bag.toolDelegationEnabled === 'boolean') {
    settings.toolDelegationEnabled = bag.toolDelegationEnabled
  }
  const toolEnablement = asRecord<boolean>(bag.builtinToolEnablement)
  if (toolEnablement) settings.builtinToolEnablement = toolEnablement
  const workflowEnablement = asRecord<boolean>(bag.builtinToolPresetEnablement)
  if (workflowEnablement) settings.builtinToolPresetEnablement = workflowEnablement
  const defaultWorkflows = asRecord<string>(bag.builtinToolDefaultPresets)
  if (defaultWorkflows) settings.builtinToolDefaultPresets = defaultWorkflows
  if (typeof bag.cloudProviderId === 'string') settings.cloudProviderId = bag.cloudProviderId
  return settings
}

/** Lay a session's settings over a base bag (the Default Settings) for the chat store to load. */
export function sessionSettingsToBag(
  settings: AgentSessionSettings,
  base: SettingsBag,
  embeddingBackend?: LocalBackend,
): SettingsBag {
  const bag: SettingsBag = { ...base }
  if (settings.backend) {
    bag.backend = settings.backend
    if (settings.model !== undefined) {
      bag.selectedModels = { ...asRecord(base.selectedModels), [settings.backend]: settings.model }
    }
  }
  const embeddingSlot =
    settings.backend && settings.backend !== 'cloud' ? settings.backend : embeddingBackend
  if (settings.embeddingModel !== undefined && embeddingSlot) {
    bag.selectedEmbeddingModels = {
      ...asRecord(base.selectedEmbeddingModels),
      [embeddingSlot]: settings.embeddingModel,
    }
  }
  if (settings.contextSize !== undefined) {
    bag.contextSize = settings.contextSize
    bag.requestedContextSize = settings.contextSize
  }
  for (const key of [
    'contextSizeEdited',
    'thinkingEnabled',
    'toolDelegationEnabled',
    'builtinToolEnablement',
    'builtinToolPresetEnablement',
    'builtinToolDefaultPresets',
    'cloudProviderId',
  ] as const) {
    if (settings[key] !== undefined) bag[key] = settings[key]
  }
  return bag
}

export function withoutSessionOwnedKeys(bag: SettingsBag): SettingsBag {
  const rest = { ...bag }
  for (const key of SESSION_OWNED_KEYS) delete rest[key]
  return rest
}

/** Fill each field the session lacks (an older file) from the Default Settings, field by field. */
export function fillMissingSessionSettings(
  current: AgentSessionSettings,
  defaults: AgentSessionSettings,
): { settings: AgentSessionSettings; changed: boolean } {
  const missing = (Object.keys(defaults) as (keyof AgentSessionSettings)[]).filter(
    (key) => current[key] === undefined && defaults[key] !== undefined,
  )
  if (missing.length === 0) return { settings: current, changed: false }
  const settings: AgentSessionSettings = { ...current }
  for (const key of missing) Object.assign(settings, { [key]: defaults[key] })
  return { settings, changed: true }
}

export type BagDerivedSetting = (typeof BAG_DERIVED_SETTINGS)[number]

/**
 * Keep the stored value of every field the user did not change since the session loaded:
 * a value substituted while loading (an unavailable model, a removed provider) equals the
 * post-load baseline and must not replace what the session chose. A field once changed
 * stays edited, so changing it back to the baseline value is taken too.
 */
export function keepUneditedSettings(
  stored: AgentSessionSettings,
  next: AgentSessionSettings,
  baseline: AgentSessionSettings,
  editedBefore: ReadonlySet<BagDerivedSetting> = new Set(),
): { settings: AgentSessionSettings; edited: Set<BagDerivedSetting> } {
  const settings: AgentSessionSettings = { ...next }
  const edited = new Set(editedBefore)
  for (const key of BAG_DERIVED_SETTINGS) {
    if (JSON.stringify(next[key]) !== JSON.stringify(baseline[key])) edited.add(key)
    if (edited.has(key)) continue
    if (stored[key] === undefined) delete settings[key]
    else Object.assign(settings, { [key]: stored[key] })
  }
  return { settings, edited }
}
