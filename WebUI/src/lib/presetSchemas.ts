import { z } from 'zod'
import { llmBackendTypes } from '@/types/shared'

// Preset schemas and pure preset derivations, shared between the renderer's
// presets store and the Electron main process (whose artifact runner needs to
// validate catalog entries and apply variants without touching Pinia). This
// module must stay dependency-free beyond zod and pure types.

// DeepPartial utility type
export type DeepPartial<T> = {
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
export const SettingSchema = z.object({
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
export const ComfyInputSchema = SettingSchema.extend({
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
export const RequiredModelSchema = z.object({
  type: z.string(),
  model: z.string(),
  additionalLicenceLink: z.string().optional(),
})

// Resolution Configuration Schema - defines available megapixels and aspect ratios per preset
export const MegapixelOptionSchema = z.object({
  label: z.string(), // e.g., "0.5", "1.0"
  totalPixels: z.number(), // e.g., 495616 (704*704)
})

export const ResolutionConfigSchema = z.object({
  megapixels: z.array(MegapixelOptionSchema),
  aspectRatios: z.array(z.string()), // e.g., ["1/1", "16/9", "9/16"]
  useLookupTable: z.boolean().optional().default(true), // false for LTX Video dynamic calculation
})

// ComfyUI API Workflow Schema (reused from imageGeneration)
export const ComfyUIApiWorkflowSchema = z.record(
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
  toolCategory: z.string().optional(), // Category for tool organization (e.g. 'create-images', 'edit-images'). Presets without toolCategory are not available as tools.
  // When true, hide this preset from the Home Agent (Telegram) /imgGen picker.
  // Set on presets that need extra UI configuration (e.g. manual sliders, reference
  // image uploads) and therefore can't be driven cleanly via a chat command.
  excludeFromHomeAgentPicker: z.boolean().optional(),
})

// ComfyUI Preset Schema
export const ComfyUiPresetSchema = BasePresetFieldsSchema.extend({
  type: z.literal('comfy'),
  backend: z.literal('comfyui'),
  comfyUiApiWorkflow: ComfyUIApiWorkflowSchema,
  requiredCustomNodes: z.array(z.string()).optional(),
  requiredPythonPackages: z.array(z.string()).optional(),
  // Extra ComfyUI launch flags this workflow needs (e.g. an attention mode a
  // model requires). They are added to the backend command line for this run only.
  requiredComfyUiParameters: z.array(z.string()).optional(),
  // ComfyUI-specific settings can be ComfyInput
  settings: z.array(z.union([ComfyInputSchema, SettingSchema])).default([]),
  // Resolution configuration for aspect ratio and megapixel options
  resolutionConfig: ResolutionConfigSchema.optional(),
})

// LLM Backend enum for chat presets. Mirrors the shared backend list so presets
// can also target the remote Cloud Mode backend.
const LlmBackendEnum = z.enum(llmBackendTypes)

// Chat Preset Schema - uses 'backends' array instead of single 'backend'
export const ChatPresetSchema = BasePresetFieldsSchema.omit({ backend: true }).extend({
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
  requiresNpuSupport: z.boolean().optional(), // Filter models to only show NPU-compatible models
  // Only available when the Phison aiDAPTIV+ (ssd-offload) Llama.cpp build is installed.
  // Used for presets bundling large MoE models that rely on SSD offload.
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
  // Filter models to ones reliable at multi-step tool use (Agent, Game Agent, Quick Coder).
  requiresAgentic: z.boolean().optional(),
  // When true, this "chat" preset is a direct Speech-to-Text transcriber rather than an
  // LLM chat: selecting it turns the prompt box into a record/upload surface
  // (recorded or uploaded audio -> Whisper transcript, no LLM loaded). Like `ttsPreset`,
  // the `backends` array is a schema-required placeholder and is unused, and it lives
  // in the `audio` category. OpenVINO-only, so it is filtered out in NVIDIA product mode.
  // See SettingsStt.vue and the direct-transcribe branch in openAiCompatibleChat.
  sttPreset: z.boolean().optional(),
  // UI visibility controls
  enableRAG: z.boolean().optional(), // Show "Add Documents" + embeddings selector (default: false)
  showTools: z.boolean().optional(), // Show "Enable Tools" toggle (default: false)
  filterTxt2TxtOnly: z.boolean().optional(), // Filter out vision AND reasoning models
  filterLargeMoeOnly: z.boolean().optional(), // Only show large MoE models (e.g. for the Phison aiDAPTIV+ preset)
  advancedMode: z.boolean().optional(), // Show advanced features: unspecified models + system prompt editing + vision model support
  // When true, the preset is hidden from the standard chat PresetSelector. Used for built-in
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

export function validatePreset(data: unknown): Preset | null {
  try {
    return PresetSchema.parse(data)
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join('.')}: ${err.message}`)
        .join(', ')
      console.error(
        `Preset validation failed for "${String((data as { name?: string })?.name ?? 'unknown')}": ${errorMessages}`,
      )
    } else {
      console.error('Unexpected error during preset validation:', error)
    }
    return null
  }
}

export function getFirstVariantName(preset: Preset): string | null {
  if (!preset.variants || preset.variants.length === 0) {
    return null
  }
  return preset.variants[0].name
}

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

/** Apply a named variant's overrides to a base preset; returns the base when unknown. */
export function applyVariant(basePreset: Preset, variantName: string): Preset {
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
