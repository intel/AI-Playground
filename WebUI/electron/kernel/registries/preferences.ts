import type { PreferencesInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import { ipcFail } from '../typedIpc'
import type {
  migratePreferenceSection,
  readAllPreferences,
  writePreferenceSection,
} from '../../persist/preferencesFile'

/** The kernel-owned preferences-file seams the three preferences handlers close over. */
export type PreferencesDeps = {
  readAllPreferences: typeof readAllPreferences
  migratePreferenceSection: typeof migratePreferenceSection
  writePreferenceSection: typeof writePreferenceSection
}

export function buildPreferencesRegistry(deps: PreferencesDeps) {
  // User preferences (step 8, §6.1): one file, one section per store. The
  // one-shot migrate writes only when the section is absent, so a retry can
  // never overwrite what the files already own.
  return {
    'preferences:read': async () => {
      try {
        return { success: true as const, sections: await deps.readAllPreferences() }
      } catch (e) {
        return ipcFail(e)
      }
    },

    'preferences:migrate': async (_event, section, payload) => {
      try {
        if (typeof section !== 'string') throw new Error('preference section must be a string')
        await deps.migratePreferenceSection(section, payload)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },

    'preferences:write': async (_event, section, value) => {
      try {
        if (typeof section !== 'string') throw new Error('preference section must be a string')
        await deps.writePreferenceSection(section, value)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
  } satisfies InvokeHandlerMap<PreferencesInvokeName>
}
