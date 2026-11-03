import { mutateSession, readSession } from './sessions'
import {
  parseSessionSettings,
  PresetSessionSettingsSchema,
  type PresetSessionSettings,
  type SessionSettingsBag,
  type SessionSettingsMap,
} from '@/types/sessionSettings'

/**
 * Session Settings (ADR-0004). The Default Settings stay in the renderer's
 * preference stores, so they are passed in; "Save as default" writes those stores
 * and needs nothing here, and "Reset to default" drops the bag so the next read
 * copies the defaults again.
 */

export async function readSessionSettings(id: string): Promise<SessionSettingsMap> {
  return parseSessionSettings((await readSession(id)).settings)
}

export async function writePresetSettings(
  id: string,
  presetName: string,
  entry: PresetSessionSettings,
): Promise<void> {
  const parsed = PresetSessionSettingsSchema.parse(entry)
  await mutateSession(id, (file) => ({
    ...file,
    settings: { ...file.settings, [presetName]: parsed },
  }))
}

/** A preset's bag in this Session; the first read copies the Default Settings in. */
export async function presetSettingsFor(
  id: string,
  presetName: string,
  settingsKey: string,
  defaults: Record<string, unknown>,
): Promise<SessionSettingsBag> {
  let bag: SessionSettingsBag | undefined
  await mutateSession(id, (file) => {
    const entry = parseSessionSettings(file.settings)[presetName] ?? { bags: {} }
    bag = entry.bags[settingsKey]
    if (bag) return file
    bag = { values: structuredClone(defaults), fromDefaults: true }
    const next = { ...entry, bags: { ...entry.bags, [settingsKey]: bag } }
    return { ...file, settings: { ...file.settings, [presetName]: next } }
  })
  return bag!
}
