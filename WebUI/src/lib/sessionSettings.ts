import { sessionSettingsFromBag, type SettingsBag } from '@/lib/agentSessionSettings'
import {
  sessionSettingsProblems,
  type SessionSettingsAvailability,
  type SessionSettingsProblem,
} from '@/lib/sessionSettingsProblems'
import type { PresetSessionSettings, SessionSettingsBag } from '@/types/sessionSettings'

/** Pure rules of Session Settings (ADR-0004), shared by the renderer store and its tests. */

const EMPTY: PresetSessionSettings = { bags: {} }

export function withBag(
  entry: PresetSessionSettings | undefined,
  settingsKey: string,
  bag: SessionSettingsBag,
): PresetSessionSettings {
  const current = entry ?? EMPTY
  return { ...current, bags: { ...current.bags, [settingsKey]: bag } }
}

/** "Reset to default": the bag goes, so the next load copies the Default Settings again. */
export function withoutBag(
  entry: PresetSessionSettings | undefined,
  settingsKey: string,
): PresetSessionSettings {
  const { [settingsKey]: _dropped, ...bags } = (entry ?? EMPTY).bags
  return { ...(entry ?? EMPTY), bags }
}

export function withVariant(
  entry: PresetSessionSettings | undefined,
  variant: string,
): PresetSessionSettings {
  return { ...(entry ?? EMPTY), variant }
}

/** Sending with a bag makes it the Session's own: from then on it is checked, not repaired. */
export function asSent(bag: SessionSettingsBag): SessionSettingsBag {
  return bag.fromDefaults ? { ...bag, fromDefaults: false } : bag
}

/** ADR-0001's repair rule: only a Session's own settings block; defaults are repaired silently. */
export function blockingProblems(
  bag: SessionSettingsBag | undefined,
  problems: readonly SessionSettingsProblem[],
): SessionSettingsProblem[] {
  return bag && !bag.fromDefaults ? [...problems] : []
}

/**
 * Keep the stored value of every key the user did not change since the bag loaded: a
 * value substituted while loading (an unavailable model) equals the post-load
 * baseline and must not replace what the Session chose. A key once changed stays edited.
 */
export function keepUneditedValues(
  stored: SettingsBag,
  next: SettingsBag,
  baseline: SettingsBag,
  editedBefore: ReadonlySet<string> = new Set(),
): { values: SettingsBag; edited: Set<string> } {
  const values: SettingsBag = { ...next }
  const edited = new Set(editedBefore)
  for (const key of Object.keys(next)) {
    if (JSON.stringify(next[key]) !== JSON.stringify(baseline[key])) edited.add(key)
    if (edited.has(key)) continue
    if (key in stored) values[key] = stored[key]
    else delete values[key]
  }
  return { values, edited }
}

/** What in a chat preset's stored bag can no longer be served. */
export function chatBagProblems(
  values: SettingsBag,
  available: Omit<SessionSettingsAvailability, 'mcpServerIds'>,
): SessionSettingsProblem[] {
  return sessionSettingsProblems(sessionSettingsFromBag(values, available.embeddingBackend), {
    ...available,
    mcpServerIds: null,
  })
}

/** A variant the Session used that the preset no longer offers. */
export function variantProblems(
  entry: PresetSessionSettings | undefined,
  variants: readonly string[],
): SessionSettingsProblem[] {
  const variant = entry?.variant
  if (!variant || variants.length === 0 || variants.includes(variant)) return []
  return [{ field: 'variant', value: variant }]
}
