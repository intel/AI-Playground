import { NoSuchToolError, type ModelMessage, type ToolSet } from 'ai'
import { jsonSchema, tool } from '@ai-sdk/provider-utils'
import type { JSONSchema7 } from '@ai-sdk/provider'
import { appLoggerInstance } from '../observability/logger'
import { createToolAgent, type ToolAgentEvent, type ToolAgentRunOptions } from '@/lib/toolAgent'
import { repairWorkflowToolInput } from '@/lib/comfyToolRepair'
import type {
  ChatToolSpec,
  MediaAgentRunRequest,
  MediaAgentRunResult,
  WorkflowRepairData,
} from '@/types/chatIpc'
import { emitMediaAgentEvent, endMediaAgentRun } from '../kernel/kernelBus'
import { runMediaRequest } from '../kernel/orchestrator'
import { markDelegatedMediaRun, noteMainChatTurnContext } from '../observability/laminar'
import { createMainChatModel } from './chatModelMain'
import { executeChatComfyTool } from './chatComfyTool'

// ── Nested media specialist, run in main (docs/architecture-target.md §8) ───
//
// The nested LLM loop runs here. Its catalog is Comfy only (comfyUI /
// comfyUiImageEdit), executed in-process against the Artifact runner — the same
// `executeChatComfyTool` Chat parent turns use when delegation is off. Live
// progress is `media-agent-event` kernel events. Inner tools are built here so
// this file does not import turnEngine (that cycle dropped `media` execute
// returns as `output: null`).

const appLogger = appLoggerInstance

const INNER_COMFY_TOOLS = new Set(['comfyUI', 'comfyUiImageEdit'])

type MediaAgentRunArgs = MediaAgentRunRequest & {
  readMediaAsDataUri?: (url: string) => Promise<string>
}

type InnerExecOptions = {
  toolCallId?: string
  messages?: ModelMessage[]
  abortSignal?: AbortSignal
}

const SLIM_IMAGE_KEYS = ['id', 'type', 'imageUrl', 'videoUrl', 'model3dUrl', 'mode'] as const

const activeRuns = new Map<string, AbortController>()

function slimInnerComfyOutput(output: Record<string, unknown>): Record<string, unknown> {
  const images = Array.isArray(output.images) ? output.images : []
  return {
    ...(typeof output.success === 'boolean' ? { success: output.success } : {}),
    ...(typeof output.message === 'string' ? { message: output.message } : {}),
    images: images.map((item) => {
      if (typeof item !== 'object' || item === null) return item
      const media = item as Record<string, unknown>
      const slim: Record<string, unknown> = {}
      for (const key of SLIM_IMAGE_KEYS) {
        if (media[key] !== undefined) slim[key] = media[key]
      }
      return slim
    }),
  }
}

async function executeInnerComfy(
  request: MediaAgentRunRequest,
  toolName: string,
  input: unknown,
  execOptions: InnerExecOptions,
  controller: AbortController,
): Promise<Record<string, unknown>> {
  const raw = await executeChatComfyTool({
    toolName,
    input,
    messages: execOptions.messages,
    abortSignal: execOptions.abortSignal ?? controller.signal,
    origin: request.origin,
    owner: {
      kind: 'tool',
      toolCallId: execOptions.toolCallId ?? request.runKey,
      parentToolCallId: request.runKey,
    },
    conversationKey: request.conversationKey,
    keepModelsLoaded: request.keepModelsLoaded ?? false,
  })
  const output = slimInnerComfyOutput(raw)
  console.info(
    `[mediaAgent] inner ${toolName} returned ${Array.isArray(output.images) ? output.images.length : 0} image(s)`,
  )
  return output
}

function innerComfyTools(
  specs: ChatToolSpec[],
  repairData: MediaAgentRunRequest['repairData'],
  execute: (spec: ChatToolSpec, input: unknown, execOptions: InnerExecOptions) => Promise<unknown>,
): ToolSet {
  const tools: ToolSet = {}
  for (const spec of specs) {
    const data: WorkflowRepairData | undefined =
      spec.name === 'comfyUiImageEdit'
        ? repairData?.comfyUiImageEdit
        : spec.name === 'comfyUI'
          ? repairData?.comfyUI
          : undefined
    tools[spec.name] = tool({
      description: spec.description,
      inputSchema: data
        ? jsonSchema(spec.inputSchema as JSONSchema7, {
            validate: async (value: unknown) => {
              const workflow = (value as { workflow?: unknown } | null)?.workflow
              if (typeof workflow === 'string' && data.names.includes(workflow)) {
                return { success: true as const, value }
              }
              return {
                success: false as const,
                error: new Error(
                  `Invalid workflow ${
                    typeof workflow === 'string' ? `"${workflow}"` : '(missing)'
                  } for ${spec.name}`,
                ),
              }
            },
          })
        : jsonSchema(spec.inputSchema as JSONSchema7),
      execute: (input: unknown, execOptions: InnerExecOptions) => execute(spec, input, execOptions),
    }) as ToolSet[string]
  }
  return tools
}

/** Parse a data URI into the file message the nested edit tool discovers. */
function sourceImageMessage(dataUri: string): ModelMessage {
  const mediaType = /^data:(image\/[a-z+.-]+);/i.exec(dataUri)?.[1] ?? 'image/png'
  return {
    role: 'user',
    content: [{ type: 'file', mediaType, data: dataUri }],
  }
}

/**
 * Runs one delegated media request. Its tools execute in-process; edit
 * source-image discovery reads the nested ModelMessage history in main.
 */
export async function runMediaAgentInMain(
  request: MediaAgentRunArgs,
  abortSignal?: AbortSignal,
): Promise<MediaAgentRunResult> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (abortSignal?.aborted) {
    const error = new Error('Media specialist run aborted.')
    error.name = 'AbortError'
    throw error
  }
  abortSignal?.addEventListener('abort', onAbort, { once: true })
  activeRuns.set(request.runKey, controller)
  try {
    // One media-request bracket at a time, and never while a generation holds
    // the GPU for media: the bracket's own LLM steps need the chat backend
    // (the orchestrator's request lane — the old renderer pipeline's
    // queueMediaRequest, moved to where the specialist runs).
    return await runMediaRequest(() => runMediaAgentBracket(request, controller), {
      runKey: request.runKey,
      conversationKey: request.conversationKey,
      abortSignal: controller.signal,
    })
  } finally {
    abortSignal?.removeEventListener('abort', onAbort)
    endMediaAgentRun(request.runKey)
    activeRuns.delete(request.runKey)
  }
}

async function runMediaAgentBracket(
  request: MediaAgentRunArgs,
  controller: AbortController,
): Promise<MediaAgentRunResult> {
  const priorMessages: ModelMessage[] = request.sourceImage
    ? [sourceImageMessage(request.sourceImage)]
    : []
  const captured: MediaAgentRunResult['steps'] = []
  const tools = innerComfyTools(
    request.toolSpecs,
    request.repairData,
    async (spec, input, exec) => {
      if (!INNER_COMFY_TOOLS.has(spec.name)) {
        throw new Error(`${spec.name} is not a media specialist tool`)
      }
      const output = await executeInnerComfy(request, spec.name, input, exec, controller)
      captured.push({ toolName: spec.name, input, output })
      return output
    },
  )
  const agent = createToolAgent({
    name: 'mediaAgent',
    system: () => request.system,
    tools: () => tools,
    maxSteps: 6,
  })
  const onEvent = (event: ToolAgentEvent) => emitMediaAgentEvent(request.runKey, event)
  // Tracing: the run carries the context its request shipped, and its spans
  // belong inside the `media` tool call of the parent turn (no-ops without a
  // Laminar config).
  noteMainChatTurnContext(request.model.trace)
  markDelegatedMediaRun()
  const result = await agent.run({
    model: createMainChatModel(request.model),
    request: request.request,
    priorMessages,
    ...(request.readMediaAsDataUri
      ? {
          presentGeneratedImages: {
            read: request.readMediaAsDataUri,
            vision: request.model.supportsVision === true,
          },
        }
      : {}),
    abortSignal: controller.signal,
    repairToolCall: request.repairData ? buildRepair(request) : undefined,
    onEvent,
  })
  return { text: result.text, steps: captured.length > 0 ? captured : result.steps }
}

function buildRepair(
  request: MediaAgentRunRequest,
): NonNullable<ToolAgentRunOptions['repairToolCall']> {
  return async ({ toolCall, error }) => {
    if (NoSuchToolError.isInstance(error)) return null
    const data: WorkflowRepairData | undefined =
      toolCall.toolName === 'comfyUiImageEdit'
        ? request.repairData?.comfyUiImageEdit
        : toolCall.toolName === 'comfyUI'
          ? request.repairData?.comfyUI
          : undefined
    if (!data) return null
    const repaired = repairWorkflowToolInput(toolCall.input, data)
    if (repaired === null) return null
    return { ...toolCall, input: repaired }
  }
}

/**
 * The renderer aborts its tool call (stopped turn, Pi tool abort) → cancel the
 * nested run: aborting the stream also aborts the inner Comfy calls, which run
 * here and take the same signal, so a stopped run stops its ComfyUI work.
 */
export function cancelMediaAgentRun(runKey: string): void {
  const controller = activeRuns.get(runKey)
  if (!controller) {
    appLogger.warn(`media agent cancel for unknown run ${runKey}`, 'chat')
    return
  }
  controller.abort()
}

/** Main calls this when the kernel window changes. */
export function activeMediaAgentRunKeys(): string[] {
  return [...activeRuns.keys()]
}
