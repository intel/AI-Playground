import { z } from 'zod'
import { watch } from 'vue'
import { useImageGenerationPresets, type MediaItem } from '../store/imageGenerationPresets'
import { useComfyUiPresets } from '../store/comfyUiPresets'
import { useBackendServices } from '../store/backendServices'
import { usePresets, type Preset, type ComfyUiPreset } from '../store/presets'
import { usePresetSwitching } from '../store/presetSwitching'
import { usePromptStore } from '../store/promptArea'
import {
  DEFAULT_RESOLUTION_CONFIG,
  getResolutionsFromConfig,
  getResolutionForConfig,
  findClosestResolutionInConfig,
} from '../store/imageGenerationUtils'
import type { ResolutionConfig, MegapixelOption } from '../store/presets'
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

// Helper function to get a sensible default megapixel tier from resolution config
function getDefaultMegapixelLabel(config: ResolutionConfig): string {
  const labels = config.megapixels.map((m: MegapixelOption) => m.label)
  // Prefer "1.0" if available (HD quality), otherwise pick middle tier
  if (labels.includes('1.0')) return '1.0'
  return labels[Math.floor(labels.length / 2)] ?? '0.5'
}

// Helper function to get available workflows for the tool
export function getAvailableWorkflows(): Array<{
  name: string
  mediaType?: 'image' | 'video' | 'model3d'
  description?: string
  toolInstructions?: string
  resolutions?: Array<{ width: number; height: number; aspectRatio: string; megapixels: string; totalPixels: number }>
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
    .map((preset: Preset) => {
      const comfyPreset = preset as ComfyUiPreset
      const config = comfyPreset.resolutionConfig ?? DEFAULT_RESOLUTION_CONFIG
      const resolutions = getResolutionsFromConfig(config)

      return {
        name: preset.name,
        mediaType: preset.mediaType,
        description: preset.description,
        toolInstructions: preset.toolInstructions,
        resolutions,
      }
    })
}

// Helper function to get resolution examples for tool description
function getResolutionExamplesForWorkflow(workflowName: string): string {
  const workflows = getAvailableWorkflows()
  const workflow = workflows.find((w) => w.name === workflowName)
  if (!workflow?.resolutions || workflow.resolutions.length === 0) {
    return '512x512, 1024x1024'
  }

  // Get unique aspect ratios and pick one example from each major megapixel tier
  const examples: string[] = []
  const seenAspectRatios = new Set<string>()

  // Prioritize common aspect ratios: 1/1 (square), 16/9 (wide), 9/16 (tall)
  const priorityRatios = ['1/1', '16/9', '9/16']

  for (const ratio of priorityRatios) {
    // Find highest MP resolution for this ratio
    const resForRatio = workflow.resolutions
      .filter((r) => r.aspectRatio === ratio)
      .sort((a, b) => b.totalPixels - a.totalPixels)[0]

    if (resForRatio && !seenAspectRatios.has(ratio)) {
      examples.push(`${resForRatio.width}x${resForRatio.height}`)
      seenAspectRatios.add(ratio)
    }
  }

  return examples.slice(0, 5).join(', ')
}

// Helper function to find best resolution for a given aspect ratio and quality preference
function findBestResolutionForAspectRatio(
  workflowName: string,
  aspectRatio: string,
  preferHighRes: boolean = false,
): string | null {
  const workflows = getAvailableWorkflows()
  const workflow = workflows.find((w) => w.name === workflowName)
  if (!workflow?.resolutions) return null

  const matchingResolutions = workflow.resolutions.filter((r) => r.aspectRatio === aspectRatio)
  if (matchingResolutions.length === 0) return null

  // Sort by total pixels and pick highest or middle
  const sorted = [...matchingResolutions].sort((a, b) => b.totalPixels - a.totalPixels)
  const selected = preferHighRes ? sorted[0] : sorted[Math.floor(sorted.length / 2)]

  return `${selected.width}x${selected.height}`
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
  aspectRatio?: string
  megapixels?: string
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

  // Get resolution config from preset
  const comfyPreset = preset as ComfyUiPreset
  const resolutionConfig = comfyPreset.resolutionConfig ?? DEFAULT_RESOLUTION_CONFIG

  // Resolve resolution from args, finding closest valid match
  // Priority: 1. aspectRatio and/or megapixels, 2. resolution WxH, 3. preset default
  let width: number
  let height: number

  if (args.aspectRatio || args.megapixels) {
    // Handle aspectRatio and/or megapixels (fill in defaults for missing values)
    const ar = args.aspectRatio ?? '1/1' // default to square if only MP provided
    const mp = args.megapixels ?? getDefaultMegapixelLabel(resolutionConfig) // pick sensible default if only AR provided

    // Try exact match first
    const exactMatch = getResolutionForConfig(resolutionConfig, mp, ar)
    if (exactMatch) {
      width = exactMatch.width
      height = exactMatch.height
      console.log(`[ComfyUI Tool] Exact resolution match for ${ar} @ ${mp}MP: ${width}x${height}`)
    } else {
      // Find closest by aspect ratio - get all resolutions with matching AR, pick closest by MP
      const allResolutions = getResolutionsFromConfig(resolutionConfig)
      const matchingAR = allResolutions.filter((r) => r.aspectRatio === ar)

      if (matchingAR.length > 0) {
        // Find closest megapixel tier
        const targetMP = parseFloat(mp)
        const closest = matchingAR.reduce((prev, curr) => {
          const prevDiff = Math.abs(parseFloat(prev.megapixels) - targetMP)
          const currDiff = Math.abs(parseFloat(curr.megapixels) - targetMP)
          return currDiff < prevDiff ? curr : prev
        })
        width = closest.width
        height = closest.height
        console.log(
          `[ComfyUI Tool] Closest resolution match for ${ar}: ${width}x${height} (requested ${mp}MP, got ${closest.megapixels}MP)`,
        )
      } else {
        // AR not found, use default
        const defaultResolution = getPresetDefault('resolution') as string | null
        if (defaultResolution) {
          const [dw, dh] = defaultResolution.split('x').map(Number)
          width = dw || imageGeneration.width
          height = dh || imageGeneration.height
        } else {
          width = imageGeneration.width
          height = imageGeneration.height
        }
        console.log(`[ComfyUI Tool] Aspect ratio ${ar} not found, using default: ${width}x${height}`)
      }
    }
  } else if (args.resolution) {
    // Parse resolution WxH and find closest valid match
    const [w, h] = args.resolution.split('x').map(Number)
    if (w && h) {
      // Find closest match from valid resolutions
      const closestMatch = findClosestResolutionInConfig(resolutionConfig, w, h)
      if (closestMatch) {
        width = closestMatch.width
        height = closestMatch.height
        console.log(`[ComfyUI Tool] Closest resolution match for ${args.resolution}: ${width}x${height}`)
      } else {
        width = w
        height = h
        console.log(`[ComfyUI Tool] No close match found, using requested: ${width}x${height}`)
      }
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

  // Get resolution examples for the default workflow
  const defaultResolutionExamples = getResolutionExamplesForWorkflow(defaultWorkflow)
  const highRes16x9 = findBestResolutionForAspectRatio(defaultWorkflow, '16/9', true) || '1376x768'
  const highRes9x16 = findBestResolutionForAspectRatio(defaultWorkflow, '9/16', true) || '768x1376'

  // Fallback if no workflows are available yet (presets not loaded)
  if (availableWorkflows.length === 0) {
    return {
      description:
        'Use this tool to create, edit, or enhance media content (images, videos, or 3D models) based on text prompts. Only use this tool if the user explicitly asks to create media content.\n\n' +
        'IMPORTANT: Always generate a detailed, descriptive prompt even if the user provides a simple request. Expand simple requests into full prompts with subject details, composition, style, lighting, colors, mood, and quality tags.\n\n' +
        'VARIANT SUPPORT: Presets may have variants (e.g., "Fast", "Standard", "Quality"). By default, always prefer "Fast" variants when available as they are least resource intensive.\n\n' +
        'RESOLUTION: Specify image size using EITHER:\n' +
        '  - aspectRatio + megapixels (e.g., aspectRatio="16/9", megapixels="1.0")\n' +
        '  - OR resolution directly (e.g., resolution="1376x768")\n' +
        'Available aspect ratios: 1/1 (square), 16/9 (widescreen), 9/16 (portrait), 3/2, 2/3, 4/3, 3/4, 21/9, 9/21\n' +
        'Available megapixels: 0.25 (small), 0.5 (medium), 0.8, 1.0 (HD), 1.2, 1.5 (high-res)\n\n' +
        'CRITICAL: Do NOT include resolution, aspect ratio, dimensions, or size information in the prompt text itself. These should ONLY be passed as separate parameters (aspectRatio, megapixels, or resolution).',
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
            'Detailed text prompt describing the media to generate. Always expand simple requests into full, descriptive prompts with subject details, composition, style, lighting, colors, mood, and quality tags. Do NOT include resolution or size information in the prompt.',
          ),
        negativePrompt: z.string().optional().describe('Negative prompt for things to avoid'),
        aspectRatio: z
          .string()
          .optional()
          .describe(
            'Aspect ratio for the image. Options: "1/1" (square), "16/9" (widescreen/landscape), "9/16" (portrait/vertical), "3/2", "2/3", "4/3", "3/4", "21/9" (ultra-wide), "9/21". Use with megapixels parameter.',
          ),
        megapixels: z
          .string()
          .optional()
          .describe(
            'Megapixel tier for image quality/size. Options: "0.25" (small), "0.5" (medium), "0.8", "1.0" (HD), "1.2", "1.5" (high-res). Use with aspectRatio parameter. Higher = better quality but slower.',
          ),
        resolution: z
          .string()
          .optional()
          .describe(
            `Direct resolution in WxH format (alternative to aspectRatio+megapixels). Examples: ${defaultResolutionExamples}. The closest valid resolution will be selected.`,
          ),
        seed: z
          .number()
          .optional()
          .describe(
            'Random seed for reproducible generation. Use -1 for random seed. Only specify if user wants to reproduce a specific result.',
          ),
        batchSize: z
          .number()
          .describe('Number of images to generate. Use 1 if not explicitly specified by the user.'),
      }),
    }
  }

  // Separate workflows by media type
  const videoWorkflows = availableWorkflows.filter((w) => w.mediaType === 'video')
  const imageWorkflows = availableWorkflows.filter((w) => w.mediaType === 'image' || !w.mediaType)

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

  // Add resolution guidance
  description += 'RESOLUTION: Specify image size using EITHER:\n'
  description += '  - aspectRatio + megapixels parameters (recommended): e.g., aspectRatio="16/9", megapixels="1.0"\n'
  description += '  - OR resolution parameter directly: e.g., resolution="1376x768"\n\n'
  description += 'Available aspect ratios: 1/1 (square), 16/9 (widescreen/landscape), 9/16 (portrait/vertical), 3/2, 2/3, 4/3, 3/4, 21/9 (ultra-wide), 9/21\n'
  description += 'Available megapixels: 0.25 (small/fast), 0.5 (medium), 0.8, 1.0 (HD), 1.2, 1.5 (high-res/slower)\n\n'
  description += 'When user asks for "high resolution", "HD", or "large" image, use megapixels="1.0" or higher.\n'
  description += 'When user asks for specific aspect ratio (e.g., "16:9", "widescreen", "landscape"), set aspectRatio accordingly.\n\n'
  description += 'CRITICAL: Do NOT include resolution, aspect ratio, dimensions, or size information in the prompt text itself. These should ONLY be passed as separate parameters (aspectRatio, megapixels, or resolution).\n\n'

  // Add preset-specific instructions if available
  if (allInstructions.length > 0) {
    description += 'Preset-specific prompt guidelines:\n'
    allInstructions.forEach((inst, idx) => {
      description += `${idx + 1}. ${inst}\n`
    })
    description += '\n'
  }

  description += `Available workflows: ${workflowOptions}. `
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

  // Build resolution description with examples from available workflows
  const resolutionExamples = imageWorkflows.length > 0
    ? getResolutionExamplesForWorkflow(imageWorkflows[0].name)
    : defaultResolutionExamples

  const resolutionDescription = `Direct resolution in WxH format (alternative to aspectRatio+megapixels). Examples: ${resolutionExamples}. The closest valid resolution will be selected.`

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
          'Detailed text prompt describing the media to generate. Always expand simple requests into full, descriptive prompts with subject details, composition, style, lighting, colors, mood, and quality tags. Do NOT include resolution or size information in the prompt.',
        ),
      negativePrompt: z.string().optional().describe('Negative prompt for things to avoid'),
      aspectRatio: z
        .string()
        .optional()
        .describe(
          'Aspect ratio for the image. Options: "1/1" (square), "16/9" (widescreen/landscape), "9/16" (portrait/vertical), "3/2", "2/3", "4/3", "3/4", "21/9" (ultra-wide), "9/21". Use with megapixels parameter.',
        ),
      megapixels: z
        .string()
        .optional()
        .describe(
          'Megapixel tier for image quality/size. Options: "0.25" (small/fast), "0.5" (medium), "0.8", "1.0" (HD), "1.2", "1.5" (high-res/slower). Use with aspectRatio parameter.',
        ),
      resolution: z
        .string()
        .optional()
        .describe(resolutionDescription),
      seed: z
        .number()
        .optional()
        .describe(
          'Random seed for reproducible generation. Use -1 for random seed. Only specify if user wants to reproduce a specific result.',
        ),
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
    aspectRatio?: string
    megapixels?: string
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
