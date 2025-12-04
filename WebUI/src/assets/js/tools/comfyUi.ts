import { z } from 'zod'
import { watch } from 'vue'
import { useImageGenerationPresets, type MediaItem } from '../store/imageGenerationPresets'
import { useComfyUiPresets } from '../store/comfyUiPresets'
import { useBackendServices } from '../store/backendServices'
import { usePresets, type Preset } from '../store/presets'
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
  })
  .passthrough()

export type ComfyUiToolOutput = z.infer<typeof ComfyUiToolOutputSchema>

// Helper function to execute ComfyUI generation for tool calls
export async function executeComfyGeneration(args: {
  workflow?: string
  prompt: string
  negativePrompt?: string
  resolution?: string
  inferenceSteps?: number
  seed?: number
  batchSize?: number
}): Promise<ComfyUiToolOutput> {
  const imageGeneration = useImageGenerationPresets()
  const comfyUi = useComfyUiPresets()
  const backendServices = useBackendServices()
  const presets = usePresets()

  // Ensure ComfyUI backend is running
  const comfyUiService = backendServices.info.find((item) => item.serviceName === 'comfyui-backend')
  if (!comfyUiService || comfyUiService.status !== 'running') {
    throw new Error('ComfyUI backend is not running. Please start it first.')
  }

  // Find preset by name
  let preset = null
  if (args.workflow) {
    preset = presets.presets.find((p) => p.name === args.workflow)
    if (!preset) {
      throw new Error(`Preset "${args.workflow}" not found`)
    }
    if (preset.backend !== 'comfyui' || preset.type !== 'comfy') {
      throw new Error(`Preset "${args.workflow}" is not a ComfyUI preset`)
    }
  } else {
    throw new Error('Workflow name is required')
  }

  // Helper function to get default value from preset settings
  const getPresetDefault = (settingName: string): unknown => {
    console.log('### getPresetDefault', { settingName, preset })
    if (!preset) return null
    const setting = preset.settings.find((s) => 'settingName' in s && s.settingName === settingName)
    console.log('### getPresetDefault', { settingName, preset, setting })
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

  try {
    // Set the active preset first
    if (args.workflow) {
      presets.activePresetName = args.workflow
      // Wait for preset to be loaded and settings to be applied
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

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

    // Start generation
    await comfyUi.generate(imageIds, 'imageGen')

    // Wait for all images to complete
    return new Promise((resolve, reject) => {
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
  } finally {
    // Restore original values
    imageGeneration.prompt = originalPrompt
    imageGeneration.negativePrompt = originalNegativePrompt
    imageGeneration.inferenceSteps = originalInferenceSteps
    imageGeneration.width = originalWidth
    imageGeneration.height = originalHeight
    imageGeneration.seed = originalSeed
    imageGeneration.batchSize = originalBatchSize
    presets.activePresetName = originalActivePresetName
  }
}

// Tool definition for AI SDK
// Generate the tool description and schema dynamically based on available workflows
function getToolDefinition() {
  const availableWorkflows = getAvailableWorkflows()
  const defaultWorkflow = 'Draft Image'

  // Fallback if no workflows are available yet (presets not loaded)
  if (availableWorkflows.length === 0) {
    return {
      description:
        'Use this tool to create, edit, or enhance media content (images, videos, or 3D models) based on text prompts. Only use this tool if the user explicitly asks to create media content.\n\nIMPORTANT: Always generate a detailed, descriptive prompt even if the user provides a simple request. Expand simple requests into full prompts with subject details, composition, style, lighting, colors, mood, and quality tags.',
      inputSchema: z.object({
        workflow: z
          .string()
          .describe(
            `Workflow name to use for generation. Use ${defaultWorkflow} (default, least resource intensive) unless user specifically requests higher quality or different model.`,
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

  // Add preset-specific instructions if available
  if (allInstructions.length > 0) {
    description += 'Preset-specific prompt guidelines:\n'
    allInstructions.forEach((inst, idx) => {
      description += `${idx + 1}. ${inst}\n`
    })
    description += '\n'
  }

  description += `Available workflows: ${workflowOptions}. Use ${defaultWorkflow} unless the user specifically requests higher quality, a different model, or a different media type.\n\n`

  // Add explicit warnings for video workflows
  if (videoWorkflows.length > 0) {
    description += `CRITICAL: Video workflows (${videoWorkflows.map((w) => w.name).join(', ')}) should ONLY be used when the user explicitly requests video generation. Never use video workflows for image requests. Video generation is resource-intensive and should only be used when specifically asked for.`
  }

  // Build workflow enum or string description
  const workflowNames = availableWorkflows.map((w) => w.name)
  const workflowEnum =
    workflowNames.length > 0 ? z.enum(workflowNames as [string, ...string[]]) : z.string()

  let workflowDescription = `Workflow name to use for generation. Available options: ${workflowOptions}. `
  workflowDescription += `Use ${defaultWorkflow} unless user specifically requests higher quality or different model. `
  if (videoWorkflows.length > 0) {
    workflowDescription += `IMPORTANT: Only use video workflows (${videoWorkflows.map((w) => w.name).join(', ')}) when the user explicitly asks for video generation. Never use video workflows for image requests.`
  }

  return {
    description,
    inputSchema: z.object({
      workflow: workflowEnum.describe(workflowDescription),
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
    prompt: string
    negativePrompt?: string
    resolution?: string
    inferenceSteps?: number
    seed?: number
    batchSize?: number
  }) => {
    return await executeComfyGeneration(args)
  },
})
