import { acceptHMRUpdate, defineStore } from 'pinia'
import { demoAwareStorage } from '../demoAwareStorage'
import { hasCapabilityOverrides, pickDefined } from '../models/overrides'
import { modelEntryId } from '../models/library'
import type { ModelCapabilityValues } from '../models/types'

/**
 * Per-model user preferences: the layer the app was missing entirely. Kept
 * deliberately free of store dependencies (like `errors` and `activities`) so any
 * store can read it without a cycle.
 *
 * This is *not* the same thing as `customModelMetadata` in `store/models.ts`,
 * which records that a user-added model exists and what it was added as.
 * Preferences are the top-precedence override applied on top of any source, so
 * "reset to defaults" is just deleting the entry, and removing this store
 * altogether returns the app to its previous behaviour.
 */
export type ModelPreferences = {
  /** Sorted to the top of pickers and of the management view. */
  favorite?: boolean
  /** Only the keys present here override the catalog/disk value. */
  capabilities?: Partial<ModelCapabilityValues>
}

export const useModelPreferences = defineStore(
  'modelPreferences',
  () => {
    /** Keyed by `ModelEntry.id` (`${pathKey}:${normalizedName}`). */
    const preferences = ref<Record<string, ModelPreferences>>({})

    function get(id: string): ModelPreferences | undefined {
      return preferences.value[id]
    }

    function update(id: string, patch: ModelPreferences) {
      const next: ModelPreferences = { ...preferences.value[id], ...patch }
      if (next.favorite === false) delete next.favorite
      if (next.capabilities && !hasCapabilityOverrides(next.capabilities)) delete next.capabilities
      if (Object.keys(next).length === 0) {
        // Keep the persisted object free of empty entries so a full reset really
        // leaves no trace.
        const { [id]: _removed, ...rest } = preferences.value
        preferences.value = rest
        return
      }
      preferences.value = { ...preferences.value, [id]: next }
    }

    function setFavorite(id: string, favorite: boolean) {
      update(id, { favorite })
    }

    function setCapabilities(id: string, capabilities: Partial<ModelCapabilityValues>) {
      update(id, { capabilities: pickDefined(capabilities) })
    }

    function resetCapabilities(id: string) {
      update(id, { capabilities: undefined })
    }

    function reset(id: string) {
      const { [id]: _removed, ...rest } = preferences.value
      preferences.value = rest
    }

    /**
     * Capability overrides for a chat/embedding model, looked up by model name.
     * `store/models.ts` merges these into every model on refresh; it deals in
     * names rather than entry ids, so the id is derived from the path key here.
     */
    function capabilityOverridesFor(
      pathKey: string,
      name: string,
    ): Partial<ModelCapabilityValues> | undefined {
      return preferences.value[modelEntryId(pathKey, name)]?.capabilities
    }

    /**
     * Flags for a model, by path key + name, for the pickers. Takes a raw name in
     * any on-disk or catalog form (`owner---repo\file` vs `owner/repo/file`);
     * `modelEntryId` normalises both to the same key.
     */
    function flagsFor(pathKey: string, name: string): { favorite: boolean } {
      const entry = preferences.value[modelEntryId(pathKey, name)]
      return { favorite: entry?.favorite === true }
    }

    return {
      preferences,
      get,
      update,
      setFavorite,
      setCapabilities,
      resetCapabilities,
      reset,
      capabilityOverridesFor,
      flagsFor,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: ['preferences'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useModelPreferences, import.meta.hot))
}
