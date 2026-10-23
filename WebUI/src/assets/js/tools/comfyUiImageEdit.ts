import { z } from 'zod'
import { repairWorkflowToolInput } from '@/lib/comfyToolRepair'
import { tool } from 'ai'
import { usePresets, type Preset } from '../store/presets'
import { useTextInference } from '../store/textInference'
import { DEV_PRESET_NAMES, dummyWorkflowsOnly } from '../store/devPresets'

const ImageEditImageOutputSchema = z.object({
  id: z.string(),
  type: z.literal('image'),
  imageUrl: z.string(),
  mode: z.literal('imageEdit'),
  settings: z.record(z.string(), z.unknown()),
})

const ImageEditVideoOutputSchema = z.object({
  id: z.string(),
  type: z.literal('video'),
  videoUrl: z.string(),
  mode: z.literal('imageEdit'),
  settings: z.record(z.string(), z.unknown()),
})

const ImageEditModel3DOutputSchema = z.object({
  id: z.string(),
  type: z.literal('model3d'),
  model3dUrl: z.string(),
  mode: z.literal('imageEdit'),
  settings: z.record(z.string(), z.unknown()),
})

// Edit-category workflows can yield images (e.g. "Edit By Prompt") or other
// media (e.g. "Image To 3D Model" → model3d). Mirror the multi-media output
// of the create-images `comfyUI` tool so 3D / video edit workflows can
// actually complete their tool call.
const ImageEditMediaOutputSchema = z.discriminatedUnion('type', [
  ImageEditImageOutputSchema,
  ImageEditVideoOutputSchema,
  ImageEditModel3DOutputSchema,
])

export const ImageEditToolOutputSchema = z
  .object({
    images: z.array(ImageEditMediaOutputSchema),
    success: z.boolean().optional(),
    message: z.string().optional(),
  })
  .passthrough()

export type ImageEditToolOutput = z.infer<typeof ImageEditToolOutputSchema>

export function getAvailableEditWorkflows(): Array<{
  name: string
  mediaType?: 'image' | 'video' | 'model3d'
  description?: string
  toolInstructions?: string
}> {
  const presets = usePresets()
  const textInference = useTextInference()
  return presets.presets
    .filter((p: Preset) => {
      if (!(p.type === 'comfy' && p.backend === 'comfyui')) return false
      if (p.toolCategory !== 'edit-images') return false
      // Dev-only override (Settings › Developer): offer only the instant dummy
      // workflows, so a verification run can't wander into a real model.
      if (dummyWorkflowsOnly()) return DEV_PRESET_NAMES.has(p.name)
      // Honour the per-workflow sub-checkboxes (Settings › Built-in tools).
      return textInference.isWorkflowPresetEnabled(p.name)
    })
    .map((p: Preset) => ({
      name: p.name,
      mediaType: p.mediaType,
      description: p.description,
      toolInstructions: p.toolInstructions,
    }))
}

// User-selectable defaults, resolved per output media type from the enabled edit
// presets. Standalone, explicitly-typed helpers keep the heavy `useTextInference()`
// store type out of `getToolDefinition` (whose inferred shape feeds the ai-SDK
// `tool()` generics), avoiding a type-instantiation blow-up.
function resolveDefaultEditWorkflow(imageNames: string[]): string {
  return (
    useTextInference().getDefaultWorkflow('comfyUiImageEdit:image', imageNames) ?? 'Edit By Prompt'
  )
}

/**
 * Repair a malformed comfyUiImageEdit tool call before execution: if the model
 * omitted `workflow` or sent a value that isn't a known edit workflow, coerce it
 * to the default edit workflow. Returns the repaired args as a JSON string, or
 * null when `workflow` is already valid (nothing to fix) or none exist. Wired
 * into streamText's experimental_repairToolCall so a bad workflow can't surface
 * as an "unknown" tool card / failed edit.
 */
export function repairEditToolInput(rawInput: string): string | null {
  const data = createEditToolRepairData()
  return data ? repairWorkflowToolInput(rawInput, data) : null
}

/**
 * Edit-tool twin of `createToolRepairData` (comfyUi.ts): shipped as the turn
 * request's `repairData.comfyUiImageEdit` for the main-side turn engine.
 */
export function createEditToolRepairData():
  import('@/lib/comfyToolRepair').WorkflowRepairData | null {
  const workflows = getAvailableEditWorkflows()
  if (workflows.length === 0) return null
  const imageNames = workflows
    .filter((w) => (w.mediaType ?? 'image') === 'image')
    .map((w) => w.name)
  return {
    names: workflows.map((w) => w.name),
    defaultWorkflow: resolveDefaultEditWorkflow(imageNames),
  }
}

function resolveDefaultAnimateWorkflow(videoNames: string[]): string | null {
  return useTextInference().getDefaultWorkflow('comfyUiImageEdit:video', videoNames)
}

function resolveDefaultTo3DWorkflow(modelNames: string[]): string | null {
  return useTextInference().getDefaultWorkflow('comfyUiImageEdit:model3d', modelNames)
}

function getToolDefinition() {
  const workflows = getAvailableEditWorkflows()

  const imageNames = workflows
    .filter((w) => (w.mediaType ?? 'image') === 'image')
    .map((w) => w.name)
  const videoNames = workflows.filter((w) => w.mediaType === 'video').map((w) => w.name)
  const modelNames = workflows.filter((w) => w.mediaType === 'model3d').map((w) => w.name)
  const defaultEditWorkflow = resolveDefaultEditWorkflow(imageNames)
  const defaultAnimateWorkflow = resolveDefaultAnimateWorkflow(videoNames)
  const defaultTo3DWorkflow = resolveDefaultTo3DWorkflow(modelNames)

  const workflowOptions = workflows
    .map((w) => {
      const mediaTypeStr = w.mediaType && w.mediaType !== 'image' ? ` (${w.mediaType})` : ''
      let isDefault = ''
      if (w.name === defaultEditWorkflow) isDefault = ' (default)'
      else if (w.name === defaultAnimateWorkflow) isDefault = ' (default animate)'
      else if (w.name === defaultTo3DWorkflow) isDefault = ' (default 3D)'
      return w.name + mediaTypeStr + isDefault
    })
    .join(', ')

  const videoWorkflows = workflows.filter((w) => w.mediaType === 'video')

  let description =
    'Use this tool to transform an existing image from the conversation based on a text prompt. ' +
    'This tool takes the most recent image from the conversation (uploaded or generated) and applies the selected workflow - editing it, converting it to a 3D model, or animating it into a video.\n\n' +
    'IMPORTANT: This tool requires an image to already exist in the conversation.\n\n' +
    'VARIANT SUPPORT: Presets may have variants (e.g., "Fast", "Standard", "Quality"). By default, always prefer "Fast" variants when available as they are least resource intensive.\n\n'

  if (videoWorkflows.length > 0) {
    description += `IMAGE-TO-VIDEO: Workflows (${videoWorkflows
      .map((w) => w.name)
      .join(
        ', ',
      )}) animate the existing image into a short video. Only use them when the user explicitly asks to animate an image or create a video from it. Video generation is resource-intensive.\n\n`
  }

  // Add preset-specific tool instructions with clear preset -> instruction mapping
  const presetsWithInstructions = workflows.filter((w) => w.toolInstructions)
  if (presetsWithInstructions.length > 0) {
    description += 'Preset-specific prompt guidelines:\n'
    for (const preset of presetsWithInstructions) {
      description += `- ${preset.name}: ${preset.toolInstructions}\n`
    }
    description += '\n'
  }

  // Per-output-type defaults: what to reach for unless the user asks otherwise.
  description += `DEFAULTS: For editing an image, default to "${defaultEditWorkflow}".`
  if (defaultAnimateWorkflow) {
    description += ` To animate an image into a video, default to "${defaultAnimateWorkflow}".`
  }
  if (defaultTo3DWorkflow) {
    description += ` To convert an image into a 3D model, default to "${defaultTo3DWorkflow}".`
  }
  description += '\n\n'

  description += `Available edit workflows: ${workflowOptions}`

  const workflowNames = workflows.map((w) => w.name) as [string, ...string[]]

  let workflowDescription = `Edit workflow to use. Available: ${workflowOptions}. Use "${defaultEditWorkflow}" for image edits unless the user explicitly requests a different workflow.`
  if (defaultAnimateWorkflow) {
    workflowDescription += ` Use "${defaultAnimateWorkflow}" when animating an image into a video.`
  }
  if (defaultTo3DWorkflow) {
    workflowDescription += ` Use "${defaultTo3DWorkflow}" when converting an image into a 3D model.`
  }

  return {
    description,
    inputSchema: z.object({
      workflow: z.enum(workflowNames).describe(workflowDescription),
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
})
