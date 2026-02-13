import { defineStore, acceptHMRUpdate } from 'pinia'
import { z } from 'zod'
import { ref, computed } from 'vue'
import { useBackendServices } from './backendServices'

// DeepPartial utility type
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

// ============================================================================
// Zod Schemas - Composition-based, no inheritance
// ============================================================================

// Standard Setting Names (from imageGeneration SettingsSchema)
const StandardSettingNameSchema = z.enum([
  'prompt',
  'seed',
  'inferenceSteps',
  'width',
  'height',
  'resolution',
  'batchSize',
  'negativePrompt',
  'safetyCheck',
  'showPreview',
])

// Base Setting Schema - can be either a standard setting or a generic setting
const SettingSchema = z.object({
  type: z.enum([
    'number',
    'string',
    'boolean',
    'image',
    'video',
    'stringList',
    'outpaintCanvas',
    'inpaintMask',
  ]),
  label: z.string(),
  displayed: z.boolean(),
  modifiable: z.boolean(),
  options: z.array(z.union([z.string(), z.number()])).optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  // For standard settings, specify the setting name
  settingName: StandardSettingNameSchema.optional(),
})

// ComfyInput extends Setting with ComfyUI-specific fields
const ComfyInputSchema = SettingSchema.extend({
  nodeTitle: z.string(),
  nodeInput: z.string(),
  // ComfyInputs don't have settingName (they're workflow-specific)
  settingName: z.undefined().optional(),
  // Optional min/max/step for numeric inputs
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  // Optional flag for image inputs - when true and empty, injects black pixel
  optional: z.boolean().optional(),
})

// Required Model Schema
const RequiredModelSchema = z.object({
  type: z.string(),
  model: z.string(),
  additionalLicenceLink: z.string().optional(),
})

// Resolution Configuration Schema - defines available megapixels and aspect ratios per preset
const MegapixelOptionSchema = z.object({
  label: z.string(), // e.g., "0.5", "1.0"
  totalPixels: z.number(), // e.g., 495616 (704*704)
})

export const ResolutionConfigSchema = z.object({
  megapixels: z.array(MegapixelOptionSchema),
  aspectRatios: z.array(z.string()), // e.g., ["1/1", "16/9", "9/16"]
  useLookupTable: z.boolean().optional().default(true), // false for LTX Video dynamic calculation
})

// ComfyUI API Workflow Schema (reused from imageGeneration)
const ComfyUIApiWorkflowSchema = z.record(
  z.string(),
  z
    .object({
      inputs: z
        .object({
          text: z.string().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
)

// Base Preset Fields (common to all presets)
const BasePresetFieldsSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  image: z.string().optional(), // base64 encoded image
  category: z.string().optional(),
  displayPriority: z.number().default(0),
  tags: z.array(z.string()).default([]),
  backend: z.string(),
  additionalBackends: z.array(z.string()).optional(),
  requiredModels: z.array(RequiredModelSchema).optional(),
  settings: z.array(SettingSchema).default([]),
  variants: z
    .array(
      z.object({
        name: z.string(),
        removeSettings: z.array(z.string()).optional(), // Labels of settings to remove
        overrides: z.any(), // DeepPartial<Preset> - using z.any() for flexibility
      }),
    )
    .optional(),
  // Tool metadata for ComfyUI tool integration
  mediaType: z.enum(['image', 'video', 'model3d']).optional(), // Specifies what type of media the preset generates
  toolInstructions: z.string().optional(), // Instructions for the AI on how to generate prompts for this preset
  toolCategory: z.string().optional(), // Category for tool organization (e.g., 'create-images', 'edit-images'). Presets without toolCategory are not available as tools.
})

// ComfyUI Preset Schema
const ComfyUiPresetSchema = BasePresetFieldsSchema.extend({
  type: z.literal('comfy'),
  backend: z.literal('comfyui'),
  comfyUiApiWorkflow: ComfyUIApiWorkflowSchema,
  requiredCustomNodes: z.array(z.string()).optional(),
  requiredPythonPackages: z.array(z.string()).optional(),
  // ComfyUI-specific settings can be ComfyInput
  settings: z.array(z.union([ComfyInputSchema, SettingSchema])).default([]),
  // Resolution configuration for aspect ratio and megapixel options
  resolutionConfig: ResolutionConfigSchema.optional(),
})

// LLM Backend enum for chat presets
const LlmBackendEnum = z.enum(['llamaCPP', 'openVINO', 'ollama'])

// Chat Preset Schema - uses 'backends' array instead of single 'backend'
const ChatPresetSchema = BasePresetFieldsSchema.omit({ backend: true }).extend({
  type: z.literal('chat'),
  backends: z.array(LlmBackendEnum).min(1), // Array of allowed backends
  preferredModels: z.record(LlmBackendEnum, z.string()).optional(), // Per-backend default models
  systemPrompt: z.string().optional(),
  contextSize: z.number().optional(),
  maxNewTokens: z.number().optional(),
  temperature: z.number().optional(),
  supportedDevices: z.array(z.string()).optional(),
  embeddingModel: z.string().optional(), // Top-level embedding model for convenience
  rag: z
    .object({
      embeddingModel: z.string().optional(),
      enabled: z.boolean().optional(),
    })
    .optional(),
  requiresVision: z.boolean().optional(),
  requiresToolCalling: z.boolean().optional(),
  requiresReasoning: z.boolean().optional(),
  requiresNpuSupport: z.boolean().optional(), // Filter models to only show NPU-compatible ones
  toolsEnabledByDefault: z.boolean().optional(), // Explicit default for tools toggle
  // UI visibility controls
  enableRAG: z.boolean().optional(), // Show "Add Documents" + embeddings selector (default: false)
  showTools: z.boolean().optional(), // Show "Enable Tools" toggle (default: false)
  filterTxt2TxtOnly: z.boolean().optional(), // Filter out vision AND reasoning models
  lockDeviceToNpu: z.boolean().optional(), // Lock device selector to NPU
  advancedMode: z.boolean().optional(), // Show advanced features: unspecified models + system prompt editing + vision model support
})

// Discriminated Union for all Preset types
export const PresetSchema = z.discriminatedUnion('type', [ComfyUiPresetSchema, ChatPresetSchema])

// ============================================================================
// Type Inference from Schemas
// ============================================================================

export type Setting = z.infer<typeof SettingSchema>
export type ComfyInput = z.infer<typeof ComfyInputSchema>
export type RequiredModel = z.infer<typeof RequiredModelSchema>
export type ResolutionConfig = z.infer<typeof ResolutionConfigSchema>
export type MegapixelOption = z.infer<typeof MegapixelOptionSchema>
export type ComfyUIApiWorkflow = z.infer<typeof ComfyUIApiWorkflowSchema>
export type Preset = z.infer<typeof PresetSchema>
export type ComfyUiPreset = z.infer<typeof ComfyUiPresetSchema>
export type ChatPreset = z.infer<typeof ChatPresetSchema>

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

    // ========================================================================
    // Validation
    // ========================================================================

    function validatePreset(data: unknown): Preset | null {
      try {
        console.log('### validating preset', data)
        const validated = PresetSchema.parse(data)
        console.log('### validated preset', validated)
        return validated
      } catch (error) {
        if (error instanceof z.ZodError) {
          console.error('Preset validation failed:', {
            errors: error.errors,
            data,
          })
          // Return user-friendly error message
          const errorMessages = error.errors
            .map((err) => `${err.path.join('.')}: ${err.message}`)
            .join(', ')
          console.error(`Preset validation errors: ${errorMessages}`)
        } else {
          console.error('Unexpected error during preset validation:', error)
        }
        return null
      }
    }

    // ========================================================================
    // Variant Application
    // ========================================================================

    function getFirstVariantName(preset: Preset): string | null {
      if (!preset.variants || preset.variants.length === 0) {
        return null
      }
      return preset.variants[0].name
    }

    function applyVariant(basePreset: Preset, variantName: string): Preset {
      const variant = basePreset.variants?.find((v) => v.name === variantName)
      if (!variant) {
        console.warn(`Variant "${variantName}" not found in preset "${basePreset.name}"`)
        return basePreset
      }

      // Deep merge variant overrides into base preset
      const merged = deepMerge(basePreset, variant.overrides as DeepPartial<Preset>)

      // Remove settings specified in removeSettings array
      if (variant.removeSettings && variant.removeSettings.length > 0 && merged.settings) {
        merged.settings = merged.settings.filter(
          (setting) => !variant.removeSettings!.includes(setting.label),
        )
      }

      return validatePreset(merged) || basePreset
    }

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

    function setActiveVariant(presetName: string, variantName: string | null): void {
      const preset = presets.value.find((p) => p.name === presetName)

      // If preset has variants and null is passed, select first variant instead
      if (variantName === null && preset && preset.variants && preset.variants.length > 0) {
        const firstVariant = getFirstVariantName(preset)
        if (firstVariant) {
          activeVariantName.value[presetName] = firstVariant
          return
        }
      }

      if (variantName) {
        activeVariantName.value[presetName] = variantName
      } else {
        // Only delete if preset has no variants
        if (!preset || !preset.variants || preset.variants.length === 0) {
          delete activeVariantName.value[presetName]
        }
      }
    }

    // Deep merge utility function
    function deepMerge<T extends Record<string, unknown>>(target: T, source: DeepPartial<T>): T {
      const output = { ...target } as T
      if (source && typeof source === 'object') {
        Object.keys(source).forEach((key) => {
          const sourceValue = (source as Record<string, unknown>)[key]
          const targetValue = (output as Record<string, unknown>)[key]

          // Special handling for settings arrays - merge by label
          if (key === 'settings' && Array.isArray(sourceValue) && Array.isArray(targetValue)) {
            const mergedSettings = [...targetValue]
            sourceValue.forEach((sourceSetting: Record<string, unknown>) => {
              const index = mergedSettings.findIndex(
                (s: Record<string, unknown>) => s.label === sourceSetting.label,
              )
              if (index >= 0) {
                mergedSettings[index] = { ...mergedSettings[index], ...sourceSetting }
              } else {
                mergedSettings.push(sourceSetting)
              }
            })
            ;(output as Record<string, unknown>)[key] = mergedSettings
          } else if (
            sourceValue &&
            typeof sourceValue === 'object' &&
            !Array.isArray(sourceValue) &&
            targetValue &&
            typeof targetValue === 'object' &&
            !Array.isArray(targetValue)
          ) {
            ;(output as Record<string, unknown>)[key] = deepMerge(
              targetValue as Record<string, unknown>,
              sourceValue as DeepPartial<Record<string, unknown>>,
            )
          } else if (sourceValue !== undefined) {
            ;(output as Record<string, unknown>)[key] = sourceValue
          }
        })
      }
      return output
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
        presets.value = validatedPresets
        console.log(`Loaded ${validatedPresets.length} presets from files`)
      } catch (error) {
        console.error('Failed to load presets from files:', error)
      }
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
      presets.value = [...builtInPresets, ...userPresets]
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
      return presets.value
        .filter((preset) => {
          // If type is specified, filter by type
          if (type && preset.type !== type) return false

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

    const chatPresets = computed(() => {
      // Get backend services to check availability
      const backendServices = useBackendServices()
      const ollamaServiceExists = backendServices.info.some(
        (s) => s.serviceName === 'ollama-backend',
      )
      // Check if NPU device is available
      const hasNpuDevice = backendServices.info
        .find((s) => s.serviceName === 'openvino-backend')
        ?.devices?.some((d) => d.id.includes('NPU'))

      return presets.value.filter((p) => {
        if (p.type !== 'chat') return false
        const chatPreset = p as ChatPreset
        // Filter out ollama-only presets if ollama service doesn't exist
        if (
          chatPreset.backends.length === 1 &&
          chatPreset.backends[0] === 'ollama' &&
          !ollamaServiceExists
        ) {
          return false
        }
        // Filter out NPU preset if no NPU device available
        if (chatPreset.requiresNpuSupport && !hasNpuDevice) {
          return false
        }
        return true
      }) as ChatPreset[]
    })

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

      // Computed
      activePreset,
      presetsByCategory,
      presetsByBackend,
      imageGenPresets,
      imageEditPresets,
      videoPresets,
      chatPresets,
      activePresetWithVariant,

      // Methods
      validatePreset,
      getPresetWithVariant,
      setActiveVariant,
      applyVariant,
      getFirstVariantName,
      loadPresetsFromFiles,
      loadUserPresets,
      loadPresetsFromIntel,
      addPreset,
      saveSettingsForPreset,
      getSettingsForPreset,
      resetSettingsForPreset,
      getPresetsByCategories,
      getLastUsedPreset,
      setLastUsedPreset,
    }
  },
  {
    persist: {
      pick: ['activePresetName', 'activeVariantName', 'settingsPerPreset', 'lastUsedPresetName'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePresets, import.meta.hot))
}
