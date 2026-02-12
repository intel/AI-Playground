import { z } from 'zod'
import { watch } from 'vue'
import { FilePart, ModelMessage, tool } from 'ai'
import { useImageGenerationPresets, type MediaItem } from '../store/imageGenerationPresets'
import { useComfyUiPresets } from '../store/comfyUiPresets'
import { useBackendServices, type BackendServiceName } from '../store/backendServices'
import { usePresets, type Preset } from '../store/presets'
import { usePresetSwitching } from '../store/presetSwitching'
import { usePromptStore } from '../store/promptArea'

const ImageEditOutputSchema = z.object({
  id: z.string(),
  type: z.literal('image'),
  imageUrl: z.string(),
  mode: z.literal('imageEdit'),
  settings: z.record(z.string(), z.unknown()),
})

export const ImageEditToolOutputSchema = z
  .object({
    images: z.array(ImageEditOutputSchema),
    success: z.boolean().optional(),
    message: z.string().optional(),
  })
  .passthrough()

export type ImageEditToolOutput = z.infer<typeof ImageEditToolOutputSchema>

function findLatestUserProvidedImage(messages: ModelMessage[]): FilePart | null {
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

function convertFilePartToDataUrl(data: FilePart['data']): string {
  if (typeof data === 'string' && data.startsWith('data:image/')) {
    return data
  }
  console.error('[ComfyUIImageEdit Tool] Unsupported file part data format:', data)
  throw new Error('Only data URL images are supported')
}

function findLatestGeneratedImage(messages: ModelMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          part.type === 'tool-result' &&
          (part.toolName === 'comfyUI' || part.toolName === 'comfyUiImageEdit')
        ) {
          const image = extractImageGenToolResult(part)
          if (image?.imageUrl) return image.imageUrl
        }
      }
    }
  }
  return null
}

// Helper to extract images from tool result output
// Handles JSON output structure: { type: "json", value: { images: [...] } }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractImageGenToolResult(part: any): { type?: string; imageUrl?: string } | null {
  const result = part.output ?? part.result
  if (!result) return null

  const images = result.type === 'json' ? result.value?.images : null
  if (!images) return null

  return (
    images.find(
      (img: { type?: string; imageUrl?: string }) => img.type === 'image' && img.imageUrl,
    ) ?? null
  )
}

function findSourceImage(messages: ModelMessage[]): string | null {
  const generatedImage = findLatestGeneratedImage(messages)
  if (generatedImage) return generatedImage

  const imagePart = findLatestUserProvidedImage(messages)
  if (!imagePart) return null
  return convertFilePartToDataUrl(imagePart.data)
}

async function convertToDataUri(imageUrl: string): Promise<string> {
  if (imageUrl.startsWith('data:image/')) {
    return imageUrl
  }

  if (imageUrl.startsWith('aipg-media://')) {
    console.log('[ComfyUIImageEdit Tool] Converting to data:image/ URI:', imageUrl)
    const response = await fetch(imageUrl)
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`)
    }
    const blob = await response.blob()
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  throw new Error(`Unsupported image URL format: ${imageUrl}`)
}

export function getAvailableEditWorkflows(): Array<{ name: string; description?: string }> {
  const presets = usePresets()
  return presets.presets
    .filter((p: Preset) => {
      if (!(p.type === 'comfy' && p.backend === 'comfyui')) return false
      if (p.toolCategory !== 'edit-images') return false
      return true
    })
    .map((p: Preset) => ({ name: p.name, description: p.description }))
}

function findFastVariant(preset: Preset): string | null {
  const fast = preset.variants?.find((v) => v.name.toLowerCase().includes('fast'))
  return fast?.name || null
}

function getPresetDefault(preset: Preset, settingName: string): unknown {
  return preset.settings.find((s: { settingName?: string }) => s.settingName === settingName)
    ?.defaultValue
}

// Chat backends to be stopped to free resources for image editing
const chatBackends: BackendServiceName[] = [
  'llamacpp-backend',
  'openvino-backend',
  'ollama-backend',
]

async function stopChatBackend(): Promise<void> {
  console.log('[ComfyUIImageEdit Tool] Stopping chat backend to free resources for image editing')
  const backendServices = useBackendServices()

  // Stop any running chat backends to free up memory/resources
  for (const serviceName of chatBackends) {
    const backend = backendServices.info.find((s) => s.serviceName === serviceName)
    console.log(`[ComfyUIImageEdit Tool] Checking backend "${serviceName}":`, backend)
    try {
      console.log(`[ComfyUIImageEdit Tool]  Backend: ${serviceName}, status: ${backend?.status}`)
      console.log(`[ComfyUIImageEdit Tool] Stopping ${serviceName}...`)
      await backendServices.stopService(serviceName)
    } catch (error) {
      console.warn(`[ComfyUIImageEdit Tool] Failed to stop ${serviceName}:`, error)
    }
  }
}

type ImageEditArgs = {
  workflow?: string
  variant?: string
  prompt: string
  negativePrompt?: string
  seed?: number
}

const createErrorResult = (message: string): ImageEditToolOutput => ({
  success: false,
  message,
  images: [],
})

function saveCurrentState(
  imageGeneration: ReturnType<typeof useImageGenerationPresets>,
  presets: ReturnType<typeof usePresets>,
) {
  const originalState = {
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

  const restoreState = async () => {
    Object.assign(imageGeneration, {
      prompt: originalState.prompt,
      negativePrompt: originalState.negativePrompt,
      inferenceSteps: originalState.inferenceSteps,
      width: originalState.width,
      height: originalState.height,
      seed: originalState.seed,
      batchSize: originalState.batchSize,
    })
    if (originalState.presetName) {
      await usePresetSwitching().switchPreset(originalState.presetName, {
        variant: originalState.variant ?? undefined,
        skipModeSwitch: true,
        skipLastUsedUpdate: true,
      })
    }
  }

  return restoreState
}

export async function executeImageEdit(
  args: ImageEditArgs,
  messages: ModelMessage[],
): Promise<ImageEditToolOutput> {
  console.log('[ComfyUIImageEdit Tool] Starting generation with args:', args)

  // avoid network issues from killing the chat BE while tool call is still streaming
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  await delay(100)

  await stopChatBackend()

  const imageGeneration = useImageGenerationPresets()
  const comfyUi = useComfyUiPresets()
  const backendServices = useBackendServices()
  const presets = usePresets()

  const sourceImageUrl = findSourceImage(messages)
  if (!sourceImageUrl) {
    return createErrorResult(
      'No image found in conversation. Please upload an image or generate one first.',
    )
  }
  console.log('[ComfyUIImageEdit Tool] Found source image URL:', sourceImageUrl)

  const comfyUiService = backendServices.info.find((s) => s.serviceName === 'comfyui-backend')
  if (!comfyUiService || comfyUiService.status !== 'running') {
    return createErrorResult('ComfyUI backend is not running. Please start it first.')
  }

  const requestedWorkflow = args.workflow || 'Edit By Prompt'
  let preset: Preset | null =
    presets.presets.find((p) => p.name === requestedWorkflow && p.toolCategory === 'edit-images') ||
    presets.presets.find((p) => p.type === 'comfy' && p.toolCategory === 'edit-images') ||
    null

  if (!preset || preset.type !== 'comfy') {
    return createErrorResult('No image edit presets available')
  }

  let selectedVariant: string | null = null
  if (preset.variants?.length) {
    selectedVariant =
      (args.variant && preset.variants.some((v) => v.name === args.variant)
        ? args.variant
        : null) ||
      findFastVariant(preset) ||
      preset.variants[0].name
  }
  console.log(
    `[ComfyUIImageEdit Tool] Using preset "${preset.name}" with variant "${selectedVariant}"`,
  )

  if (selectedVariant) presets.setActiveVariant(preset.name, selectedVariant)
  const presetWithVariant = presets.getPresetWithVariant(preset.name)
  if (!presetWithVariant) {
    return createErrorResult(`Failed to apply preset "${preset.name}"`)
  }
  preset = presetWithVariant

  const imageId = crypto.randomUUID()

  const restoreState = saveCurrentState(imageGeneration, presets)

  try {
    const switchResult = await usePresetSwitching().switchPreset(preset.name, {
      variant: selectedVariant ?? undefined,
      skipModeSwitch: true,
      skipLastUsedUpdate: true,
    })
    if (!switchResult.success) {
      return createErrorResult(`Failed to switch to preset "${preset.name}"`)
    }

    await imageGeneration.ensureModelsAreAvailable()

    imageGeneration.prompt = args.prompt
    imageGeneration.negativePrompt =
      args.negativePrompt ?? (getPresetDefault(preset, 'negativePrompt') as string) ?? ''
    imageGeneration.inferenceSteps = (getPresetDefault(preset, 'inferenceSteps') as number) ?? 20
    imageGeneration.seed = args.seed ?? (getPresetDefault(preset, 'seed') as number) ?? -1
    imageGeneration.batchSize = 1

    // Set the source image into the appropriate comfyInput
    // Find the first image input that doesn't have a default value (required input)
    console.log(
      '[ComfyUIImageEdit Tool] Available comfyInputs:',
      imageGeneration.comfyInputs.map((input) => ({
        label: input.label,
        type: input.type,
        displayed: input.displayed,
        modifiable: input.modifiable,
        defaultValue: input.defaultValue,
        currentValue: input.current.value,
      })),
    )

    const imageInput = imageGeneration.comfyInputs.find(
      (input) =>
        (input.type === 'image' || input.type === 'inpaintMask') &&
        input.displayed !== false &&
        input.modifiable !== false &&
        (input.defaultValue === '' || input.defaultValue === undefined),
    )

    console.log('[ComfyUIImageEdit Tool] Found image input:', imageInput)

    if (!imageInput) {
      return createErrorResult('No suitable image input found in the preset')
    }

    try {
      const dataUri = await convertToDataUri(sourceImageUrl)
      imageInput.current.value = dataUri
    } catch (error) {
      return createErrorResult(
        `Failed to convert source image: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }

    imageGeneration.currentState = 'no_start'
    imageGeneration.stepText = ''

    await comfyUi.generate([imageId], 'imageEdit', sourceImageUrl)

    const result = await new Promise<ImageEditToolOutput>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Image edit timed out after 5 minutes')),
        300000,
      )

      const checkCompletion = () => {
        const completed = imageGeneration.generatedImages.find(
          (item): item is MediaItem =>
            item.id === imageId &&
            item.state === 'done' &&
            item.type === 'image' &&
            'imageUrl' in item &&
            !!item.imageUrl,
        )
        if (completed) {
          clearTimeout(timeout)
          resolve({
            images: [
              {
                id: completed.id,
                type: 'image' as const,
                imageUrl: (completed as { imageUrl: string }).imageUrl,
                mode: 'imageEdit' as const,
                settings: completed.settings || {},
              },
            ],
          })
        }
      }

      checkCompletion()
      const stopWatcher = watch(() => imageGeneration.generatedImages, checkCompletion, {
        deep: true,
      })
      setTimeout(() => stopWatcher(), 300000)
    })

    return result
  } catch (error) {
    usePromptStore().promptSubmitted = false
    const img = imageGeneration.generatedImages.find((i) => i.id === imageId)
    if (img?.state === 'queued') {
      imageGeneration.generatedImages = imageGeneration.generatedImages.filter(
        (i) => i.id !== imageId,
      )
    }
    return createErrorResult(
      `Image edit failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  } finally {
    await restoreState()
    await comfyUi.free()
  }
}

function getToolDefinition() {
  const workflows = getAvailableEditWorkflows()
  const defaultWorkflow = 'Edit By Prompt'
  const workflowOptions = workflows
    .map((w) => w.name + (w.name === defaultWorkflow ? ' (default)' : ''))
    .join(', ')

  const baseDescription =
    'Use this tool to edit or modify an existing image from the conversation based on a text prompt. ' +
    'This tool takes the most recent image from the conversation (uploaded or generated) and applies edits.\n\n' +
    'IMPORTANT: This tool requires an image to already exist in the conversation.'

  const description =
    workflows.length > 0
      ? `${baseDescription}\n\nAvailable edit workflows: ${workflowOptions}`
      : baseDescription

  const workflowSchema =
    workflows.length > 0
      ? z
          .enum(workflows.map((w) => w.name) as [string, ...string[]])
          .optional()
          .describe(`Edit workflow. Available: ${workflowOptions}. Default: ${defaultWorkflow}`)
      : z.string().optional().describe(`Edit workflow to use. Default: ${defaultWorkflow}`)

  return {
    description,
    inputSchema: z.object({
      workflow: workflowSchema,
      variant: z
        .string()
        .optional()
        .describe('Optional variant name (e.g., "Fast", "Standard", "Quality").'),
      prompt: z.string().describe('Description of the edit to apply to the image.'),
      negativePrompt: z.string().optional().describe('Things to avoid in the edit'),
      seed: z
        .number()
        .optional()
        .describe(
          'Random seed for reproducible generation. Use -1 for random seed. Only specify if user wants to reproduce a specific result.',
        ),
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
  outputSchema: ImageEditToolOutputSchema,
  execute: async (args: ImageEditArgs, { messages }: { messages: ModelMessage[] }) => {
    return await executeImageEdit(args, messages)
  },
})
