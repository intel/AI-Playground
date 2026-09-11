import { asSchema, type ModelMessage } from 'ai'
import { z } from 'zod'
import { comfyUI, executeComfyGeneration } from './comfyUi'
import { comfyUiImageEdit, executeImageEdit } from './comfyUiImageEdit'
import { queueMediaRequest } from './mediaPipeline'
import { mediaAgentHasTools, runMediaAgent } from '../agents/mediaAgent'
import { useTextInference } from '../store/textInference'
import { createChatModel } from '@/lib/chatModel'
import type { AgentToolSpec } from '@/types/agentIpc'

// ── Agent Mode tool bridge (renderer side) ───────────────────────────────────
//
// The Pi HarnessAgent runs in the Electron main process, but the AIPG media
// tool implementations live here in the renderer (they orchestrate the Pinia
// stores driving ComfyUI). This module is the renderer half of the bridge:
//
//  - getAgentToolSpecs() serializes the tool contracts (name, description,
//    JSON-schema input) into AgentToolSpec[] shipped with each turn config.
//    The main process builds host-executed proxy tools from them and hands
//    them to the HarnessAgent, which forwards them to Pi as custom tools.
//  - executeAgentTool() runs the real implementation when the main process
//    dispatches an 'agentMode:executeTool' request back to the renderer.
//
// Path/file handling stays in the main process: for inputs listed in
// `workspacePathInputs` (editImage's sourceImagePath) main resolves the
// workspace-relative path and replaces it with a data URI before dispatching,
// and generated media in results is saved to <workspace>/generated/ there.

const GENERATED_FILES_NOTE =
  '\n\nFILES: Generated media is automatically saved into the "generated/" folder of your ' +
  'workspace. The tool result lists the workspace-relative paths in "savedFiles".'

const SOURCE_IMAGE_NOTE =
  '\n\nAGENT MODE: There is no conversation image history here. You MUST pass the image to ' +
  'edit via the required "sourceImagePath" parameter — a workspace-relative path to an ' +
  'existing image file (e.g. "generated/AIPG_00001_.png" from a previous generateImage call, ' +
  'or any image file in the workspace).'

function editImageInputSchema(): z.ZodTypeAny {
  // The edit tool's zod schema is preset-dependent (workflow enum), so extend
  // it lazily at spec-build time.
  const base = comfyUiImageEdit.inputSchema as unknown as z.ZodObject
  return base.extend({
    sourceImagePath: z
      .string()
      .describe(
        'Workspace-relative path of the source image file to edit (e.g. "generated/AIPG_00001_.png").',
      ),
  })
}

const MEDIA_SPEC_DESCRIPTION =
  'Create or transform media (images, videos, 3D models) via a media specialist. Describe the ' +
  'desired result in natural language; the specialist picks the workflow and parameters and ' +
  'can chain steps in one call (e.g. "generate an image of a castle and turn it into a 3D ' +
  'model"). To transform an existing image, pass its workspace-relative path in ' +
  '"sourceImagePath".' +
  GENERATED_FILES_NOTE

function mediaSpecInputSchema(): z.ZodTypeAny {
  return z.object({
    request: z
      .string()
      .describe(
        'The media request in natural language. Include everything relevant: subject, style, ' +
          'aspect ratio or size wishes, quality level, and any follow-up transformation ' +
          '(edit / animate / convert to 3D).',
      ),
    sourceImagePath: z
      .string()
      .optional()
      .describe(
        'Workspace-relative path of a source image to transform (e.g. ' +
          '"generated/AIPG_00001_.png"). Omit for pure text-to-media generation.',
      ),
  })
}

export function getAgentToolSpecs(): AgentToolSpec[] {
  // With tool delegation on (the default), the agent sees a single thin
  // `media` tool backed by the nested media agent (agents/mediaAgent.ts).
  // NOTE: the tool set is part of the Pi session's configKey, so flipping the
  // toggle starts a new Pi session on the next turn.
  if (useTextInference().toolDelegationEnabled) {
    if (!mediaAgentHasTools()) return []
    return [
      {
        name: 'media',
        description: MEDIA_SPEC_DESCRIPTION,
        inputSchema: asSchema(mediaSpecInputSchema()).jsonSchema as Record<string, unknown>,
        workspacePathInputs: ['sourceImagePath'],
      },
    ]
  }
  return [
    {
      name: 'generateImage',
      description: comfyUI.description + GENERATED_FILES_NOTE,
      inputSchema: asSchema(comfyUI.inputSchema).jsonSchema as Record<string, unknown>,
    },
    {
      name: 'editImage',
      description: (comfyUiImageEdit.description ?? '') + SOURCE_IMAGE_NOTE + GENERATED_FILES_NOTE,
      inputSchema: asSchema(editImageInputSchema()).jsonSchema as Record<string, unknown>,
      workspacePathInputs: ['sourceImagePath'],
    },
  ]
}

function dataUriMessage(dataUri: string): ModelMessage {
  const mediaType = /^data:(image\/[a-z+.-]+);/i.exec(dataUri)?.[1] ?? 'image/png'
  return {
    role: 'user',
    content: [{ type: 'file', mediaType, data: dataUri }],
  }
}

/**
 * Pi executes tool calls concurrently, and a model illustrating a game asks for
 * all of its art at once — so every bridged call queues on the shared media
 * pipeline (see mediaPipeline.ts) instead of racing the others over the one
 * ComfyUI server and the one generation store.
 */
export function executeAgentTool(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId?: string,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  return queueMediaRequest(
    () => runAgentTool(toolName, input, toolCallId, abortSignal),
    abortSignal,
  )
}

async function runAgentTool(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId?: string,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  if (toolName === 'media') {
    const { request, sourceImagePath } = input
    // The main process already replaced a provided workspace path with a data
    // URI (see workspacePathInputs); anything else means "no source image".
    const sourceImage =
      typeof sourceImagePath === 'string' && sourceImagePath.startsWith('data:image/')
        ? sourceImagePath
        : undefined
    const result = await runMediaAgent({
      request: String(request ?? ''),
      sourceImage,
      model: createChatModel(),
      abortSignal,
      // Matches the tool part rendered in Agent Mode, so the timeline can show
      // this run's progress while the bridged call blocks.
      runId: toolCallId,
    })
    // Slim the media entries before they enter Pi's context: keep the URLs
    // (the main process resolves them to save files into <workspace>/generated/)
    // but drop the bulky per-item settings payloads.
    return {
      summary: result.summary,
      steps: result.steps,
      success: result.success,
      message: result.message,
      images: result.images.map((item) => {
        const slim: Record<string, string> = { id: item.id, type: item.type }
        if (item.imageUrl) slim.imageUrl = item.imageUrl
        if (item.videoUrl) slim.videoUrl = item.videoUrl
        if (item.model3dUrl) slim.model3dUrl = item.model3dUrl
        return slim
      }),
    }
  }
  if (toolName === 'generateImage') {
    return await executeComfyGeneration(input as Parameters<typeof executeComfyGeneration>[0], {
      abortSignal,
    })
  }
  if (toolName === 'editImage') {
    const { sourceImagePath, ...args } = input
    // The main process already replaced the workspace path with a data URI.
    if (typeof sourceImagePath !== 'string' || !sourceImagePath.startsWith('data:image/')) {
      throw new Error('editImage requires a sourceImagePath pointing to an image file.')
    }
    // executeImageEdit discovers its source image from conversation messages;
    // synthesize a single user message carrying the inlined image.
    return await executeImageEdit(
      args as Parameters<typeof executeImageEdit>[0],
      [dataUriMessage(sourceImagePath)],
      { abortSignal },
    )
  }
  throw new Error(`Unknown agent tool: ${toolName}`)
}
