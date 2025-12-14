import { z } from 'zod'
import { watch } from 'vue'
import { useImageGenerationPresets, type MediaItem } from '../store/imageGenerationPresets'
import { useComfyUiPresets } from '../store/comfyUiPresets'
import { useBackendServices } from '../store/backendServices'
import { usePresets, type Preset } from '../store/presets'
import { usePresetSwitching } from '../store/presetSwitching'
import { usePromptStore } from '../store/promptArea'
import { tool } from 'ai'

// Global defaults as fallback (matching imageGenerationPresets.ts)
const globalDefaultSettings = {
  seed: -1,
  width: 512,
  height: 512,
  inferenceSteps: 6,
  resolution: '704x384',
  batchSize: 4,
  negativePrompt: 'nsfw',
}

// Helper function to get available workflows for the tool
export function getAvailableWorkflows(): Array<{
  name: string
  mediaType?: 'image' | 'video' | 'model3d'
  description?: string
  toolInstructions?: string
}> {
  const presets = usePresets()

  return presets.presets
    .filter((preset: Preset) => {
      // Only ComfyUI presets
      if (preset.type !== 'comfy' || preset.backend !== 'comfyui') {
        return false
      }
      // Only presets with toolEnabled: true
      return preset.toolEnabled === true
    })
    .map((preset: Preset) => ({
      name: preset.name,
      mediaType: preset.mediaType,
      description: preset.description,
      toolInstructions: preset.toolInstructions,
    }))
}

const ImageOutputSchema = z.object({
  id: z.string(),
  type: z.literal('image'),
  imageUrl: z.string(),
  mode: z.literal('imageGen'),
  settings: z.record(z.string(), z.unknown()),
})

const VideoOutputSchema = z.object({
  id: z.string(),
  type: z.literal('video'),
  videoUrl: z.string(),
  mode: z.literal('imageGen'),
  settings: z.record(z.string(), z.unknown()),
})

const Model3DOutputSchema = z.object({
  id: z.string(),
  type: z.literal('model3d'),
  model3dUrl: z.string(),
  mode: z.literal('imageGen'),
  settings: z.record(z.string(), z.unknown()),
})

const MediaOutputSchema = z.discriminatedUnion('type', [
  ImageOutputSchema,
  VideoOutputSchema,
  Model3DOutputSchema,
])

export const ComfyUiToolOutputSchema = z
  .object({
    images: z.array(MediaOutputSchema),
    // Optional fields for error handling
    success: z.boolean().optional(),
    message: z.string().optional(),
  })
  .passthrough()

export type ComfyUiToolOutput = z.infer<typeof ComfyUiToolOutputSchema>

// Helper function to find Fast variant in a preset
function findFastVariant(preset: Preset): string | null {
  if (!preset.variants || preset.variants.length === 0) return null
  const fastVariant = preset.variants.find((v) => v.name.toLowerCase().includes('fast'))
  console.log('### findFastVariant', { preset, fastVariant })
  return fastVariant ? fastVariant.name : null
}

// Helper function to execute ComfyUI generation for tool calls
export async function executeComfyGeneration(args: {
  workflow?: string
  variant?: string
  prompt: string
  negativePrompt?: string
  resolution?: string
  inferenceSteps?: number
  seed?: number
  batchSize?: number
}): Promise<ComfyUiToolOutput> {
  console.log('[ComfyUI Tool] Starting generation with args:', args)
  const imageGeneration = useImageGenerationPresets()
  const comfyUi = useComfyUiPresets()
  const backendServices = useBackendServices()
  const presets = usePresets()

  // Helper to create error result instead of throwing
  const createErrorResult = (message: string): ComfyUiToolOutput => ({
    success: false,
    message,
    images: [],
  })

  // Ensure ComfyUI backend is running - this is unrecoverable
  const comfyUiService = backendServices.info.find((item) => item.serviceName === 'comfyui-backend')
  if (!comfyUiService || comfyUiService.status !== 'running') {
    console.error('[ComfyUI Tool] Backend not running')
    return createErrorResult('ComfyUI backend is not running. Please start it first.')
  }

  // Find preset by name - fall back to default workflow if not found
  let preset: Preset | null = null
  const requestedWorkflow = args.workflow || 'Draft Image'

  preset = presets.presets.find((p) => p.name === requestedWorkflow) || null
  if (!preset || preset.type !== 'comfy') {
    // Try to find any available ComfyUI preset as fallback
    console.warn(`[ComfyUI Tool] Preset "${requestedWorkflow}" not found or not a ComfyUI preset, trying fallback`)
    preset = presets.presets.find((p) => p.type === 'comfy') || null
    if (!preset) {
      return createErrorResult('No ComfyUI presets available')
    }
    console.log(`[ComfyUI Tool] Using fallback preset: ${preset.name}`)
  }

  // Select variant - fall back to first variant or Fast variant if requested variant is invalid
  let selectedVariant: string | null = null
  if (preset.variants && preset.variants.length > 0) {
    if (args.variant) {
      // Check if the specified variant exists
      const variantExists = preset.variants.some((v) => v.name === args.variant)
      if (variantExists) {
        selectedVariant = args.variant
      } else {
        // Fall back to Fast variant or first variant instead of throwing
        console.warn(
          `[ComfyUI Tool] Variant "${args.variant}" not found in preset "${preset.name}", falling back to default`,
        )
        const fastVariant = findFastVariant(preset)
        selectedVariant = fastVariant || preset.variants[0].name
      }
    } else {
      // Prefer Fast variant if no variant specified
      const fastVariant = findFastVariant(preset)
      selectedVariant = fastVariant || preset.variants[0].name
    }
  }

  console.log(`[ComfyUI Tool] Using preset: ${preset.name}, variant: ${selectedVariant || 'none'}`)

  // Get preset with variant applied (important for reading correct settings)
  // Set variant in store first so getPresetWithVariant can find it
  if (selectedVariant) {
    presets.setActiveVariant(preset.name, selectedVariant)
  }
  const presetWithVariant = presets.getPresetWithVariant(preset.name)
  if (!presetWithVariant) {
    console.error(`[ComfyUI Tool] Failed to get preset "${preset.name}" with variant`)
    return createErrorResult(`Failed to apply preset "${preset.name}"`)
  }
  // Update preset reference to use the variant-applied preset
  preset = presetWithVariant

  // Helper function to get default value from preset settings (now uses variant-applied preset)
  const getPresetDefault = (settingName: string): unknown => {
    if (!preset) return null
    const setting = preset.settings.find(
      (s: { settingName?: string }) => 'settingName' in s && s.settingName === settingName,
    )
    return setting?.defaultValue ?? null
  }

  // Parse resolution if provided, otherwise use preset default
  let width: number
  let height: number
  if (args.resolution) {
    const [w, h] = args.resolution.split('x').map(Number)
    if (w && h) {
      width = w
      height = h
    } else {
      // Fallback to preset default if parsing fails
      const defaultResolution = getPresetDefault('resolution') as string | null
      if (defaultResolution) {
        const [dw, dh] = defaultResolution.split('x').map(Number)
        width = dw || imageGeneration.width
        height = dh || imageGeneration.height
      } else {
        width = imageGeneration.width
        height = imageGeneration.height
      }
    }
  } else {
    // Use preset default resolution
    const defaultResolution = getPresetDefault('resolution') as string | null
    if (defaultResolution) {
      const [w, h] = defaultResolution.split('x').map(Number)
      width = w || imageGeneration.width
      height = h || imageGeneration.height
    } else {
      width = imageGeneration.width
      height = imageGeneration.height
    }
  }

  // Set up temporary image tracking, using preset default for batchSize if not provided
  const batchSize = args.batchSize ?? (getPresetDefault('batchSize') as number | null) ?? 1
  const imageIds: string[] = Array.from({ length: batchSize }, () => crypto.randomUUID())

  // Save original values
  const originalPrompt = imageGeneration.prompt
  const originalNegativePrompt = imageGeneration.negativePrompt
  const originalInferenceSteps = imageGeneration.inferenceSteps
  const originalWidth = imageGeneration.width
  const originalHeight = imageGeneration.height
  const originalSeed = imageGeneration.seed
  const originalBatchSize = imageGeneration.batchSize
  const originalActivePresetName = presets.activePresetName
  const originalActiveVariant = originalActivePresetName
    ? presets.activeVariantName[originalActivePresetName] || null
    : null

  // Helper to restore state and clean up
  const restoreState = async () => {
    imageGeneration.prompt = originalPrompt
    imageGeneration.negativePrompt = originalNegativePrompt
    imageGeneration.inferenceSteps = originalInferenceSteps
    imageGeneration.width = originalWidth
    imageGeneration.height = originalHeight
    imageGeneration.seed = originalSeed
    imageGeneration.batchSize = originalBatchSize

    // Restore original preset using orchestrator
    if (originalActivePresetName) {
      const presetSwitching = usePresetSwitching()
      await presetSwitching.switchPreset(originalActivePresetName, {
        variant: originalActiveVariant ?? undefined,
        skipModeSwitch: true,
        skipLastUsedUpdate: true,
      })
    }
  }

  try {
    // Set the active preset and variant using the orchestrator
    // Use the resolved preset name (which might differ from args.workflow if we fell back)
    const presetSwitching = usePresetSwitching()
    const switchResult = await presetSwitching.switchPreset(preset.name, {
      variant: selectedVariant ?? undefined,
      skipModeSwitch: true, // Tool calls shouldn't change the UI mode
      skipLastUsedUpdate: true, // Don't update last-used for tool-initiated switches
    })

    if (!switchResult.success) {
      console.error(`[ComfyUI Tool] Failed to switch to preset: ${switchResult.error}`)
      await restoreState()
      return createErrorResult(`Failed to switch to preset "${preset.name}"`)
    }

    console.log('[ComfyUI Tool] Ensuring models are available')

    // Ensure required models are available before proceeding
    await imageGeneration.ensureModelsAreAvailable()

    // Set temporary values, using preset defaults when tool args don't provide values
    // Always use preset defaults, not saved values
    imageGeneration.prompt = args.prompt
    imageGeneration.negativePrompt =
      args.negativePrompt ??
      (getPresetDefault('negativePrompt') as string | null) ??
      globalDefaultSettings.negativePrompt
    imageGeneration.inferenceSteps =
      args.inferenceSteps ??
      (getPresetDefault('inferenceSteps') as number | null) ??
      globalDefaultSettings.inferenceSteps
    imageGeneration.width = width
    imageGeneration.height = height
    imageGeneration.seed =
      args.seed ?? (getPresetDefault('seed') as number | null) ?? globalDefaultSettings.seed
    imageGeneration.batchSize = batchSize

    // Determine media type from preset, default to 'image'
    const mediaType = (preset?.mediaType as 'image' | 'video' | 'model3d') || 'image'

    // Create media items in queued state
    imageIds.forEach((imageId) => {
      const baseItem = {
        id: imageId,
        mode: 'imageGen' as const,
        state: 'queued' as const,
        settings: {},
      }

      if (mediaType === 'video') {
        imageGeneration.updateImage({
          ...baseItem,
          type: 'video',
          videoUrl: '',
        })
      } else if (mediaType === 'model3d') {
        imageGeneration.updateImage({
          ...baseItem,
          type: 'model3d',
          model3dUrl: '',
        })
      } else {
        imageGeneration.updateImage({
          ...baseItem,
          type: 'image',
          imageUrl: '',
        })
      }
    })

    console.log('[ComfyUI Tool] Starting generation with imageIds:', imageIds)
    // Reset progress state before starting (this is done in imageGenerationPresets.generate() but we're calling comfyUi.generate() directly)
    imageGeneration.currentState = 'no_start'
    imageGeneration.stepText = '' // Empty string will show "Preparing..." in the UI

    // Start generation
    await comfyUi.generate(imageIds, 'imageGen')

    console.log('[ComfyUI Tool] Generation started, waiting for completion')

    // Wait for all images to complete
    const result = await new Promise<ComfyUiToolOutput>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Image generation timed out after 5 minutes'))
      }, 300000) // 5 minute timeout

      const checkCompletion = () => {
        const completedMedia = imageGeneration.generatedImages.filter(
          (item): item is MediaItem =>
            imageIds.includes(item.id) &&
            item.state === 'done' &&
            ((item.type === 'image' && 'imageUrl' in item && !!item.imageUrl) ||
              (item.type === 'video' && 'videoUrl' in item && !!item.videoUrl) ||
              (item.type === 'model3d' && 'model3dUrl' in item && !!item.model3dUrl)),
        )

        if (completedMedia.length >= batchSize) {
          clearTimeout(timeout)
          const results = completedMedia.map((item) => {
            if (item.type === 'image') {
              return {
                id: item.id,
                type: 'image' as const,
                imageUrl: item.imageUrl,
                mode: 'imageGen' as const,
                settings: item.settings || {},
              }
            } else if (item.type === 'video') {
              return {
                id: item.id,
                type: 'video' as const,
                videoUrl: item.videoUrl,
                mode: 'imageGen' as const,
                settings: item.settings || {},
              }
            } else {
              return {
                id: item.id,
                type: 'model3d' as const,
                model3dUrl: item.model3dUrl,
                mode: 'imageGen' as const,
                settings: item.settings || {},
              }
            }
          })
          resolve({ images: results })
        }
      }

      // Check immediately in case images are already done
      checkCompletion()

      // Watch for changes
      const stopWatcher = watch(
        () => imageGeneration.generatedImages,
        () => {
          checkCompletion()
        },
        { deep: true },
      )

      // Clean up watcher on timeout
      setTimeout(() => {
        stopWatcher()
      }, 300000)
    })

    // Restore state after successful completion
    await restoreState()
    console.log('[ComfyUI Tool] Generation completed successfully')
    return result
  } catch (error) {
    console.error('[ComfyUI Tool] Generation error:', error)

    // Reset prompt state on error
    const promptStore = usePromptStore()
    promptStore.promptSubmitted = false

    // Clean up queued images if they exist
    imageIds.forEach((id) => {
      const existingImage = imageGeneration.generatedImages.find((img) => img.id === id)
      if (existingImage && existingImage.state === 'queued') {
        imageGeneration.generatedImages = imageGeneration.generatedImages.filter((img) => img.id !== id)
      }
    })

    // Restore state
    await restoreState()

    // Return error result instead of throwing
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return createErrorResult(`ComfyUI generation failed: ${errorMessage}`)
  }
}

// Tool definition for AI SDK
// Generate the tool description and schema dynamically based on available workflows
function getToolDefinition() {
  const availableWorkflows = getAvailableWorkflows()
  const defaultWorkflow = 'Draft Image'
  const defaultWorkflowWithVariant = 'Draft Image - Fast'

  // Fallback if no workflows are available yet (presets not loaded)
  if (availableWorkflows.length === 0) {
    return {
      description:
        'Use this tool to create, edit, or enhance media content (images, videos, or 3D models) based on text prompts. Only use this tool if the user explicitly asks to create media content.\n\nIMPORTANT: Always generate a detailed, descriptive prompt even if the user provides a simple request. Expand simple requests into full prompts with subject details, composition, style, lighting, colors, mood, and quality tags.\n\nVARIANT SUPPORT: Presets may have variants (e.g., "Fast", "Standard", "Quality"). By default, always prefer "Fast" variants when available as they are least resource intensive. The default preset is "Draft Image" with "Fast" variant. You can optionally specify a variant name if the user requests a specific quality level.',
      inputSchema: z.object({
        workflow: z
          .string()
          .describe(
            `Workflow name to use for generation. Use ${defaultWorkflow} (default, will automatically use "Fast" variant if available, least resource intensive) unless user specifically requests higher quality or different model.`,
          ),
        variant: z
          .string()
          .optional()
          .describe(
            'Optional variant name to use (e.g., "Fast", "Standard", "Quality"). If not specified, "Fast" variant will be used by default when available. Only specify if user explicitly requests a specific quality level.',
          ),
        prompt: z
          .string()
          .describe(
            'Detailed text prompt describing the media to generate. Always expand simple requests into full, descriptive prompts with subject details, composition, style, lighting, colors, mood, and quality tags.',
          ),
        negativePrompt: z.string().optional().describe('Negative prompt for things to avoid'),
        batchSize: z
          .number()
          .describe('Number of images to generate. Use 1 if not explicitly specified by the user.'),
      }),
    }
  }

  // Separate workflows by media type
  const videoWorkflows = availableWorkflows.filter((w) => w.mediaType === 'video')

  // Build workflow description with available options
  const workflowOptions = availableWorkflows
    .map((w) => {
      const mediaTypeStr = w.mediaType ? ` (${w.mediaType})` : ''
      const isDefault = w.name === defaultWorkflow ? ' (default, least resource intensive)' : ''
      return `${w.name}${mediaTypeStr}${isDefault}`
    })
    .join(', ')

  // Collect all unique tool instructions
  const allInstructions = availableWorkflows
    .map((w) => w.toolInstructions)
    .filter((inst): inst is string => !!inst)

  // Base description with prompt generation instructions
  let description =
    'Use this tool to create, edit, or enhance media content (images, videos, or 3D models) based on text prompts. Only use this tool if the user explicitly asks to create media content.\n\n'
  description +=
    'IMPORTANT: Always generate a detailed, descriptive prompt even if the user provides a simple request. Expand simple requests into full prompts with subject details, composition, style, lighting, colors, mood, and quality tags. For example, if the user asks for "an elephant", expand it to something like "a majestic African elephant standing in golden hour sunlight, detailed wrinkles on skin, photorealistic, 8k, highly detailed, professional photography".\n\n'
  description +=
    'VARIANT SUPPORT: Presets may have variants (e.g., "Fast", "Standard", "Quality"). By default, always prefer "Fast" variants when available as they are least resource intensive. The default preset is "Draft Image" with "Fast" variant. The tool will automatically select the "Fast" variant when available. You can optionally specify a variant name in the variant parameter if the user requests a specific quality level.\n\n'

  // Add preset-specific instructions if available
  if (allInstructions.length > 0) {
    description += 'Preset-specific prompt guidelines:\n'
    allInstructions.forEach((inst, idx) => {
      description += `${idx + 1}. ${inst}\n`
    })
    description += '\n'
  }

  description += `Available workflows: ${workflowOptions}.`
  description += `IMPORTANT: You MUST use '${defaultWorkflow}' (which will automatically use the "Fast" variant, equivalent to '${defaultWorkflowWithVariant}') unless the user explicitly requests higher quality, a different model, or a different media type.\n\n`

  // Add explicit warnings for video workflows
  if (videoWorkflows.length > 0) {
    description += `IMPORTANT: Video workflows (${videoWorkflows.map((w) => w.name).join(', ')}) should ONLY be used when the user explicitly requests video generation. Never use video workflows for image requests. Video generation is resource-intensive and should only be used when specifically asked for.`
  }

  // Build workflow enum or string description
  const workflowNames = availableWorkflows.map((w) => w.name)
  const workflowEnum =
    workflowNames.length > 0 ? z.enum(workflowNames as [string, ...string[]]) : z.string()

  let workflowDescription = `Workflow name to use for generation. Available options: ${workflowOptions}. `
  workflowDescription += `Use ${defaultWorkflow} (will automatically use "Fast" variant if available, equivalent to '${defaultWorkflowWithVariant}') unless user specifically requests higher quality or different model. `
  if (videoWorkflows.length > 0) {
    workflowDescription += `IMPORTANT: Only use video workflows (${videoWorkflows.map((w) => w.name).join(', ')}) when the user explicitly asks for video generation. Never use video workflows for image requests.`
  }

  return {
    description,
    inputSchema: z.object({
      workflow: workflowEnum.describe(workflowDescription),
      variant: z
        .string()
        .optional()
        .describe(
          'Optional variant name to use (e.g., "Fast", "Standard", "Quality"). If not specified, "Fast" variant will be used by default when available. Only specify if user explicitly requests a specific quality level.',
        ),
      prompt: z
        .string()
        .describe(
          'Detailed text prompt describing the media to generate. Always expand simple requests into full, descriptive prompts with subject details, composition, style, lighting, colors, mood, and quality tags.',
        ),
      negativePrompt: z.string().optional().describe('Negative prompt for things to avoid'),
      // resolution: z.string().optional().describe('Image resolution (e.g., "512x512", "1024x768")'),
      // inferenceSteps: z.number().optional().describe('Number of inference steps'),
      // seed: z.number().optional().describe('Random seed for reproducibility'),
      batchSize: z
        .number()
        .describe('Number of images to generate. Use 1 if not explicitly specified by the user.'),
    }),
  }
}

// Tool definition for AI SDK
// Use getters so the tool definition is computed when accessed (after presets are loaded)
export const comfyUI = tool({
  get description() {
    return getToolDefinition().description
  },
  get inputSchema() {
    return getToolDefinition().inputSchema
  },
  outputSchema: ComfyUiToolOutputSchema,
  execute: async (args: {
    workflow?: string
    variant?: string
    prompt: string
    negativePrompt?: string
    resolution?: string
    inferenceSteps?: number
    seed?: number
    batchSize?: number
  }) => {
    const result = await executeComfyGeneration(args)
    console.log('### comfyUI.execute', args, result)
    return result
  },
})
