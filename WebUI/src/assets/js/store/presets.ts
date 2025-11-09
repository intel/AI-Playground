import { defineStore, acceptHMRUpdate } from 'pinia'
import { z } from 'zod'
import { ref, computed } from 'vue'

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
  'imageModel',
  'inpaintModel',
  'guidanceScale',
  'lora',
  'scheduler',
  'imagePreview',
  'safetyCheck',
])

// Base Setting Schema - can be either a standard setting or a generic setting
const SettingSchema = z.object({
  type: z.enum(['number', 'string', 'boolean', 'image', 'video', 'stringList']),
  label: z.string(),
  displayed: z.boolean(),
  modifiable: z.boolean(),
  options: z.array(z.union([z.string(), z.number()])).optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]),
  // For standard settings, specify the setting name
  settingName: StandardSettingNameSchema.optional(),
})

// ComfyInput extends Setting with ComfyUI-specific fields
const ComfyInputSchema = SettingSchema.extend({
  nodeTitle: z.string(),
  nodeInput: z.string(),
  // ComfyInputs don't have settingName (they're workflow-specific)
  settingName: z.undefined().optional(),
})

// Required Model Schema
const RequiredModelSchema = z.object({
  type: z.string(),
  model: z.string(),
  additionalLicenceLink: z.string().optional(),
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
        overrides: z.any(), // DeepPartial<Preset> - using z.any() for flexibility
      }),
    )
    .optional(),
})

// ComfyUI Preset Schema
const ComfyUiPresetSchema = BasePresetFieldsSchema.extend({
  type: z.literal('comfy'),
  backend: z.literal('comfyui'),
  comfyUiApiWorkflow: ComfyUIApiWorkflowSchema,
  requiredCustomNodes: z.array(z.string()).optional(),
  requiredPythonPackages: z.array(z.string()).optional(),
  // ComfyUI-specific settings can be ComfyInput
  settings: z.array(z.union([SettingSchema, ComfyInputSchema])).default([]),
})

// Chat Preset Schema
const ChatPresetSchema = BasePresetFieldsSchema.extend({
  type: z.literal('chat'),
  backend: z.enum(['ipexLLM', 'llamaCPP', 'openVINO', 'ollama']),
  systemPrompt: z.string().optional(),
  contextSize: z.number().optional(),
  maxNewTokens: z.number().optional(),
  supportedDevices: z.array(z.string()).optional(),
  rag: z
    .object({
      embeddingModel: z.string().optional(),
      enabled: z.boolean().optional(),
    })
    .optional(),
})

// Discriminated Union for all Preset types
export const PresetSchema = z.discriminatedUnion('type', [
  ComfyUiPresetSchema,
  ChatPresetSchema,
])

// ============================================================================
// Type Inference from Schemas
// ============================================================================

export type Setting = z.infer<typeof SettingSchema>
export type ComfyInput = z.infer<typeof ComfyInputSchema>
export type RequiredModel = z.infer<typeof RequiredModelSchema>
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
    const settingsPerPreset = ref<Record<string, Record<string, unknown>>>({})

    // ========================================================================
    // Validation
    // ========================================================================

    function validatePreset(data: unknown): Preset | null {
      try {
        return PresetSchema.parse(data)
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

    function applyVariant(basePreset: Preset, variantName: string): Preset {
      const variant = basePreset.variants?.find((v) => v.name === variantName)
      if (!variant) {
        console.warn(`Variant "${variantName}" not found in preset "${basePreset.name}"`)
        return basePreset
      }

      // Deep merge variant overrides into base preset
      const merged = deepMerge(basePreset, variant.overrides as DeepPartial<Preset>)
      return validatePreset(merged) || basePreset
    }

    // Deep merge utility function
    function deepMerge<T extends Record<string, any>>(target: T, source: DeepPartial<T>): T {
      const output = { ...target } as T
      if (source && typeof source === 'object') {
        Object.keys(source).forEach((key) => {
          const sourceValue = (source as any)[key]
          const targetValue = (output as any)[key]

          if (
            sourceValue &&
            typeof sourceValue === 'object' &&
            !Array.isArray(sourceValue) &&
            targetValue &&
            typeof targetValue === 'object' &&
            !Array.isArray(targetValue)
          ) {
            ;(output as any)[key] = deepMerge(targetValue, sourceValue as DeepPartial<typeof targetValue>)
          } else if (sourceValue !== undefined) {
            ;(output as any)[key] = sourceValue
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

        for (const fileContent of presetFiles) {
          try {
            const parsed = JSON.parse(fileContent)
            const validated = validatePreset(parsed)
            if (validated) {
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

        for (const fileContent of userPresetFiles) {
          try {
            const parsed = JSON.parse(fileContent)
            const validated = validatePreset(parsed)
            if (validated) {
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
    // Computed Properties
    // ========================================================================

    const activePreset = computed(() => {
      if (!activePresetName.value) return null
      return presets.value.find((p) => p.name === activePresetName.value) || null
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
        if (!grouped[preset.backend]) {
          grouped[preset.backend] = []
        }
        grouped[preset.backend].push(preset)
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
      settingsPerPreset,

      // Computed
      activePreset,
      presetsByCategory,
      presetsByBackend,
      imageGenPresets,
      imageEditPresets,
      videoPresets,

      // Methods
      validatePreset,
      applyVariant,
      loadPresetsFromFiles,
      loadUserPresets,
      addPreset,
      saveSettingsForPreset,
      getSettingsForPreset,
      resetSettingsForPreset,
    }
  },
  {
    persist: {
      pick: ['activePresetName', 'settingsPerPreset'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePresets, import.meta.hot))
}

