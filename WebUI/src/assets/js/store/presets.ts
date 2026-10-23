import { defineStore, acceptHMRUpdate } from 'pinia'
import { makeFileBackedPreference } from '@/lib/fileBackedPreferences'
import { ref, computed, shallowRef } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices } from './backendServices'
import { withDevPresets } from './devPresets'
import { useProductMode } from './productMode'
import { currentPresetName, renamePresetKeys } from '@/lib/presetRenames'
import {
  applyVariant,
  getFirstVariantName,
  validatePreset,
  AUDIO_CATEGORY,
  presetRequiresUserPrompt,
  PresetSchema,
  ResolutionConfigSchema,
  type ChatPreset,
  type Preset,
} from '@/lib/presetSchemas'

// Schemas, preset types and the pure variant-application live in
// `@/lib/presetSchemas` so the Electron main process (artifact runner) can
// validate catalog entries without touching Pinia. Re-exported here so the
// store remains the one import site for the rest of the renderer.
export { AUDIO_CATEGORY, PresetSchema, ResolutionConfigSchema, presetRequiresUserPrompt }
export type {
  ChatPreset,
  ComfyInput,
  ComfyUIApiWorkflow,
  ComfyUiPreset,
  MegapixelOption,
  Preset,
  RequiredModel,
  ResolutionConfig,
  Setting,
} from '@/lib/presetSchemas'

// ============================================================================
// Preset Store
// ============================================================================

export const usePresets = defineStore(
  'presets',
  () => {
    const presets = ref<Preset[]>([])
    const activePresetName = ref<string | null>(null)
    const activeVariantName = ref<Record<string, string>>({}) // preset name -> variant name
    const settingsPerPreset = ref<Record<string, Record<string, unknown>>>({})
    const lastUsedPresetName = ref<Record<string, string | null>>({}) // category -> preset name
    // Per-preset memory of the last variant the user picked under each backend, so that
    // toggling Backend in SettingsWorkflow restores the previous quality choice instead
    // of always snapping to the first variant. Shape: { [presetName]: { [backend]: variantName } }
    const lastQualityVariantPerBackend = ref<Record<string, Record<string, string>>>({})

    // Step 8 (§6.1): the variant picks and the last-used preset names are
    // kernel-owned preferences (preferences.json); `activePresetName` /
    // `activeVariantName` stay in the Pinia key — active is UI state, read
    // synchronously by `alignModeToActivePreset` before any async init — so
    // the one-shot upload only slims the file-half fields out of the key.
    const variantPrefs = makeFileBackedPreference({
      section: 'presets',
      refs: { settingsPerPreset, lastQualityVariantPerBackend, lastUsedPresetName },
      legacyKey: 'presets',
      legacySlim: true,
    })
    if (import.meta.hot) import.meta.hot.dispose(() => variantPrefs.dispose())

    async function init(): Promise<void> {
      await variantPrefs.init()
      // Selection and per-preset state are keyed by preset name, so a preset
      // that shipped under another one has to be followed to its current
      // name — the same fix the pinia afterHydrate applies to its own half.
      migrateRenamedPresets()
    }

    const DEFAULT_BACKEND = 'comfyui'

    // The STT preset is OpenVINO-only and thus hidden in NVIDIA mode — unless the
    // user enabled an external transcription endpoint (which needs no OpenVINO).
    // We read that flag from the speechToText store, but load it lazily (browser
    // only) so this module stays importable in the headless/node preset tests:
    // `speechToText` pulls the renderer store graph (setupWizard → homeAgent) that
    // touches `window` at import time. The ref keeps the flag reactive.
    type SttFallbackFlagStore = { fallback: { enabled: boolean; baseUrl: string } }
    const sttFallbackStore = shallowRef<SttFallbackFlagStore | null>(null)
    if (typeof window !== 'undefined') {
      void import('./speechToText')
        .then((m) => {
          try {
            sttFallbackStore.value = m.useSpeechToText() as unknown as SttFallbackFlagStore
          } catch {
            // Pinia not ready yet — ignore; the gate treats it as "no fallback".
          }
        })
        .catch(() => {})
    }
    /** Mirrors `speechToText.hasFallback()`: the checkbox alone is not enough, an
     *  endpoint with no URL cannot transcribe anything — so a blank base URL must
     *  not un-hide the STT preset in NVIDIA mode. */
    function sttExternalEnabled(): boolean {
      const fb = sttFallbackStore.value?.fallback
      return fb?.enabled === true && fb.baseUrl.trim().length > 0
    }

    /** Whether a chat preset's STT entry must be hidden: STT needs OpenVINO, which
     *  isn't installable in NVIDIA mode — so hide it there UNLESS an external
     *  transcription endpoint is usable or the standalone (torch) Whisper backend is
     *  offered (registered = feature on). Both need no OpenVINO; readiness/install is
     *  surfaced in the preset panel. */
    function sttPresetHidden(preset: ChatPreset): boolean {
      if (!preset.sttPreset) return false
      const backendServices = useBackendServices()
      const productMode = useProductMode()
      return (
        productMode.isNvidiaModeSelected &&
        !sttExternalEnabled() &&
        !backendServices.info.some((s) => s.serviceName === 'whisper-backend')
      )
    }

    // ========================================================================
    // Variant Application (validatePreset / applyVariant / getFirstVariantName
    // come from @/lib/presetSchemas)
    // ========================================================================

    function getPresetWithVariant(presetName: string): Preset | null {
      const preset = presets.value.find((p) => p.name === presetName)
      if (!preset) return null

      // If preset has variants, ensure one is selected
      if (preset.variants && preset.variants.length > 0) {
        let variantName: string | undefined = activeVariantName.value[presetName]

        // Auto-select first variant if none is selected
        if (!variantName) {
          const firstVariant = getFirstVariantName(preset)
          if (firstVariant) {
            variantName = firstVariant
            activeVariantName.value[presetName] = variantName
          }
        }

        if (variantName) {
          return applyVariant(preset, variantName)
        }
      }

      // No variants or no variant selected (shouldn't happen if variants exist)
      return preset
    }

    /**
     * Resolve a preset with an explicit variant applied, without touching UI
     * selection state. The artifact runner resolves workflows this way: a tool
     * or channel request names its workflow and variant and must not move
     * what the user is looking at. Falls back to the first variant when the
     * requested one does not exist, like getPresetWithVariant does for the UI.
     */
    function resolvePresetVariant(presetName: string, variantName?: string | null): Preset | null {
      const preset = presets.value.find((p) => p.name === presetName)
      if (!preset) return null
      if (!preset.variants || preset.variants.length === 0) return preset
      const resolved =
        (variantName && preset.variants.some((v) => v.name === variantName) && variantName) ||
        getFirstVariantName(preset)
      return resolved ? applyVariant(preset, resolved) : preset
    }

    function setActiveVariant(presetName: string, variantName: string | null): void {
      const preset = presets.value.find((p) => p.name === presetName)

      // If preset has variants and null is passed, select first variant instead
      if (variantName === null && preset && preset.variants && preset.variants.length > 0) {
        const firstVariant = getFirstVariantName(preset)
        if (firstVariant) {
          activeVariantName.value[presetName] = firstVariant
          rememberVariantPerBackend(preset, firstVariant)
          return
        }
      }

      if (variantName) {
        activeVariantName.value[presetName] = variantName
        if (preset) rememberVariantPerBackend(preset, variantName)
      } else {
        // Only delete if preset has no variants
        if (!preset || !preset.variants || preset.variants.length === 0) {
          delete activeVariantName.value[presetName]
        }
      }
    }

    function rememberVariantPerBackend(preset: Preset, variantName: string): void {
      const variant = preset.variants?.find((v) => v.name === variantName)
      if (!variant) return
      const backend = variant.backend ?? DEFAULT_BACKEND
      const map = lastQualityVariantPerBackend.value[preset.name] ?? {}
      map[backend] = variantName
      lastQualityVariantPerBackend.value[preset.name] = map
    }

    // ========================================================================
    // Backend selection helpers (used by SettingsWorkflow Backend dropdown)
    // ========================================================================

    /** Distinct backend ids present across the preset's variants, in stable order
     *  (default backend first, then others in declaration order). */
    function getDistinctBackendsForPreset(presetName: string): string[] {
      const preset = presets.value.find((p) => p.name === presetName)
      if (!preset?.variants?.length) return []
      const seen = new Set<string>()
      const ordered: string[] = []
      for (const v of preset.variants) {
        const b = v.backend ?? DEFAULT_BACKEND
        if (!seen.has(b)) {
          seen.add(b)
          ordered.push(b)
        }
      }
      // Make sure the default backend is first when present, so the radio defaults
      // to the native ComfyUI flow rather than whatever happens to be declared first.
      ordered.sort((a, b) => (a === DEFAULT_BACKEND ? -1 : b === DEFAULT_BACKEND ? 1 : 0))
      return ordered
    }

    /** All variants belonging to the given backend (raw, unfiltered by availability). */
    function getVariantsForBackend(
      presetName: string,
      backend: string,
    ): { name: string; requiresService?: string }[] {
      const preset = presets.value.find((p) => p.name === presetName)
      if (!preset?.variants?.length) return []
      return preset.variants.filter((v) => (v.backend ?? DEFAULT_BACKEND) === backend)
    }

    /** Returns the active backend for a preset, derived from the active variant. */
    function getActiveBackend(presetName: string): string | null {
      const preset = presets.value.find((p) => p.name === presetName)
      if (!preset?.variants?.length) return null
      const active = activeVariantName.value[presetName] ?? getFirstVariantName(preset)
      if (!active) return null
      const variant = preset.variants.find((v) => v.name === active)
      return variant?.backend ?? DEFAULT_BACKEND
    }

    /** Choose a sensible variant when the user switches backend:
     *   1) the variant they used last time on this backend (if it still exists)
     *   2) the first variant in that backend group whose requiresService is met
     *   3) the first variant in that backend group regardless of availability */
    function pickInitialVariantForBackend(presetName: string, backend: string): string | null {
      const variants = getVariantsForBackend(presetName, backend)
      if (variants.length === 0) return null

      const remembered = lastQualityVariantPerBackend.value[presetName]?.[backend]
      if (remembered && variants.some((v) => v.name === remembered)) {
        return remembered
      }

      const backendServices = useBackendServices()
      const isServiceUp = (serviceName?: string) => {
        if (!serviceName) return true
        const info = backendServices.info.find((s) => s.serviceName === serviceName)
        return !!info && info.status !== 'notInstalled'
      }
      const firstAvailable = variants.find((v) => isServiceUp(v.requiresService))
      return (firstAvailable ?? variants[0]).name
    }

    // ========================================================================
    // Preset Loading
    // ========================================================================

    async function loadPresetsFromFiles(): Promise<void> {
      try {
        const presetFiles = await window.electronAPI.reloadPresets()
        const validatedPresets: Preset[] = []

        for (const presetFile of presetFiles) {
          try {
            // Handle both old format (string) and new format (object with content and image)
            const fileContent = typeof presetFile === 'string' ? presetFile : presetFile.content
            const imageFromFile =
              typeof presetFile === 'object' && presetFile.image ? presetFile.image : null

            const parsed = JSON.parse(fileContent)
            const validated = validatePreset(parsed)
            if (validated) {
              // Use image from file if preset doesn't already have an image
              if (!validated.image && imageFromFile) {
                validated.image = imageFromFile
              }
              validatedPresets.push(validated)
            }
          } catch (error) {
            console.error('Failed to parse preset file:', error)
          }
        }

        console.log('validatedPresets', validatedPresets)
        presets.value = withDevPresets(validatedPresets)
        console.log(`Loaded ${validatedPresets.length} presets from files`)
      } catch (error) {
        console.error('Failed to load presets from files:', error)
      }
    }

    /** Reload built-in + user presets after product mode changes (main IPC uses updated settings). */
    async function reloadAfterProductModeChange(): Promise<void> {
      await loadPresetsFromFiles()
      await loadUserPresets()
    }

    async function loadUserPresets(): Promise<void> {
      try {
        const userPresetFiles = await window.electronAPI.loadUserPresets()
        const validatedPresets: Preset[] = []

        for (const presetFile of userPresetFiles) {
          try {
            // Handle both old format (string) and new format (object with content and image)
            const fileContent = typeof presetFile === 'string' ? presetFile : presetFile.content
            const imageFromFile =
              typeof presetFile === 'object' && presetFile.image ? presetFile.image : null

            const parsed = JSON.parse(fileContent)
            const validated = validatePreset(parsed)
            if (validated) {
              // Use image from file if preset doesn't already have an image
              if (!validated.image && imageFromFile) {
                validated.image = imageFromFile
              }
              validatedPresets.push(validated)
            }
          } catch (error) {
            console.error('Failed to parse user preset file:', error)
          }
        }

        // Merge user presets with built-in presets
        presets.value = [...presets.value, ...validatedPresets]
        console.log(`Loaded ${validatedPresets.length} user presets`)
      } catch (error) {
        console.error('Failed to load user presets:', error)
      }
    }

    async function loadPresetsFromIntel(): Promise<UpdatePresetsFromIntelResult> {
      const syncResponse = await window.electronAPI.updatePresetsFromIntelRepo()
      // Load both built-in and user presets, then update the array once to avoid multiple reactive triggers
      const [builtInPresets, userPresets] = await Promise.all([
        (async () => {
          const presetFiles = await window.electronAPI.reloadPresets()
          const validatedPresets: Preset[] = []
          for (const presetFile of presetFiles) {
            try {
              const fileContent = typeof presetFile === 'string' ? presetFile : presetFile.content
              const imageFromFile =
                typeof presetFile === 'object' && presetFile.image ? presetFile.image : null
              const parsed = JSON.parse(fileContent)
              const validated = validatePreset(parsed)
              if (validated) {
                if (!validated.image && imageFromFile) {
                  validated.image = imageFromFile
                }
                validatedPresets.push(validated)
              }
            } catch (error) {
              console.error('Failed to parse preset file:', error)
            }
          }
          return validatedPresets
        })(),
        (async () => {
          const userPresetFiles = await window.electronAPI.loadUserPresets()
          const validatedPresets: Preset[] = []
          for (const presetFile of userPresetFiles) {
            try {
              const fileContent = typeof presetFile === 'string' ? presetFile : presetFile.content
              const imageFromFile =
                typeof presetFile === 'object' && presetFile.image ? presetFile.image : null
              const parsed = JSON.parse(fileContent)
              const validated = validatePreset(parsed)
              if (validated) {
                if (!validated.image && imageFromFile) {
                  validated.image = imageFromFile
                }
                validatedPresets.push(validated)
              }
            } catch (error) {
              console.error('Failed to parse user preset file:', error)
            }
          }
          return validatedPresets
        })(),
      ])
      // Update the array only once to avoid multiple reactive triggers
      presets.value = withDevPresets([...builtInPresets, ...userPresets])
      return syncResponse
    }

    // ========================================================================
    // Preset Management
    // ========================================================================

    async function addPreset(preset: Preset): Promise<boolean> {
      const validated = validatePreset(preset)
      if (!validated) {
        console.error('Cannot add invalid preset')
        return false
      }

      try {
        const success = await window.electronAPI.saveUserPreset(JSON.stringify(validated, null, 2))
        if (success) {
          // Reload user presets to include the new one
          await loadUserPresets()
          return true
        }
        return false
      } catch (error) {
        console.error('Failed to save user preset:', error)
        return false
      }
    }

    // ========================================================================
    // Category-based Preset Management
    // ========================================================================

    function getPresetsByCategories(categories: string[], type?: string): Preset[] {
      const backendServices = useBackendServices()
      return presets.value
        .filter((preset) => {
          // If type is specified, filter by type
          if (type && preset.type !== type) return false

          // Hide chat presets that opt out of the standard picker (e.g. Home Agent)
          if (preset.type === 'chat' && (preset as ChatPreset).excludeFromChatPresetPicker) {
            return false
          }

          if (preset.type === 'chat' && sttPresetHidden(preset as ChatPreset)) {
            return false
          }

          // Hide Phison presets entirely on systems that do not offer the Phison build.
          // On capable systems they remain listed (greyed-out until installed + active).
          if (
            preset.type === 'chat' &&
            (preset as ChatPreset).requiresPhison &&
            !backendServices.phisonSsdDetected
          ) {
            return false
          }

          // If categories are specified, filter by category
          if (categories.length > 0) {
            const presetCategory = preset.category || 'uncategorized'
            return categories.includes(presetCategory)
          }

          // If no categories specified but type is, return all of that type
          return true
        })
        .sort((a, b) => (b.displayPriority || 0) - (a.displayPriority || 0))
    }

    function getLastUsedPreset(categories: string[]): string | null {
      for (const category of categories) {
        const lastUsed = lastUsedPresetName.value[category]
        if (lastUsed) {
          // Verify the preset still exists
          const preset = presets.value.find((p) => p.name === lastUsed)
          if (preset) {
            return lastUsed
          }
        }
      }
      return null
    }

    function setLastUsedPreset(category: string, presetName: string): void {
      lastUsedPresetName.value[category] = presetName
    }

    /**
     * Carry state stored under a preset's former name over to the name it ships
     * with now. Without it a rename reads as "preset gone": the picker falls back
     * to another preset, the settings the user tuned revert to defaults and the
     * variant they chose is forgotten.
     */
    function migrateRenamedPresets(): void {
      if (activePresetName.value) {
        activePresetName.value = currentPresetName(activePresetName.value)
      }
      for (const [category, name] of Object.entries(lastUsedPresetName.value)) {
        if (name) lastUsedPresetName.value[category] = currentPresetName(name)
      }
      activeVariantName.value = renamePresetKeys(activeVariantName.value)
      settingsPerPreset.value = renamePresetKeys(settingsPerPreset.value)
      lastQualityVariantPerBackend.value = renamePresetKeys(lastQualityVariantPerBackend.value)
    }

    // ========================================================================
    // Computed Properties
    // ========================================================================

    const activePreset = computed(() => {
      if (!activePresetName.value) return null
      return presets.value.find((p) => p.name === activePresetName.value) || null
    })

    const activePresetWithVariant = computed(() => {
      console.log('### presets store activePresetWithVariant', activePresetName.value)
      if (!activePresetName.value) return null
      return getPresetWithVariant(activePresetName.value)
    })

    const presetsByCategory = computed(() => {
      const grouped: Record<string, Preset[]> = {}
      for (const preset of presets.value) {
        const category = preset.category || 'uncategorized'
        if (!grouped[category]) {
          grouped[category] = []
        }
        grouped[category].push(preset)
      }
      return grouped
    })

    const presetsByBackend = computed(() => {
      const grouped: Record<string, Preset[]> = {}
      for (const preset of presets.value) {
        // For chat presets, use first backend from backends array
        // For comfy presets, use backend directly
        const backendKey =
          preset.type === 'chat' ? (preset as ChatPreset).backends[0] : preset.backend
        if (!grouped[backendKey]) {
          grouped[backendKey] = []
        }
        grouped[backendKey].push(preset)
      }
      return grouped
    })

    // Category-specific preset lists for UI components
    // Returns Preset objects directly (components can access .name, .description, .image, etc.)
    const imageGenPresets = computed(() => {
      return presets.value.filter(
        (p) => p.type === 'comfy' && p.category === 'create-images',
      ) as Preset[]
    })

    const imageEditPresets = computed(() => {
      return presets.value.filter(
        (p) => p.type === 'comfy' && p.category === 'edit-images',
      ) as Preset[]
    })

    const videoPresets = computed(() => {
      return presets.value.filter(
        (p) => p.type === 'comfy' && p.category === 'create-videos',
      ) as Preset[]
    })

    /** Chat-type presets the user can actually select, across the Chat and Audio modes. */
    const selectableChatTypePresets = computed(() => {
      const backendServices = useBackendServices()
      const hasNpuDevice = backendServices.info
        .find((s) => s.serviceName === 'openvino-backend')
        ?.devices?.some((d) => d.id.includes('NPU'))
      // Phison is "usable" only when the system offers it, the binary is installed,
      // and the SSD-offload variant is the active build. This keeps an inactive Phison
      // preset out of default-preset auto-selection.
      const phisonUsable =
        backendServices.phisonSsdDetected &&
        (backendServices.info.find((s) => s.serviceName === 'llamacpp-backend')
          ?.llamaCppPhisonArtifactReady ??
          false) &&
        backendServices.llamaCppBuildVariant === 'ssd-offload'

      return presets.value.filter((p) => {
        if (p.type !== 'chat') return false
        const chatPreset = p as ChatPreset
        if (chatPreset.excludeFromChatPresetPicker) return false
        if (sttPresetHidden(chatPreset)) return false
        if (chatPreset.requiresNpuSupport && !hasNpuDevice) {
          return false
        }
        if (chatPreset.requiresPhison && !phisonUsable) {
          return false
        }
        return true
      }) as ChatPreset[]
    })

    // The speech presets moved out of Chat into their own Audio mode, so the chat
    // picker must skip them. Presets without a category stay with Chat (that is
    // where an uncategorized chat preset has always shown up).
    const chatPresets = computed(() =>
      selectableChatTypePresets.value.filter((p) => p.category !== AUDIO_CATEGORY),
    )

    const audioPresets = computed(() =>
      selectableChatTypePresets.value.filter((p) => p.category === AUDIO_CATEGORY),
    )

    // ========================================================================
    // Settings Persistence
    // ========================================================================

    function saveSettingsForPreset(presetName: string, settings: Record<string, unknown>): void {
      settingsPerPreset.value[presetName] = {
        ...settingsPerPreset.value[presetName],
        ...settings,
      }
    }

    function getSettingsForPreset(presetName: string): Record<string, unknown> {
      return settingsPerPreset.value[presetName] || {}
    }

    function resetSettingsForPreset(presetName: string): void {
      delete settingsPerPreset.value[presetName]
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    // Load presets on store creation
    loadPresetsFromFiles().then(() => loadUserPresets())

    return {
      // State
      presets,
      activePresetName,
      activeVariantName,
      settingsPerPreset,
      lastUsedPresetName,
      lastQualityVariantPerBackend,

      // Computed
      activePreset,
      presetsByCategory,
      presetsByBackend,
      imageGenPresets,
      imageEditPresets,
      videoPresets,
      chatPresets,
      audioPresets,
      selectableChatTypePresets,
      activePresetWithVariant,

      // Methods
      validatePreset,
      getPresetWithVariant,
      resolvePresetVariant,
      setActiveVariant,
      applyVariant,
      getFirstVariantName,
      loadPresetsFromFiles,
      loadUserPresets,
      reloadAfterProductModeChange,
      loadPresetsFromIntel,
      addPreset,
      saveSettingsForPreset,
      getSettingsForPreset,
      resetSettingsForPreset,
      getPresetsByCategories,
      getLastUsedPreset,
      setLastUsedPreset,
      migrateRenamedPresets,
      init,
      getDistinctBackendsForPreset,
      getVariantsForBackend,
      getActiveBackend,
      pickInitialVariantForBackend,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      // `settingsPerPreset` / `lastQualityVariantPerBackend` /
      // `lastUsedPresetName` are NOT persisted here anymore: they live in
      // the kernel-owned preferences.json (step 8 §6.1), hydrated by init().
      // Active names stay — the active preset is UI state and
      // `alignModeToActivePreset` reads it synchronously at boot, before any
      // async init.
      pick: ['activePresetName', 'activeVariantName'],
      afterHydrate: (ctx) => {
        // Selection and per-preset state are keyed by preset name, so a preset
        // that shipped under another one has to be followed to its current name.
        ctx.store.migrateRenamedPresets()
      },
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePresets, import.meta.hot))
}
