import { defineStore, acceptHMRUpdate } from 'pinia'
import { z } from 'zod'
import { ref, computed, shallowRef } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices } from './backendServices'
import { withDevPresets } from './devPresets'
import { useProductMode } from './productMode'
import { llmBackendTypes } from '@/types/shared'
import { currentPresetName, renamePresetKeys } from '@/lib/presetRenames'

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
    'model',
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
  // For type 'model': ComfyUI model type (e.g. 'checkpoints', 'loras') — options are loaded from disk + requiredModels
  modelType: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.type === 'model' && !value.modelType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['modelType'],
      message: 'modelType is required when type is "model"',
    })
  }
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
  /** Optional how-to instructions shown in PresetSelector tooltip; string or variant name -> text */
  extendedDescription: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
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
        // Unique-within-the-preset internal identifier (used for persistence keys and
        // lookups). Use `displayName` when the user-facing label should differ or when
        // two backends would otherwise collide (e.g. both want "Draft" in the radio).
        name: z.string(),
        // Optional user-facing label shown in the variant radio. Defaults to `name`.
        displayName: z.string().optional(),
        removeSettings: z.array(z.string()).optional(), // Labels of settings to remove
        // When set, the variant is hidden from the picker if the named backend service is
        // missing from `backendServices.info` or has status 'notInstalled'.
        requiresService: z.string().optional(),
        // When true, the variant's `comfyUiApiWorkflow` fully replaces the base workflow
        // instead of being deep-merged into it. Use when the variant runs a completely
        // different graph (e.g. swapping a multi-node native pipeline for a single OVMS node).
        replaceWorkflow: z.boolean().optional(),
        // Groups variants by execution backend (e.g. 'comfyui', 'openvino'). When omitted,
        // the variant is treated as belonging to the default 'comfyui' backend. The
        // SettingsWorkflow Backend dropdown is built from the distinct values across
        // a preset's variants; the quality radio in PresetSelector then filters to
        // variants matching the active backend.
        backend: z.string().optional(),
        overrides: z.any(), // DeepPartial<Preset> - using z.any() for flexibility
      }),
    )
    .optional(),
  // Tool metadata for ComfyUI tool integration
  mediaType: z.enum(['image', 'video', 'model3d']).optional(), // Specifies what type of media the preset generates
  toolInstructions: z.string().optional(), // Instructions for the AI on how to generate prompts for this preset
  toolCategory: z.string().optional(), // Category for tool organization (e.g., 'create-images', 'edit-images'). Presets without toolCategory are not available as tools.
  // When true, hide this preset from the Home Agent (Telegram) /imgGen picker.
  // Set on presets that need extra UI configuration (e.g. manual sliders, reference
  // image uploads) and therefore can't be driven cleanly via a chat command.
  excludeFromHomeAgentPicker: z.boolean().optional(),
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

// LLM Backend enum for chat presets. Mirrors the shared backend list so presets
// can also target the remote Cloud Mode backend.
const LlmBackendEnum = z.enum(llmBackendTypes)

// Chat Preset Schema - uses 'backends' array instead of single 'backend'
const ChatPresetSchema = BasePresetFieldsSchema.omit({ backend: true }).extend({
  type: z.literal('chat'),
  backends: z.array(LlmBackendEnum).min(1), // Array of allowed backends
  preferredModels: z.partialRecord(LlmBackendEnum, z.string()).optional(), // Per-backend default models
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
  // Only available when the Phison aiDAPTIV+ (ssd-offload) Llama.cpp build is installed.
  // Used by presets bundling large MoE models that rely on SSD offload.
  requiresPhison: z.boolean().optional(),
  // Capability flag: this preset OFFERS the Phison KM RAG option (token-based
  // merged-group retrieval + KV cache pre-warming). Selectable at runtime only when
  // the Phison aiDAPTIV+ build is active and the llamaCPP backend is selected.
  supportsPhisonKmRag: z.boolean().optional(),
  // Default retrieval mode when the user has not chosen one for this preset.
  defaultRagMode: z.enum(['standard', 'phisonKm']).optional(),
  toolsEnabledByDefault: z.boolean().optional(), // Explicit default for tools toggle
  // When true, this "chat" preset is a direct Text-to-Speech generator rather than an LLM
  // chat: selecting it turns the prompt box into a synthesizer (typed text -> Qwen3-TTS
  // audio, no LLM loaded). The `backends` array is a schema-required placeholder and is
  // unused. Lives in the `audio` category (the Audio mode), not `chat`.
  // See SettingsTts.vue and the direct-synthesis branch in openAiCompatibleChat.
  ttsPreset: z.boolean().optional(),
  // When true, this "chat" preset runs on the agent harness (Pi coding agent in the
  // main process) instead of plain chat inference: selecting it switches the app to
  // Agent Mode, where the model works on files in a workspace folder with the tools
  // its capabilities provide. `systemPrompt` becomes extra instructions appended to
  // the agent's own prompt. See presetToMode() and the agentMode store.
  agentPreset: z.boolean().optional(),
  // Capability ids the agent session is equipped with ('media', 'web-debug',
  // 'game-studio', 'memory', `mcp:<serverId>`). When set, it replaces the user's
  // default selection for sessions started under this preset.
  agentCapabilities: z.array(z.string()).optional(),
  // Where the agent works: 'pick' lets the user choose any folder, 'games' has the
  // app provision a folder per game under the games library (no folder picker).
  agentWorkspace: z.enum(['pick', 'games']).optional(),
  requiresCoding: z.boolean().optional(), // Filter models to ones fit for writing code
  // When true, this "chat" preset is a direct Speech-to-Text transcriber rather than
  // an LLM chat: selecting it turns the prompt box into a record/upload surface
  // (recorded or uploaded audio -> Whisper transcript, no LLM loaded). Like
  // `ttsPreset`, the `backends` array is a schema-required placeholder and is unused,
  // and it lives in the `audio` category. OpenVINO-only, so it is filtered out in NVIDIA
  // product mode. See SettingsStt.vue and the direct-transcribe branch in
  // openAiCompatibleChat.
  sttPreset: z.boolean().optional(),
  // UI visibility controls
  enableRAG: z.boolean().optional(), // Show "Add Documents" + embeddings selector (default: false)
  showTools: z.boolean().optional(), // Show "Enable Tools" toggle (default: false)
  filterTxt2TxtOnly: z.boolean().optional(), // Filter out vision AND reasoning models
  filterLargeMoeOnly: z.boolean().optional(), // Only show large Mixture-of-Experts models (e.g. for the Phison aiDAPTIV+ preset)
  advancedMode: z.boolean().optional(), // Show advanced features: unspecified models + system prompt editing + vision model support
  // When true, the preset is hidden from the standard chat PresetSelector. Used by built-in
  // presets that drive a specific feature (e.g. Home Agent / Telegram) and should not be
  // selectable from the normal Chat Settings picker.
  excludeFromChatPresetPicker: z.boolean().optional(),
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
// Pure derivations
// ============================================================================

/** Preset category backing the Audio mode (Text to Speech / Speech to Text). */
export const AUDIO_CATEGORY = 'audio'

/**
 * Whether a ComfyUI preset requires the user to enter a text prompt.
 *
 * The single source of truth is the structured prompt setting: a preset
 * requires a user prompt iff its `settings` contain an entry with
 * `settingName: 'prompt'` and `modifiable: true`. The `"no-prompt"` tag
 * is human-readable documentation only and is intentionally not consulted.
 */
export function presetRequiresUserPrompt(preset: ComfyUiPreset): boolean {
  return preset.settings.some(
    (s) => 'settingName' in s && s.settingName === 'prompt' && s.modifiable,
  )
}

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
            errors: error.issues,
            data,
          })
          // Return user-friendly error message
          const errorMessages = error.issues
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

      // Full workflow replacement: opt-in for variants whose workflow is structurally
      // disjoint from the base (e.g. OVMS single-node graph replacing a native pipeline).
      // Without this, deepMerge would union both sets of nodes producing a frankenstein.
      if (
        variant.replaceWorkflow &&
        merged.type === 'comfy' &&
        variant.overrides &&
        typeof variant.overrides === 'object' &&
        'comfyUiApiWorkflow' in variant.overrides &&
        variant.overrides.comfyUiApiWorkflow
      ) {
        merged.comfyUiApiWorkflow = variant.overrides.comfyUiApiWorkflow as ComfyUIApiWorkflow
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
      getDistinctBackendsForPreset,
      getVariantsForBackend,
      getActiveBackend,
      pickInitialVariantForBackend,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: [
        'activePresetName',
        'activeVariantName',
        'settingsPerPreset',
        'lastUsedPresetName',
        'lastQualityVariantPerBackend',
      ],
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
