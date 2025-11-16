import { z } from 'zod'
import { watch } from 'vue'
import { useImageGenerationPresets } from '../store/imageGenerationPresets'
import { useComfyUiPresets } from '../store/comfyUiPresets'
import { useBackendServices } from '../store/backendServices'
import { usePresets } from '../store/presets'

// Global defaults as fallback (matching imageGenerationPresets.ts)
const globalDefaultSettings = {
  seed: -1,
  width: 512,
  height: 512,
  inferenceSteps: 6,
  resolution: '704x384',
  batchSize: 4,
  negativePrompt: 'nsfw',
  imageModel: 'Lykon/dreamshaper-8',
  inpaintModel: 'Lykon/dreamshaper-8-inpainting',
  guidanceScale: 7,
  lora: 'None',
  scheduler: 'DPM++ SDE Karras',
}

// Helper function to execute ComfyUI generation for tool calls
export async function executeComfyGeneration(args: {
  workflow?: string
  prompt: string
  negativePrompt?: string
  resolution?: string
  inferenceSteps?: number
  seed?: number
  batchSize?: number
}): Promise<{ images: Array<{ id: string; imageUrl: string; mode: 'imageGen'; settings: Record<string, unknown> }> }> {
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
  const getPresetDefault = (settingName: string): any => {
    console.log('### getPresetDefault', {settingName, preset})
    if (!preset) return null
    const setting = preset.settings.find(
      (s) => 'settingName' in s && s.settingName === settingName,
    )
    console.log('### getPresetDefault', {settingName, preset, setting})
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
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    // Set temporary values, using preset defaults when tool args don't provide values
    // Always use preset defaults, not saved values
    imageGeneration.prompt = args.prompt
    imageGeneration.negativePrompt = args.negativePrompt ?? (getPresetDefault('negativePrompt') as string | null) ?? globalDefaultSettings.negativePrompt
    imageGeneration.inferenceSteps = args.inferenceSteps ?? (getPresetDefault('inferenceSteps') as number | null) ?? globalDefaultSettings.inferenceSteps
    imageGeneration.width = width
    imageGeneration.height = height
    imageGeneration.seed = args.seed ?? (getPresetDefault('seed') as number | null) ?? globalDefaultSettings.seed
    imageGeneration.batchSize = batchSize

    // Create images in queued state
    imageIds.forEach((imageId) => {
      imageGeneration.updateImage({
        id: imageId,
        mode: 'imageGen',
        state: 'queued',
        settings: {},
        imageUrl: '',
      })
    })

    // Start generation
    await comfyUi.generate(imageIds, 'imageGen')

    // Wait for all images to complete
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Image generation timed out after 5 minutes'))
      }, 300000) // 5 minute timeout

      const checkCompletion = () => {
        const completedImages = imageGeneration.generatedImages.filter(
          (img) => imageIds.includes(img.id) && img.state === 'done' && img.imageUrl
        )
        
        if (completedImages.length >= batchSize) {
          clearTimeout(timeout)
          const results = completedImages.map((img) => ({
            id: img.id,
            imageUrl: img.imageUrl,
            mode: 'imageGen' as const,
            settings: img.settings || {},
          }))
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
        { deep: true }
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
export const useComfyTool = {
  description: 'Use this tool to create, edit, or enhance images based on text prompts. Only use this tool if the user explicitly asks to create media content like images, videos, or 3D models.',
  inputSchema: z.object({
    workflow: z.string().describe('Workflow name or ID to use for generation. Always use exactly `SD1.5`'),
    prompt: z.string().describe('Text prompt describing the image to generate'),
    negativePrompt: z.string().optional().describe('Negative prompt for things to avoid'),
    // resolution: z.string().optional().describe('Image resolution (e.g., "512x512", "1024x768")'),
    // inferenceSteps: z.number().optional().describe('Number of inference steps'),
    // seed: z.number().optional().describe('Random seed for reproducibility'),
    batchSize: z.number().describe('Number of images to generate. Use 1 if not explicitly specified by the user.'),
  }),
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
}

