import { z } from 'zod'

/**
 * Session Settings (ADR-0004), as `session.json` keeps them under `settings`: one
 * entry per preset name, holding one bag per settings key (the preset name, or
 * `preset:variant`) in the shape the owning store keeps its Default Settings.
 */
export const SessionSettingsBagSchema = z.object({
  values: z.record(z.string(), z.unknown()),
  /** True until the user changes a setting in this Session; such a bag is repaired silently. */
  fromDefaults: z.boolean(),
})
export type SessionSettingsBag = z.infer<typeof SessionSettingsBagSchema>

export const PresetSessionSettingsSchema = z.object({
  /** The variant this Session last used the preset with; absent until it has used one. */
  variant: z.string().optional(),
  bags: z.record(z.string(), SessionSettingsBagSchema).default({}),
})
export type PresetSessionSettings = z.infer<typeof PresetSessionSettingsSchema>

export type SessionSettingsMap = Record<string, PresetSessionSettings>

/** Each readable entry of a `session.json` `settings` record; an unreadable one is dropped. */
export function parseSessionSettings(raw: Record<string, unknown>): SessionSettingsMap {
  const settings: SessionSettingsMap = {}
  for (const [presetName, entry] of Object.entries(raw)) {
    const parsed = PresetSessionSettingsSchema.safeParse(entry)
    if (parsed.success) settings[presetName] = parsed.data
  }
  return settings
}
