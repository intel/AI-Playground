import { z } from 'zod'
import { tool } from 'ai'
import { usePresets, type Preset, type ComfyUiPreset } from '../store/presets'
import { DEFAULT_RESOLUTION_CONFIG, getResolutionsFromConfig } from '../store/imageGenerationUtils'
import type { FilePart, ModelMessage } from 'ai'
import { useImageGenerationPresets } from '../store/imageGenerationPresets'
import { usePresetSwitching } from '../store/presetSwitching'
import { watch } from 'vue'

function findLatestGeneratedImage(messages: ModelMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          part.type === 'tool-result' &&
          (part.toolName === 'comfyUI' || part.toolName === 'imageEdit')
        ) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const partAny = part as any
          const result = partAny.output ?? partAny.result
          if (result?.images?.length) {
            const image = result.images.find(
              (img: { type?: string; imageUrl?: string }) => img.type === 'image' && img.imageUrl,
            )
            if (image?.imageUrl) return image.imageUrl
          }
        }
      }
    }
  }
  return null
}

function findLatestImageInMessages(messages: ModelMessage[]): FilePart | null {
  return (
    messages
      .filter((msg) => Array.isArray(msg.content))
      .flatMap((msg) => msg.content as Array<{ type: string; mediaType?: string }>)
      .findLast(
        (part): part is FilePart =>
          part.type === 'file' && part.mediaType?.startsWith('image/') === true,
      ) || null
  )
}

async function convertFilePartDataToUrl(data: FilePart['data']): Promise<string> {
  if (typeof data === 'string' && data.startsWith('data:image/')) {
    return data
  }
  throw new Error('Only data URL images are supported')
}

// Helper function to get available workflows for the tool
function getAvailableWorkflows(): Array<{
  name: string
  mediaType?: 'image' | 'video' | 'model3d'
  description?: string
  toolInstructions?: string
  resolutions?: Array<{
    width: number
    height: number
    aspectRatio: string
    megapixels: string
    totalPixels: number
  }>
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

export const ComfyUiImageEditToolOutputSchema = z
  .object({
    images: z.array(MediaOutputSchema),
    // Optional fields for error handling
    success: z.boolean().optional(),
    message: z.string().optional(),
  })
  .passthrough()

export type ComfyUiImageEditToolOutput = z.infer<typeof ComfyUiImageEditToolOutputSchema>

export async function executeComfyUiImageEdit(
  args: {
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
  },
  messages?: ModelMessage[],
): Promise<ComfyUiImageEditToolOutput> {
  const createErrorResult = (message: string): ComfyUiImageEditToolOutput => ({ success: false, message, images: [] })
  const original = getCurrentImageEditState()
  // 1. Prepare and validate input
  const { sourceImageUrl, error } = await prepareImageEditInput(args, messages)
  if (error) {
    return createErrorResult(error)
  }
  // 2. Trigger workflow
  const { imageIds, triggerError } = await triggerImageEditWorkflow({ ...args, sourceImageUrl })
  if (triggerError) {
    await restoreImageEditState(original)
    return createErrorResult(triggerError)
  }
  // 3. Track completion
  const result = await waitForImageEditCompletion(imageIds)
  // 4. Handle errors/timeouts
  if (!result.success) {
    await restoreImageEditState(original)
    return result
  }
  // 5. Restore state if needed
  await restoreImageEditState(original)
  return result
}

// --- Async workflow helpers ---

async function prepareImageEditInput(
  _args: Record<string, unknown>,
  messages?: ModelMessage[],
): Promise<{ sourceImageUrl: string | null; error?: string }> {
  let sourceImageUrl: string | null = null
  if (messages) {
    sourceImageUrl = findLatestGeneratedImage(messages)
    if (!sourceImageUrl) {
      const imagePart = findLatestImageInMessages(messages)
      if (imagePart?.data) {
        try {
          sourceImageUrl = await convertFilePartDataToUrl(imagePart.data)
        } catch (_err) {
          return { sourceImageUrl: null, error: 'No image found in the conversation. Please upload an image or generate one first.' }
        }
      }
    }
    if (!sourceImageUrl) {
      return { sourceImageUrl: null, error: 'No image found in the conversation. Please upload an image or generate one first.' }
    }
  }
  return { sourceImageUrl }
}

async function triggerImageEditWorkflow(
  params: Record<string, unknown>,
): Promise<{ imageIds: string[]; triggerError?: string }> {
  try {
    const imageGeneration = useImageGenerationPresets()
    // Use batchSize or default to 1
    const batchSize = typeof params.batchSize === 'number' ? params.batchSize : 1
    const imageIds: string[] = Array.from({ length: batchSize }, () => crypto.randomUUID())
    // Set up the workflow parameters
    // (Assume prompt, negativePrompt, inferenceSteps, seed, etc. are set by caller)
    // Trigger the workflow
    await imageGeneration.generate('imageEdit', params.sourceImageUrl as string)
    return { imageIds }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to trigger workflow.'
    return { imageIds: [], triggerError: errorMsg }
  }
}

async function waitForImageEditCompletion(imageIds: string[], timeoutMs = 60000): Promise<ComfyUiImageEditToolOutput> {
  const imageGeneration = useImageGenerationPresets()
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      stopWatcher()
      resolve({
        success: false,
        message: 'Timeout waiting for image edit result.',
        images: [],
      })
    }, timeoutMs)

    function checkCompletion() {
      const completed = imageGeneration.generatedImages.filter(
        (item) =>
          imageIds.includes(item.id) &&
          item.state === 'done' &&
          item.type === 'image' &&
          'imageUrl' in item &&
          !!(item as { imageUrl: string }).imageUrl,
      )
      if (completed.length >= imageIds.length) {
        clearTimeout(timeout)
        stopWatcher()
        resolve({
          success: true,
          images: completed.map((item) => ({
            id: item.id,
            type: 'image' as const,
            imageUrl: (item as { imageUrl: string }).imageUrl,
            mode: 'imageGen' as const,
            settings: item.settings || {},
          })),
        })
      }
    }

    checkCompletion()
    const stopWatcher = watch(
      () => imageGeneration.generatedImages.map((img) => img.state),
      checkCompletion,
      { deep: true },
    )
  })
}

interface ImageEditOriginalState {
  prompt: string
  negativePrompt: string
  inferenceSteps: number
  width: number
  height: number
  seed: number
  batchSize: number
  presetName: string | null
  variant: string | null
}

function getCurrentImageEditState(): ImageEditOriginalState {
  const imageGeneration = useImageGenerationPresets()
  const presets = usePresets()
  return {
    prompt: imageGeneration.prompt,
    negativePrompt: imageGeneration.negativePrompt,
    inferenceSteps: imageGeneration.inferenceSteps,
    width: imageGeneration.width,
    height: imageGeneration.height,
    seed: imageGeneration.seed,
    batchSize: imageGeneration.batchSize,
    presetName: presets.activePresetName,
    variant: presets.activePresetName ? presets.activeVariantName[presets.activePresetName] : null,
  }
}

async function restoreImageEditState(original: ImageEditOriginalState): Promise<void> {
  const imageGeneration = useImageGenerationPresets()
  imageGeneration.prompt = original.prompt
  imageGeneration.negativePrompt = original.negativePrompt
  imageGeneration.inferenceSteps = original.inferenceSteps
  imageGeneration.width = original.width
  imageGeneration.height = original.height
  imageGeneration.seed = original.seed
  imageGeneration.batchSize = original.batchSize
  if (original.presetName) {
    const presetSwitching = usePresetSwitching()
    await presetSwitching.switchPreset(original.presetName, {
      variant: original.variant ?? undefined,
      skipModeSwitch: true,
      skipLastUsedUpdate: true,
    })
  }
}

function getToolDefinition() {
  const availableWorkflows = getAvailableWorkflows()
  const defaultWorkflow = 'Draft Image'
  const defaultWorkflowWithVariant = 'Draft Image - Fast'

  // Get resolution examples for the default workflow
  const defaultResolutionExamples = getResolutionExamplesForWorkflow(defaultWorkflow)

  // Fallback if no workflows are available yet (presets not loaded)
  if (availableWorkflows.length === 0) {
    return {
      description:
        'Use this tool to edit or enhance images based on text prompts. Only use this tool if the user explicitly asks to edit or modify an image.\n\n' +
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
            `Workflow name to use for editing. Use ${defaultWorkflow} (default, will automatically use "Fast" variant if available, least resource intensive) unless user specifically requests higher quality or different model.`,
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
            'Detailed text prompt describing the edit to apply. Always expand simple requests into full, descriptive prompts with subject details, composition, style, lighting, colors, mood, and quality tags. Do NOT include resolution or size information in the prompt.',
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
            'Random seed for reproducible editing. Use -1 for random seed. Only specify if user wants to reproduce a specific result.',
          ),
        batchSize: z
          .number()
          .describe('Number of images to edit. Use 1 if not explicitly specified by the user.'),
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
    'Use this tool to edit or enhance images based on text prompts. Only use this tool if the user explicitly asks to edit or modify an image.\n\n'
  description +=
    'IMPORTANT: Always generate a detailed, descriptive prompt even if the user provides a simple request. Expand simple requests into full prompts with subject details, composition, style, lighting, colors, mood, and quality tags.\n\n'
  description +=
    'VARIANT SUPPORT: Presets may have variants (e.g., "Fast", "Standard", "Quality"). By default, always prefer "Fast" variants when available as they are least resource intensive. The default preset is "Draft Image" with "Fast" variant. The tool will automatically select the "Fast" variant when available. You can optionally specify a variant name in the variant parameter if the user requests a specific quality level.\n\n'

  // Add resolution guidance
  description += 'RESOLUTION: Specify image size using EITHER:\n'
  description +=
    '  - aspectRatio + megapixels parameters (recommended): e.g., aspectRatio="16/9", megapixels="1.0"\n'
  description += '  - OR resolution parameter directly: e.g., resolution="1376x768"\n\n'
  description +=
    'Available aspect ratios: 1/1 (square), 16/9 (widescreen/landscape), 9/16 (portrait/vertical), 3/2, 2/3, 4/3, 3/4, 21/9 (ultra-wide), 9/21\n'
  description +=
    'Available megapixels: 0.25 (small/fast), 0.5 (medium), 0.8, 1.0 (HD), 1.2, 1.5 (high-res/slower)\n\n'
  description +=
    'When user asks for "high resolution", "HD", or "large" image, use megapixels="1.0" or higher.\n'
  description +=
    'When user asks for specific aspect ratio (e.g., "16:9", "widescreen", "landscape"), set aspectRatio accordingly.\n\n'
  description +=
    'CRITICAL: Do NOT include resolution, aspect ratio, dimensions, or size information in the prompt text itself. These should ONLY be passed as separate parameters (aspectRatio, megapixels, or resolution).\n\n'

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
    description += `IMPORTANT: Video workflows (${videoWorkflows.map((w) => w.name).join(', ')}) should ONLY be used when the user explicitly requests video generation. Never use video workflows for image editing. Video generation is resource-intensive and should only be used when specifically asked for.`
  }

  // Build workflow enum or string description
  const workflowNames = availableWorkflows.map((w) => w.name)
  const workflowEnum =
    workflowNames.length > 0 ? z.enum(workflowNames as [string, ...string[]]) : z.string()

  let workflowDescription = `Workflow name to use for editing. Available options: ${workflowOptions}. `
  workflowDescription += `Use ${defaultWorkflow} (will automatically use "Fast" variant if available, equivalent to '${defaultWorkflowWithVariant}') unless user specifically requests higher quality or different model. `
  if (videoWorkflows.length > 0) {
    workflowDescription += `IMPORTANT: Only use video workflows (${videoWorkflows.map((w) => w.name).join(', ')}) when the user explicitly asks for video generation. Never use video workflows for image editing.`
  }

  // Build resolution description with examples from available workflows
  const resolutionExamples =
    imageWorkflows.length > 0
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
          'Detailed text prompt describing the edit to apply. Always expand simple requests into full, descriptive prompts with subject details, composition, style, lighting, colors, mood, and quality tags. Do NOT include resolution or size information in the prompt.',
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
      resolution: z.string().optional().describe(resolutionDescription),
      seed: z
        .number()
        .optional()
        .describe(
          'Random seed for reproducible editing. Use -1 for random seed. Only specify if user wants to reproduce a specific result.',
        ),
      batchSize: z
        .number()
        .describe('Number of images to edit. Use 1 if not explicitly specified by the user.'),
    }),
  }
}

export const comfyUiImageEdit = tool({
  get description() {
    return getToolDefinition().description
  },
  get inputSchema() {
    return getToolDefinition().inputSchema
  },
  outputSchema: ComfyUiImageEditToolOutputSchema,
  execute: async (
    args: {
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
    },
    { messages }: { messages: ModelMessage[] },
  ) => {
    const result = await executeComfyUiImageEdit(args, messages)
    console.log('### comfyUiImageEdit.execute', args, result)
    return result
  },
  toModelOutput: () => {
    return {
      type: 'text',
      value: 'Image edit completed and visualized in chat.'
    }
  },
})
