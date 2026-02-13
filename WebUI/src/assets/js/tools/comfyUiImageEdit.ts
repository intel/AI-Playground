import { z } from 'zod'
import { watch } from 'vue'
import { FilePart, ModelMessage, tool } from 'ai'
import { useImageGenerationPresets, type MediaItem } from '../store/imageGenerationPresets'
import { useComfyUiPresets } from '../store/comfyUiPresets'
import { useBackendServices, type BackendServiceName } from '../store/backendServices'
import { usePresets, type Preset } from '../store/presets'
import { usePresetSwitching } from '../store/presetSwitching'
import { usePromptStore } from '../store/promptArea'
import { useDeveloperSettings } from '../store/developerSettings'

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

function convertFilePartToDataUrl(data: FilePart['data']): string {
  if (typeof data === 'string' && data.startsWith('data:image/')) {
    return data
  }
  console.error('[ComfyUIImageEdit Tool] Unsupported file part data format:', data)
  throw new Error('Only data URL images are supported')
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

// Check if the user dragged/attached an image into the current prompt (last user message).
// This takes priority over any other image in the conversation.
function findImageInCurrentPrompt(messages: ModelMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue

    const imagePart = (msg.content as Array<{ type: string; mediaType?: string }>).findLast(
      (part): part is FilePart =>
        part.type === 'file' && part.mediaType?.startsWith('image/') === true,
    )
    if (imagePart) {
      console.log('[ComfyUIImageEdit Tool] Found image in current user prompt')
      return convertFilePartToDataUrl(imagePart.data)
    }
    // Found the last user message but it has no image - stop looking
    break
  }
  return null
}

// Walk backwards through conversation to find the most recent image regardless of source.
// Checks each message for either a generated image (tool result) or an uploaded image (user file),
// returning whichever appears latest in the conversation.
function findLatestImageInConversation(messages: ModelMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!Array.isArray(msg.content)) continue

    // Check tool result messages for generated images
    if (msg.role === 'tool') {
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

    // Check user messages for uploaded images
    if (msg.role === 'user') {
      const imagePart = (msg.content as Array<{ type: string; mediaType?: string }>).findLast(
        (part): part is FilePart =>
          part.type === 'file' && part.mediaType?.startsWith('image/') === true,
      )
      if (imagePart) return convertFilePartToDataUrl(imagePart.data)
    }
  }
  return null
}

// Image selection priority:
// 1. Image dragged into the current prompt (explicit user intent)
// 2. Most recent image in conversation by message position (generated or uploaded)
function findSourceImage(messages: ModelMessage[]): string | null {
  return findImageInCurrentPrompt(messages) ?? findLatestImageInConversation(messages)
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

export function getAvailableEditWorkflows(): Array<{
  name: string
  description?: string
  toolInstructions?: string
}> {
  const presets = usePresets()
  return presets.presets
    .filter((p: Preset) => {
      if (!(p.type === 'comfy' && p.backend === 'comfyui')) return false
      if (p.toolCategory !== 'edit-images') return false
      return true
    })
    .map((p: Preset) => ({
      name: p.name,
      description: p.description,
      toolInstructions: p.toolInstructions,
    }))
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
  workflow: string
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

  if (!useDeveloperSettings().keepModelsLoaded) {
    await stopChatBackend()
  }

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

  const requestedWorkflow = args.workflow
  let preset: Preset | null =
    presets.presets.find((p) => p.name === requestedWorkflow && p.toolCategory === 'edit-images') ||
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
    if (!useDeveloperSettings().keepModelsLoaded) {
      await comfyUi.free()
    }
  }
}

function getToolDefinition() {
  const workflows = getAvailableEditWorkflows()
  const defaultWorkflow = 'Edit By Prompt'
  const workflowOptions = workflows
    .map((w) => w.name + (w.name === defaultWorkflow ? ' (default)' : ''))
    .join(', ')

  let description =
    'Use this tool to edit or modify an existing image from the conversation based on a text prompt. ' +
    'This tool takes the most recent image from the conversation (uploaded or generated) and applies edits.\n\n' +
    'IMPORTANT: This tool requires an image to already exist in the conversation.\n\n' +
    'VARIANT SUPPORT: Presets may have variants (e.g., "Fast", "Standard", "Quality"). By default, always prefer "Fast" variants when available as they are least resource intensive.\n\n'

  // Add preset-specific tool instructions with clear preset -> instruction mapping
  const presetsWithInstructions = workflows.filter((w) => w.toolInstructions)
  if (presetsWithInstructions.length > 0) {
    description += 'Preset-specific prompt guidelines:\n'
    for (const preset of presetsWithInstructions) {
      description += `- ${preset.name}: ${preset.toolInstructions}\n`
    }
    description += '\n'
  }

  description += `Available edit workflows: ${workflowOptions}`

  const workflowNames = workflows.map((w) => w.name) as [string, ...string[]]

  return {
    description,
    inputSchema: z.object({
      workflow: z
        .enum(workflowNames)
        .describe(
          `Edit workflow to use. Available: ${workflowOptions}. Use "${defaultWorkflow}" unless the user explicitly requests a different workflow.`,
        ),
      variant: z
        .string()
        .optional()
        .describe(
          'Optional variant name (e.g., "Fast", "Standard", "Quality"). If not specified, "Fast" variant will be used by default when available.',
        ),
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
