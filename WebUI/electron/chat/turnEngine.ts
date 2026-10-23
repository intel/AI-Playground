import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  APICallError,
  convertToModelMessages,
  isStepCount,
  NoSuchToolError,
  readUIMessageStream,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import { dynamicTool, jsonSchema, tool, type ToolResultOutput } from '@ai-sdk/provider-utils'
import type { JSONSchema7 } from '@ai-sdk/provider'
import { appLoggerInstance } from '../observability/logger'
import { computeEnergyWhSince, computeWindowSince } from '../adapters/hardware/computeMetrics'
import { CHAT_ENERGY_ESTIMATES_ENABLED } from '@/lib/chatEnergy'
import { completeOrphanedToolParts, sanitizeBulkyToolOutputs } from '@/lib/toolMessageSanitize'
import { attachGeneratedImageFollowUps, comfyToolModelOutput } from '@/lib/generatedImageFollowUp'
import { slimMediaModelOutput, type SlimMediaToolOutput } from '@/lib/mediaModelOutput'
import { awaitToolExecute } from '@/lib/awaitToolExecute'
import { fillToolResultOutput, patchUiToolOutputs } from '@/lib/pendingToolOutput'
import { repairWorkflowToolInput } from '@/lib/comfyToolRepair'
import { extractMessage } from '@/assets/js/errors/appError'
import type { AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'
import {
  ChatTurnRequestSchema,
  type ChatToolSpec,
  type ChatTurnRequest,
  type ChatTurnSubmitResult,
  type HomeAgentInferenceSnapshot,
  type MediaAgentCatalog,
  type WorkflowRepairData,
} from '@/types/chatIpc'
import {
  beginChatTurnSnapshot,
  emitChatChunk,
  emitChatRag,
  endChatTurn,
  getChatTurnChunks,
} from '../kernel/kernelBus'
import { listMcpServers, getMcpServerStatus } from '../adapters/mcp/mcpManager'
import { createMainChatModel } from './chatModelMain'
import { ensureChatBackendReady, setLastChatBackendLoadActive } from './chatReadiness'
import { retrieveRagForTurn } from './ragRetrieval'
import { executeChatComfyTool } from './chatComfyTool'
import { executeChatMcpTool, isChatMcpTool } from './chatMcpTool'
import { executeChatMediaTool } from './chatMediaTool'
import { executeChatScreenshotTool } from './chatScreenshotTool'
import { CHAT_SPEECH_TOOLS, executeChatSpeechTool } from './chatSpeechTools'
import { executeChatDetectionsTool } from './chatDetectionsTool'
import { CHAT_HOME_AGENT_TOOLS, executeChatHomeAgentTool } from './chatHomeAgentTools'
import {
  CHAT_WEB_TOOLS,
  executeChatWebTool,
  formatSearchResults,
  formatSnapshot,
} from './chatWebTools'
import type { WebPageSnapshot, WebSearchResults } from '../adapters/webBrowserManager'
import { finishTextRequest, submitTextRequest } from '../kernel/orchestrator'
import { saveChatTurnConversation } from '../persist/conversationFiles'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { emitFailure } from '../kernel/kernelBus'

// ── Main-side chat turn engine (docs/architecture-target.md §7, step 6) ──────
//
// Port of the renderer's `customFetch` (store/openAiCompatibleChat.ts): main
// owns the AI SDK call. The turn arrives as resolved data (messages, model
// config, serialized tool specs); what streamed through
// `toUIMessageStreamResponse` now crosses the kernel bus as `chat-chunk`
// events, coalesced at the bus. Every tool body runs in-process too, in a
// module beside this one; an unhandled name throws rather than falling back to
// the renderer. Where a tool genuinely needs this window — the speech engine,
// a confirmation card — it asks for that one answer over `chat:ask`.
//
// What deliberately stayed renderer-side: download consent, the activities
// sink (the transport observes chunk types to drive "Processing prompt…"
// state), the live Chat message list (a projection of the files this engine
// writes), and the reasoning-in-progress flag (derived from the same chunk
// types). Local backend load runs here when `model.readiness` is present,
// after the turn is admitted as a text request (step 10). RAG retrieval runs
// here when `rag` is present (step 9). Transcript files are written here on
// turn start and turn end (step 11) — Pinia no longer calls `saveThread` to
// make a generate/regenerate durable.

const appLogger = appLoggerInstance

export type ChatEngineDeps = {
  /** Reads an `aipg-media://` URL into a base64 data URI; throws on failure. */
  readMediaAsDataUri: (url: string) => Promise<string>
  /** Tracing hooks (no-op unless the developer opted into Laminar). */
  noteTimings?: (timings: LlamaCppTimings) => void
  /** The turn's trace context (backend, device, thinking, sampling) to stamp spans with. */
  noteTraceContext?: (context: Record<string, unknown> | null) => void
  /** Tests inject retrieval; production uses `retrieveRagForTurn`. */
  prepareRag?: typeof retrieveRagForTurn
}

let engineDeps: ChatEngineDeps | null = null

export function setChatEngineDeps(deps: ChatEngineDeps): void {
  engineDeps = deps
}

export function resetChatEngineDepsForTest(): void {
  engineDeps = null
  activeTurns.clear()
}

async function persistChatTurn(request: ChatTurnRequest, messages: unknown[]): Promise<void> {
  if (!request.persist) return
  try {
    await saveChatTurnConversation({
      id: request.conversationKey,
      meta: request.persist.meta,
      ragHashes: request.persist.ragHashes,
      messages: cloneForIpc(messages),
      lastMainKey: request.persist.lastMainKey,
    })
  } catch (error) {
    appLogger.warn(`Chat transcript persist failed: ${extractMessage(error)}`, 'electron-backend')
  }
}

function withRagSource(message: UIMessage, ragSource: string | null): UIMessage {
  if (!ragSource) return message
  const metadata =
    message.metadata && typeof message.metadata === 'object'
      ? { ...(message.metadata as Record<string, unknown>), ragSource }
      : { ragSource }
  return { ...message, metadata }
}

async function assembleAssistantFromStream(
  stream: ReadableStream<UIMessageChunk>,
): Promise<UIMessage | undefined> {
  let last: UIMessage | undefined
  for await (const message of readUIMessageStream({ stream })) {
    last = message
  }
  return last
}

// ── Inference error surfacing (ported from the chat store) ────────────────────

function describeInferenceError(error: unknown): string {
  if (APICallError.isInstance(error)) {
    const body = typeof error.responseBody === 'string' ? error.responseBody.trim() : ''
    const detail = body || error.message
    const status = error.statusCode ? `HTTP ${error.statusCode}` : ''
    const capped = detail.length > 500 ? `${detail.slice(0, 500)}…` : detail
    return [status, capped].filter(Boolean).join(': ') || 'Inference request failed'
  }
  return extractMessage(error)
}

// ── Raw llama.cpp timings (ported schemas) ─────────────────────────────────────

const LlamaCppRawValueTimingsSchema = z.object({
  cache_n: z.number(),
  prompt_n: z.number(),
  prompt_ms: z.number(),
  prompt_per_token_ms: z.number(),
  prompt_per_second: z.number(),
  predicted_n: z.number(),
  predicted_ms: z.number(),
  predicted_per_token_ms: z.number(),
  predicted_per_second: z.number(),
})

export type LlamaCppTimings = z.infer<typeof LlamaCppRawValueTimingsSchema>

const LlamaCppRawValueSchema = z.object({
  usage: z
    .object({
      completion_tokens: z.number(),
      prompt_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
  timings: LlamaCppRawValueTimingsSchema.optional(),
})

// ── MCP instructions (ported from resolveMcpInstructions) ──────────────────────

function buildMcpInstructions(include: boolean): string {
  if (!include) return ''
  try {
    const blocks: string[] = []
    for (const server of listMcpServers()) {
      const trimmed = server.instructions?.trim()
      if (!trimmed) continue
      if (getMcpServerStatus(server.id).state !== 'running') continue
      blocks.push(`## MCP server: ${server.name}\n${trimmed}`)
    }
    if (blocks.length === 0) return ''
    return `\n\n# MCP server instructions\n\n${blocks.join('\n\n')}`
  } catch (error) {
    appLogger.warn(
      `Failed to list MCP servers for instructions: ${extractMessage(error)}`,
      'electron-backend',
    )
    return ''
  }
}

// ── Message preparation (ported from customFetch) ─────────────────────────────

async function convertMediaReferences(messages: ModelMessage[]): Promise<ModelMessage[]> {
  const deps = engineDeps
  return await Promise.all(
    messages.map(async (msg) => {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg
      const content = await Promise.all(
        msg.content.map(async (part) => {
          const ref = part.type === 'file' ? (part.data as { type?: string; url?: URL }) : undefined
          if (
            part.type === 'file' &&
            part.mediaType?.startsWith('image/') &&
            ref?.type === 'url' &&
            ref.url?.protocol === 'aipg-media:'
          ) {
            if (!deps) throw new Error('Chat engine deps not wired')
            const dataUri = await deps.readMediaAsDataUri(ref.url.toString())
            return { ...part, data: { type: 'url' as const, url: new URL(dataUri) } }
          }
          return part
        }),
      )
      return { ...msg, content }
    }),
  )
}

function slimToolResults(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) => {
    if (m.role !== 'tool') return m
    return {
      ...m,
      content: m.content.map((part) => {
        // Replayed `media` results carry the rich UI output (incl. bulky
        // per-item settings); condense to the same slim shape toModelOutput
        // sends live, so delegation stays thin across turns.
        if (
          part.type === 'tool-result' &&
          part.toolName === 'media' &&
          part.output.type === 'json'
        ) {
          const value = part.output.value as { images?: unknown } | null
          if (value && Array.isArray(value.images)) {
            return {
              ...part,
              output: slimMediaModelOutput(value as never) as ToolResultOutput,
            }
          }
          return part
        }
        if (
          part.type === 'tool-result' &&
          part.toolName === 'visualizeObjectDetections' &&
          part.output.type === 'json'
        ) {
          return {
            ...part,
            output: {
              type: 'text',
              value: 'Object detections visualized on image successfully',
            } as ToolResultOutput,
          }
        }
        if (
          part.type === 'tool-result' &&
          part.toolName === 'synthesizeTextToSpeech' &&
          part.output.type === 'json'
        ) {
          const value = part.output.value as {
            ok?: boolean
            message?: string
            savedFilePath?: string
          } | null
          const text =
            value?.ok === false
              ? (value.message ?? 'Speech synthesis failed.')
              : `${value?.message ?? 'Speech synthesized successfully.'}${
                  value?.savedFilePath ? ` File: ${value.savedFilePath}` : ''
                }`
          return {
            ...part,
            output: { type: 'text', value: text } as ToolResultOutput,
          }
        }
        return part
      }),
    }
  })
}

// Screenshot tool results carry the capture as a data URI. The
// OpenAI-compatible provider JSON.stringifies a tool result's value into the
// tool message text, so the raw base64 would be sent as text. Instead,
// replace the tool result with a short text and inject the capture as a real
// vision image in a following user message — the path the backend supports.
function injectScreenshotImages(messages: ModelMessage[]): ModelMessage[] {
  return messages.flatMap((m): ModelMessage[] => {
    if (m.role !== 'tool') return [m]
    const injectedImages: Array<{ mediaType: string; data: string; windowName: string }> = []
    const content = m.content.map((part) => {
      if (
        part.type === 'tool-result' &&
        (part.toolName === 'captureScreenshot' || part.toolName === 'screenshotWebPage') &&
        part.output.type === 'json'
      ) {
        const value = part.output.value as {
          ok?: boolean
          windowName?: string
          dataUri?: string
        } | null
        if (value?.ok && typeof value.dataUri === 'string') {
          const mediaType =
            value.dataUri.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/)?.[1] ?? 'image/png'
          const windowName =
            value.windowName ?? (part.toolName === 'screenshotWebPage' ? 'web page' : 'window')
          injectedImages.push({ mediaType, data: value.dataUri, windowName })
          return {
            ...part,
            output: {
              type: 'text',
              value: `Screenshot of "${windowName}" captured. The image is attached in the following message.`,
            } as ToolResultOutput,
          }
        }
      }
      return part
    })
    const rewritten = { ...m, content } as ModelMessage
    if (injectedImages.length === 0) return [rewritten]
    const imageMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Here is the captured screenshot to inspect:' },
        ...injectedImages.map((img) => ({
          type: 'file' as const,
          mediaType: img.mediaType,
          data: { type: 'url' as const, url: new URL(img.data) },
        })),
      ],
    } as ModelMessage
    return [rewritten, imageMessage]
  })
}

/**
 * No chat backend accepts an audio part — llama.cpp rejects the whole request
 * with "audio input is not supported", before any tool could run. So the clip
 * is described instead of sent, and `transcribeAudio` reads the real bytes off
 * the untouched message list.
 */
function describeAudioAttachments(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg
    if (!msg.content.some((part) => part.type === 'file' && part.mediaType?.startsWith('audio/'))) {
      return msg
    }
    return {
      ...msg,
      content: msg.content.map((part) =>
        part.type === 'file' && part.mediaType?.startsWith('audio/')
          ? {
              type: 'text' as const,
              text:
                `[An audio clip${part.filename ? ` (${part.filename})` : ''} is attached to this ` +
                'message. Call the transcribeAudio tool to read what it says.]',
            }
          : part,
      ),
    } as ModelMessage
  })
}

function filterNonVisionContent(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const filteredContent = msg.content.filter((part) => part.type === 'text')
      if (filteredContent.length === 0) {
        return {
          ...msg,
          content: [
            {
              type: 'text' as const,
              text: 'This message contained an image, but the model does not support vision.',
            },
          ],
        }
      }
      return { ...msg, content: filteredContent }
    }
    return msg
  })
}

const MAX_HISTORY_IMAGES = 2

function capHistoryImages(messages: ModelMessage[]): {
  messages: ModelMessage[]
  kept: number
  dropped: number
} {
  let keptImages = 0
  let droppedImages = 0
  const capped = [...messages]
  for (let i = capped.length - 1; i >= 0; i--) {
    const content = capped[i].content
    if (!Array.isArray(content)) continue
    let changed = false
    const newContent = content.map((part) => {
      const p = part as { type: string; mediaType?: string }
      if (p.type !== 'file' || !p.mediaType?.startsWith('image/')) return part
      if (keptImages < MAX_HISTORY_IMAGES) {
        keptImages++
        return part
      }
      changed = true
      droppedImages++
      return { type: 'text', text: '[earlier image omitted]' } as typeof part
    })
    if (changed) capped[i] = { ...capped[i], content: newContent } as ModelMessage
  }
  return { messages: capped, kept: keptImages, dropped: droppedImages }
}

// ── Tool set from serialized specs ────────────────────────────────────────────

/**
 * The renderer tool modules are schema + description only, so a formatter
 * declared there would never reach the model — the tool set crosses to main as
 * JSON Schema. Tools executed in main declare theirs here instead.
 */
function modelOutputFor(toolName: string): ToolSet[string]['toModelOutput'] | undefined {
  if (toolName === 'comfyUI' || toolName === 'comfyUiImageEdit') {
    return ({ output }: { output: unknown }) => comfyToolModelOutput(output)
  }
  if (toolName === 'media') {
    return ({ output }: { output: unknown }) => {
      if (!output || typeof output !== 'object') {
        return { type: 'error-text' as const, value: 'Media generation returned no result.' }
      }
      return slimMediaModelOutput(output as SlimMediaToolOutput)
    }
  }
  if (toolName === 'searchWeb') {
    return ({ output }: { output: unknown }) => ({
      type: 'text' as const,
      value: formatSearchResults(output as WebSearchResults),
    })
  }
  if (toolName === 'browseWeb' || toolName === 'interactWithWebPage') {
    return ({ output }: { output: unknown }) => ({
      type: 'text' as const,
      value: formatSnapshot(output as WebPageSnapshot),
    })
  }
  // The capture is not returned to the model here: the OpenAI-compatible
  // provider JSON-stringifies tool-result content, so base64 would be sent as
  // text. `injectScreenshotImages` attaches it as a real vision image instead.
  if (toolName === 'captureScreenshot' || toolName === 'screenshotWebPage') {
    return ({ output }: { output: unknown }) => {
      const value = output as { ok?: boolean; message?: string } | null
      const message = value?.message ?? 'Screenshot failed.'
      return value?.ok
        ? { type: 'text' as const, value: message }
        : { type: 'error-text' as const, value: message }
    }
  }
  if (toolName === 'synthesizeTextToSpeech') {
    return ({ output }: { output: unknown }) => {
      const value = output as { ok?: boolean; message?: string; savedFilePath?: string } | null
      const message = value?.message ?? 'Speech synthesis failed.'
      if (!value?.ok) return { type: 'error-text' as const, value: message }
      return {
        type: 'text' as const,
        value: `${message}${value.savedFilePath ? ` File: ${value.savedFilePath}` : ''}`,
      }
    }
  }
  // The annotated image is for the chat card: the OpenAI-compatible provider
  // JSON-stringifies tool-result content, so the data URL would be sent as text.
  if (toolName === 'visualizeObjectDetections') {
    return () => ({
      type: 'text' as const,
      value: 'Object detections visualized on image successfully',
    })
  }
  if (toolName === 'transcribeAudio') {
    return ({ output }: { output: unknown }) => {
      const value = output as { ok?: boolean; message?: string; transcript?: string } | null
      const message = value?.message ?? 'Transcription failed.'
      return value?.ok
        ? { type: 'text' as const, value: value.transcript ?? message }
        : { type: 'error-text' as const, value: message }
    }
  }
  return undefined
}

/**
 * `jsonSchema()` without a `validate` option accepts anything, so the SDK's
 * tool-input validation — the trigger for the comfy workflow repair — would
 * be gone. The only validation the original zod ToolSet performed that has a
 * behavioral consumer is the comfy tools' `workflow` membership (the repair
 * path exists for exactly that); enforce it here from the shipped repair
 * names. Everything else passes through unvalidated, same as today's model
 * args that zod would have caught surface as errors only via the executor.
 *
 * Built-in tools use `tool()` so the UI stream emits `tool-${name}` parts
 * (Chat.vue cards). MCP tools stay `dynamicTool()` (`dynamic-tool` + `mcp__`).
 */
type ToolExecuteOptions = {
  toolCallId: string
  messages?: ModelMessage[]
  abortSignal?: AbortSignal
}

type BuildToolSetOptions = {
  /** Override the in-process executor (media specialist inner Comfy, step 12). */
  execute?: (
    spec: ChatToolSpec,
    input: unknown,
    execOptions: ToolExecuteOptions,
  ) => Promise<unknown>
  /** Parent Chat `media` tool: in-process specialist. Missing catalog fails closed. */
  parentMedia?: {
    catalog: MediaAgentCatalog
    model: ChatTurnRequest['model']
    keepModelsLoaded: boolean
    readMediaAsDataUri: (url: string) => Promise<string>
  }
  /** In-process Chat Comfy (delegation off). Missing reader fails closed. */
  keepModelsLoaded?: boolean
  readMediaAsDataUri?: (url: string) => Promise<string>
  /** The window `captureScreenshot` is bound to, shipped on the turn. */
  screenshotWindow?: { id: string; name: string }
  /** Conversation title for the TTS file name; the thread's own title lives renderer-side. */
  conversationLabel?: string
  /** What the Home Agent's settings tools read; absent on any other preset's turn. */
  homeAgentInference?: HomeAgentInferenceSnapshot
  /** The turn's messages with their attachments intact — what `transcribeAudio` reads. */
  attachmentMessages?: ModelMessage[]
  /** Track each execute Promise so a null SDK tool result can still wait. */
  onExecute?: (toolCallId: string, work: Promise<unknown>) => void
}

async function dispatchChatTool(
  spec: ChatToolSpec,
  input: unknown,
  execOptions: ToolExecuteOptions,
  ctx: {
    conversationKey: string
    defaultWorkflow?: string
    options?: BuildToolSetOptions
  },
): Promise<unknown> {
  const exec: ToolExecuteOptions = {
    toolCallId: execOptions.toolCallId,
    messages: execOptions.messages,
    abortSignal: execOptions.abortSignal,
  }
  const options = ctx.options
  if (options?.execute) return await options.execute(spec, input, exec)
  if (spec.name === 'media') {
    if (!options?.parentMedia) {
      throw new Error(
        'media tool is missing its catalog; it runs in main and cannot round-trip to the renderer',
      )
    }
    return await executeChatMediaTool({
      input,
      toolCallId: exec.toolCallId,
      conversationKey: ctx.conversationKey,
      messages: exec.messages,
      abortSignal: exec.abortSignal,
      catalog: options.parentMedia.catalog,
      model: options.parentMedia.model,
      keepModelsLoaded: options.parentMedia.keepModelsLoaded,
      readMediaAsDataUri: options.parentMedia.readMediaAsDataUri,
    })
  }
  if (spec.name === 'comfyUI' || spec.name === 'comfyUiImageEdit') {
    if (!options?.readMediaAsDataUri) {
      throw new Error(`${spec.name} runs in main and cannot round-trip to the renderer`)
    }
    return await executeChatComfyTool({
      toolName: spec.name,
      input,
      messages: exec.messages,
      abortSignal: exec.abortSignal,
      owner: { kind: 'tool', toolCallId: exec.toolCallId },
      conversationKey: ctx.conversationKey,
      keepModelsLoaded: options.keepModelsLoaded ?? false,
      defaultWorkflow: ctx.defaultWorkflow,
      readMediaAsDataUri: options.readMediaAsDataUri,
    })
  }
  if (isChatMcpTool(spec.name)) {
    return await executeChatMcpTool({
      toolName: spec.name,
      input,
      conversationKey: ctx.conversationKey,
    })
  }
  if (CHAT_WEB_TOOLS.has(spec.name)) {
    return await executeChatWebTool({
      toolName: spec.name,
      input,
      conversationKey: ctx.conversationKey,
    })
  }
  if (spec.name === 'captureScreenshot') {
    return await executeChatScreenshotTool({
      target: options?.screenshotWindow,
      conversationKey: ctx.conversationKey,
    })
  }
  if (spec.name === 'visualizeObjectDetections') {
    if (!options?.readMediaAsDataUri) {
      throw new Error(`${spec.name} runs in main and cannot round-trip to the renderer`)
    }
    return await executeChatDetectionsTool({
      input,
      conversationKey: ctx.conversationKey,
      messages: exec.messages,
      readMediaAsDataUri: options.readMediaAsDataUri,
    })
  }
  if (CHAT_SPEECH_TOOLS.has(spec.name)) {
    if (!options?.readMediaAsDataUri) {
      throw new Error(`${spec.name} runs in main and cannot round-trip to the renderer`)
    }
    return await executeChatSpeechTool({
      toolName: spec.name,
      input,
      conversationKey: ctx.conversationKey,
      conversationLabel: options.conversationLabel,
      // The step's own messages no longer carry the clip (see
      // `describeAudioAttachments`), so transcription reads the turn's copy.
      messages: options.attachmentMessages ?? exec.messages,
      readMediaAsDataUri: options.readMediaAsDataUri,
      abortSignal: exec.abortSignal,
    })
  }
  if (CHAT_HOME_AGENT_TOOLS.has(spec.name)) {
    return await executeChatHomeAgentTool({
      toolName: spec.name,
      input,
      conversationKey: ctx.conversationKey,
      toolCallId: exec.toolCallId,
      snapshot: options?.homeAgentInference,
      abortSignal: exec.abortSignal,
    })
  }
  throw new Error(`${spec.name} runs in main and cannot round-trip to the renderer`)
}

export function buildToolSet(
  specs: ChatToolSpec[],
  conversationKey: string,
  repairData: ChatTurnRequest['repairData'],
  options?: BuildToolSetOptions,
): ToolSet {
  const tools: ToolSet = {}
  for (const spec of specs) {
    const data: WorkflowRepairData | undefined =
      spec.name === 'comfyUiImageEdit'
        ? repairData?.comfyUiImageEdit
        : spec.name === 'comfyUI'
          ? repairData?.comfyUI
          : undefined
    const definition = {
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
                  `Invalid workflow ${typeof workflow === 'string' ? `"${workflow}"` : '(missing)'} for ${spec.name}`,
                ),
              }
            },
          })
        : jsonSchema(spec.inputSchema as JSONSchema7),
      execute: (input: unknown, execOptions: ToolExecuteOptions) => {
        const work = awaitToolExecute(
          dispatchChatTool(spec, input, execOptions, {
            conversationKey,
            defaultWorkflow: data?.defaultWorkflow,
            options,
          }),
        )
        options?.onExecute?.(execOptions.toolCallId, work)
        return work
      },
      ...(() => {
        const toModelOutput = modelOutputFor(spec.name)
        return toModelOutput ? { toModelOutput } : {}
      })(),
    }
    // MCP tools are not in the app's tool union; static tools must stay
    // `tool()` so Chat.vue can match `tool-media` / `tool-comfyUI` parts.
    tools[spec.name] = (
      spec.name.startsWith('mcp__') ? dynamicTool(definition) : tool(definition)
    ) as ToolSet[string]
  }
  return tools
}

// ── Turn lifecycle ────────────────────────────────────────────────────────────

type ActiveChatTurn = {
  turnId: string
  conversationKey: string
  controller: AbortController
}

const activeTurns = new Map<string, ActiveChatTurn>()

export function chatTurnActive(conversationKey: string): boolean {
  return activeTurns.has(conversationKey)
}

/** Any conversation streaming: the GPU-handoff guard image tools wait on. */
export function anyChatTurnActive(): boolean {
  return activeTurns.size > 0
}

export function submitChatTurn(request: unknown): ChatTurnSubmitResult {
  const req = ChatTurnRequestSchema.parse(request) as ChatTurnRequest
  if (activeTurns.has(req.conversationKey)) {
    throw new Error('A chat turn is already running for this conversation')
  }
  const turnId = randomUUID()
  const turn: ActiveChatTurn = {
    turnId,
    conversationKey: req.conversationKey,
    controller: new AbortController(),
  }
  activeTurns.set(req.conversationKey, turn)
  beginChatTurnSnapshot(req.conversationKey, turnId)
  void runChatTurn(req, turn)
  return { turnId }
}

export function cancelChatTurn(conversationKey: string, turnId: string): void {
  const turn = activeTurns.get(conversationKey)
  if (!turn || turn.turnId !== turnId) return
  // Tool bodies run here and take the turn's abort signal directly, so there is
  // nothing to recall from the renderer — an outstanding `chat:ask` is a
  // question to a human (or to the speech engine) and settles on its own.
  turn.controller.abort()
}

export function resumeChatTurn(conversationKey: string) {
  const turn = activeTurns.get(conversationKey)
  if (!turn) return null
  const captured = getChatTurnChunks(conversationKey, turn.turnId)
  if (!captured) return null
  return { turnId: turn.turnId, ...captured }
}

async function runChatTurn(request: ChatTurnRequest, turn: ActiveChatTurn): Promise<void> {
  const { conversationKey, turnId } = turn
  const haDiag = request.homeAgentDiagnostics === true
  let ragSourceText: string | null = null
  try {
    // User message (and regenerate truncation) land on disk before GPU wait /
    // stream, so a crash mid-turn does not lose the prompt.
    await persistChatTurn(request, request.messages)

    const config = request.model
    await submitTextRequest(
      {
        runId: turnId,
        conversationKey,
        needsGpu: config.backend !== 'cloud' && Boolean(config.readiness),
      },
      turn.controller.signal,
    )

    // Self-heal orphaned tool calls (interrupted/stopped turns, HMR) before
    // converting: an assistant tool-call with no matching result would make
    // convertToModelMessages/streamText throw "Tool result is missing …".
    let messages = await convertToModelMessages(
      sanitizeBulkyToolOutputs(
        completeOrphanedToolParts(request.messages as unknown as AipgUiMessage[]),
      ),
    )

    const readMediaAsDataUri = async (url: string) => {
      if (url.startsWith('data:')) return url
      if (!engineDeps) throw new Error('Chat engine deps not wired')
      return await engineDeps.readMediaAsDataUri(url)
    }
    const supportsVision = config.supportsVision === true
    messages = await convertMediaReferences(messages)
    messages = slimToolResults(messages)
    messages = injectScreenshotImages(messages)
    // Result images are file parts only for a vision model. Every model loses
    // the settings payload, which is where the placeholder 512×512 lives.
    messages = await attachGeneratedImageFollowUps(messages, {
      read: readMediaAsDataUri,
      vision: supportsVision,
    })
    // What `transcribeAudio` reads: the attachments as they arrived, before the
    // model's own view of them is trimmed below.
    const messagesWithAttachments = messages
    messages = describeAudioAttachments(messages)
    if (supportsVision) {
      const capped = capHistoryImages(messages)
      messages = capped.messages
      if (haDiag && (capped.kept || capped.dropped)) {
        appLogger.info(
          `[HA-DIAG] images kept=${capped.kept} droppedFromHistory=${capped.dropped}`,
          'home-agent-diag',
        )
      }
    } else {
      messages = filterNonVisionContent(messages)
    }

    const mcp = buildMcpInstructions(request.includeMcpInstructions === true)
    let systemPromptToUse = `${request.systemPrompt ?? ''}${mcp}`
    const keepModelsLoaded = request.keepModelsLoaded ?? false
    const pendingToolExecutes = new Map<string, Promise<unknown>>()
    const tools = buildToolSet(request.tools, conversationKey, request.repairData, {
      keepModelsLoaded,
      readMediaAsDataUri,
      screenshotWindow: request.screenshotWindow,
      conversationLabel: request.conversationLabel,
      homeAgentInference: request.homeAgentInference,
      attachmentMessages: messagesWithAttachments,
      onExecute: (toolCallId, work) => {
        pendingToolExecutes.set(toolCallId, work)
      },
      parentMedia: request.mediaAgent
        ? {
            catalog: request.mediaAgent,
            model: request.model,
            keepModelsLoaded,
            readMediaAsDataUri,
          }
        : undefined,
    })
    const hasTools = Object.keys(tools).length > 0

    if (haDiag) {
      const toolNames = Object.keys(tools)
      appLogger.info(
        `[HA-DIAG] turn start model=${config.modelId} backend=${config.backend} ` +
          `tools=${toolNames.length} [${toolNames.join(',')}] ` +
          `systemPromptChars=${systemPromptToUse.length} inputMsgs=${messages.length} stepCap=20`,
        'home-agent-diag',
      )
    }

    const repairData = request.repairData

    // The context the request shipped (backend, device, thinking, sampling) is
    // what Laminar stamps this turn's spans with; tracing stays off unless the
    // deps seam was wired.
    engineDeps?.noteTraceContext?.((config.trace as Record<string, unknown> | undefined) ?? null)

    if (config.backend === 'cloud') {
      setLastChatBackendLoadActive(false)
    } else if (config.readiness) {
      // GPU admit already happened as the text request.
      await ensureChatBackendReady(config.readiness, {
        abortSignal: turn.controller.signal,
        skipGpuAdmission: true,
        conversationKey,
      })
    }

    if (request.rag) {
      const prepareRag = engineDeps?.prepareRag ?? retrieveRagForTurn
      const prepared = await prepareRag(
        request.rag,
        request.systemPrompt ?? '',
        turn.controller.signal,
      )
      systemPromptToUse = `${prepared.systemPrompt}${mcp}`
      ragSourceText = prepared.sourceText
      emitChatRag(conversationKey, turnId, prepared.sourceText)
    }

    const diagTurnStart = Date.now()
    let diagStepIdx = 0
    const startOfRequestTime = Date.now()
    let firstTokenTime = 0
    let finishTime = 0
    let timings: LlamaCppTimings | undefined = undefined
    let usage: LanguageModelUsage | undefined = undefined
    let usageFromRawChunk: LanguageModelUsage | undefined = undefined
    let lastStepUsage: LanguageModelUsage | undefined = undefined
    // The window the compute chip and the per-message vRAM/energy figures are
    // read over. Cloud turns run on someone else's card, so they get neither.
    const computeTurnStartedAt = Date.now()
    const computeDeviceHint =
      config.backend === 'cloud'
        ? undefined
        : ((config.trace as Record<string, unknown> | undefined)?.deviceName as string | undefined)
    const reasoningTimings = new Map<string, { started: number; finished: number }>()
    // A reasoning block is a contiguous run of reasoning deltas; any
    // non-reasoning content ends it and the next delta opens a fresh block.
    // An "interrupted?" check (not a time gap) keeps slow models from
    // resetting the block on every token.
    let reasoningInterrupted = true

    const result = await streamText({
      model: createMainChatModel(config),
      messages,
      abortSignal: turn.controller.signal,
      instructions: systemPromptToUse,
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      ...(hasTools
        ? {
            tools,
            stopWhen: isStepCount(20),
            prepareStep: async ({ messages: stepMessages }) => {
              const presented = describeAudioAttachments(
                await attachGeneratedImageFollowUps(stepMessages, {
                  read: readMediaAsDataUri,
                  vision: supportsVision,
                }),
              )
              return {
                messages: supportsVision
                  ? capHistoryImages(presented).messages
                  : filterNonVisionContent(presented),
              }
            },
            ...(repairData
              ? {
                  // Repair a comfy image tool call whose `workflow` the model
                  // omitted or set to an unknown value: coerce it to that
                  // tool's default workflow. Without this the SDK drops the
                  // bad call and the chat renders an "unknown preset" card /
                  // failed generation.
                  experimental_repairToolCall: async ({ toolCall, error }) => {
                    if (NoSuchToolError.isInstance(error)) return null
                    const data: WorkflowRepairData | undefined =
                      toolCall.toolName === 'comfyUiImageEdit'
                        ? repairData.comfyUiImageEdit
                        : toolCall.toolName === 'comfyUI'
                          ? repairData.comfyUI
                          : undefined
                    if (!data) return null
                    const repaired = repairWorkflowToolInput(toolCall.input, data)
                    if (repaired === null) return null
                    return { ...toolCall, input: repaired }
                  },
                }
              : {}),
          }
        : {}),

      onChunk: (chunk) => {
        const chunkType = chunk.chunk.type
        if (haDiag && (chunkType === 'tool-call' || chunkType === 'tool-result')) {
          const c = chunk.chunk as { toolName?: string; toolCallId?: string }
          const t = timings
          appLogger.info(
            `[HA-DIAG] ${chunkType} tool=${c.toolName ?? '?'} id=${c.toolCallId ?? '?'} ` +
              `promptN=${t?.prompt_n ?? '?'} cacheN=${t?.cache_n ?? '?'} promptMs=${
                t?.prompt_ms == null ? '?' : Math.round(t.prompt_ms)
              }`,
            'home-agent-diag',
          )
        }
        if (chunk.chunk.type === 'raw') {
          const rawValue = LlamaCppRawValueSchema.safeParse(chunk.chunk.rawValue)
          if (rawValue.success) {
            if (rawValue.data.timings) {
              timings = rawValue.data.timings
            }
            if (rawValue.data.usage) {
              // Usage rides the step's final chunk — the last look at its
              // timings before the AI SDK closes the call.
              if (timings) engineDeps?.noteTimings?.(timings)
              const u = rawValue.data.usage
              usageFromRawChunk = {
                inputTokens: u.prompt_tokens,
                outputTokens: u.completion_tokens,
                totalTokens: u.total_tokens,
                inputTokenDetails: {
                  noCacheTokens: undefined,
                  cacheReadTokens: undefined,
                  cacheWriteTokens: undefined,
                },
                outputTokenDetails: {},
              } as LanguageModelUsage
              if (!timings) {
                const now = Date.now()
                const promptMs = Math.max(
                  0,
                  firstTokenTime ? firstTokenTime - startOfRequestTime : 0,
                )
                const predictedMs = Math.max(
                  0,
                  firstTokenTime ? now - firstTokenTime : now - startOfRequestTime,
                )
                timings = {
                  cache_n: 0,
                  prompt_n: u.prompt_tokens,
                  prompt_ms: promptMs,
                  prompt_per_token_ms: u.prompt_tokens > 0 ? promptMs / u.prompt_tokens : 0,
                  prompt_per_second: promptMs > 0 ? (u.prompt_tokens / promptMs) * 1000 : 0,
                  predicted_n: u.completion_tokens,
                  predicted_ms: predictedMs,
                  predicted_per_token_ms:
                    u.completion_tokens > 0 ? predictedMs / u.completion_tokens : 0,
                  predicted_per_second:
                    predictedMs > 0 ? (u.completion_tokens / predictedMs) * 1000 : 0,
                }
              }
            }
          }
        }
        // Track per-block reasoning timing: the SDK reuses one reasoning ID
        // across tool-call cycles but never emits start/end, so a new block
        // is "reasoning resumed after other content".
        if (chunk.chunk.type === 'reasoning-delta') {
          if (!firstTokenTime) {
            firstTokenTime = Date.now()
          }
          const reasoningId = chunk.chunk.id
          const now = Date.now()
          let timing = reasoningTimings.get(reasoningId)
          if (!timing || reasoningInterrupted) {
            timing = { started: now, finished: now }
            reasoningTimings.set(reasoningId, timing)
          } else {
            timing.finished = now
          }
          reasoningInterrupted = false
          chunk.chunk.providerMetadata = {
            aipg: {
              reasoningStarted: timing.started,
              reasoningFinished: timing.finished,
            },
          }
        }
        if (chunk.chunk.type === 'text-delta') {
          if (!firstTokenTime) {
            firstTokenTime = Date.now()
          }
        }
      },

      onStepEnd: (step) => {
        if (haDiag) {
          diagStepIdx++
          const calls = step.toolCalls.map((c) => c.toolName).join(',') || 'none'
          const t = timings
          const ms = (v?: number) => (v == null ? '?' : Math.round(v))
          appLogger.info(
            `[HA-DIAG] step ${diagStepIdx} finishReason=${step.finishReason} ` +
              `inTok=${step.usage?.inputTokens ?? '?'} outTok=${step.usage?.outputTokens ?? '?'} ` +
              `promptN=${t?.prompt_n ?? '?'} cacheN=${t?.cache_n ?? '?'} promptMs=${ms(t?.prompt_ms)} ` +
              `predN=${t?.predicted_n ?? '?'} predMs=${ms(t?.predicted_ms)} ` +
              `toolCalls=${step.toolCalls.length} [${calls}] textLen=${step.text?.length ?? 0}`,
            'home-agent-diag',
          )
        }
      },

      onEnd: (result) => {
        finishTime = Date.now()
        if (haDiag) {
          appLogger.info(
            `[HA-DIAG] turn done steps=${diagStepIdx} wallMs=${finishTime - diagTurnStart} ` +
              `finalInTok=${result.usage?.inputTokens ?? '?'} finalOutTok=${
                result.usage?.outputTokens ?? '?'
              }`,
            'home-agent-diag',
          )
        }
        if (result.usage) {
          usage = result.usage
        } else if (usageFromRawChunk) {
          usage = usageFromRawChunk
        }
        if (!timings) {
          const effectiveUsage = result.usage ?? usageFromRawChunk
          const promptMs = Math.max(0, firstTokenTime ? firstTokenTime - startOfRequestTime : 0)
          const predictedMs = Math.max(
            0,
            firstTokenTime ? finishTime - firstTokenTime : finishTime - startOfRequestTime,
          )
          const inputTokens = effectiveUsage?.inputTokens ?? 0
          const outputTokens = effectiveUsage?.outputTokens ?? 0
          timings = {
            cache_n: effectiveUsage?.inputTokenDetails?.cacheReadTokens ?? 0,
            prompt_n: inputTokens,
            prompt_ms: promptMs,
            prompt_per_token_ms: inputTokens > 0 ? promptMs / inputTokens : 0,
            prompt_per_second: promptMs > 0 ? (inputTokens / promptMs) * 1000 : 0,
            predicted_n: outputTokens,
            predicted_ms: predictedMs,
            predicted_per_token_ms: outputTokens > 0 ? predictedMs / outputTokens : 0,
            predicted_per_second: predictedMs > 0 ? (outputTokens / predictedMs) * 1000 : 0,
          }
        }
      },

      onError: (error) => {
        appLogger.warn(`Chat turn failed: ${describeInferenceError(error)}`, 'electron-backend')
      },

      onToolExecutionEnd: async ({ toolCall, toolOutput }) => {
        await fillToolResultOutput(pendingToolExecutes, toolCall.toolCallId, toolOutput)
      },

      include: {
        rawChunks: true,
      },
    })

    const stream = patchUiToolOutputs(
      result.toUIMessageStream({
        onError: describeInferenceError,
        sendReasoning: true,
        // The id travels in the `start` chunk, so the assistant message main
        // persists and the one a resuming renderer builds from the replay are
        // the same message — which is what lets a later write find where the
        // submitted list joins the thread on disk.
        generateMessageId: () => `${turnId}-assistant`,
        messageMetadata: (options) => {
          // Returning undefined suppresses the SDK's per-part `message-metadata`
          // chunk: without this it enqueues one after every delta and raw part,
          // so no two deltas are ever adjacent and the bus coalescing could
          // never merge anything.
          if (
            options.part.type === 'text-delta' ||
            options.part.type === 'reasoning-delta' ||
            options.part.type === 'raw'
          ) {
            return undefined
          }
          if (options.part.type === 'finish-step') {
            lastStepUsage = options.part.usage
          }
          let effectiveUsage: LanguageModelUsage | undefined = undefined
          if (options.part.type === 'finish') {
            effectiveUsage = lastStepUsage ?? options.part.totalUsage
          }
          const compute =
            config.backend === 'cloud'
              ? undefined
              : computeWindowSince(computeTurnStartedAt, computeDeviceHint)
          const energyOutputTokens =
            options.part.type === 'finish' ? options.part.totalUsage.outputTokens : undefined
          const wattHours =
            CHAT_ENERGY_ESTIMATES_ENABLED && config.backend !== 'cloud' && energyOutputTokens
              ? computeEnergyWhSince(computeTurnStartedAt, computeDeviceHint)
              : undefined
          const energy =
            wattHours !== undefined && energyOutputTokens !== undefined && energyOutputTokens > 0
              ? { wattHours, outputTokens: energyOutputTokens }
              : undefined

          return {
            model: config.modelId,
            timestamp: Date.now(),
            timings,
            compute,
            energy,
            usage: effectiveUsage ?? usage,
          }
        },
      }),
      pendingToolExecutes,
    )

    const persistMessages = async (assistant: UIMessage | undefined) => {
      const messages: unknown[] = [...request.messages]
      if (assistant) messages.push(withRagSource(assistant, ragSourceText))
      await persistChatTurn(request, messages)
    }

    if (request.persist) {
      const [busStream, persistStream] = stream.tee()
      const persistTask = assembleAssistantFromStream(persistStream)
      try {
        for await (const chunk of busStream) {
          emitChatChunk(conversationKey, turnId, chunk)
        }
      } finally {
        await persistMessages(await persistTask)
      }
    } else {
      for await (const chunk of stream) {
        emitChatChunk(conversationKey, turnId, chunk)
      }
    }
  } catch (error) {
    // A user stop must not surface as an error chunk — the renderer's manual-
    // stop guard expects a clean stream end, same as the aborted fetch before
    // the move.
    if (!turn.controller.signal.aborted) {
      appLogger.error(`Chat turn crashed: ${describeInferenceError(error)}`, 'electron-backend')
      emitFailure({
        category: 'inference',
        code: 'inference/turn-failed',
        userMessage: describeInferenceError(error),
        surface: 'silent',
        context: { conversationKey },
      })
      emitChatChunk(conversationKey, turnId, {
        type: 'error',
        errorText: describeInferenceError(error),
      })
    }
  } finally {
    finishTextRequest(turnId)
    activeTurns.delete(conversationKey)
    endChatTurn(conversationKey, turnId)
  }
}
