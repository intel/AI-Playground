import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { Chat } from '@ai-sdk/vue'
import {
  APICallError,
  convertToModelMessages,
  type FileUIPart,
  DefaultChatTransport,
  generateText,
  LanguageModelUsage,
  NoSuchToolError,
  streamText,
  isStepCount,
  type ToolSet,
  UIDataTypes,
  UIMessage,
} from 'ai'
import { chatTraceContext, createChatModel } from '@/lib/chatModel'
import { useTextInference } from './textInference'
import { useBackendServices } from './backendServices'
import { useConversations, HOME_AGENT_CHAT_PRESET_NAME } from './conversations'
import { completeOrphanedToolParts, sanitizeBulkyToolOutputs } from './toolMessageSanitize'
import { useErrors } from './errors'
import { useActivities } from './activities'
import { useConfirmations } from './confirmations'
import { useI18N } from './i18n'
import { createAppError, extractMessage, isCancellation } from '../errors/appError'
import type { AppError } from '../errors/types'
import { aipgTools, homeAgentTools } from '../tools/tools'
import { getAvailableWorkflows, repairCreateToolInput } from '../tools/comfyUi'
import { getAvailableEditWorkflows, repairEditToolInput } from '../tools/comfyUiImageEdit'
import { slimMediaModelOutput, type MediaToolOutput } from '../tools/media'
import z from 'zod'
import { AipgTools } from '../tools/tools'
import { JSONSchema7 } from '@ai-sdk/provider'
import { dynamicTool, jsonSchema, type ToolResultOutput } from '@ai-sdk/provider-utils'
import { imageUrlToDataUri } from '@/lib/utils'
import { noteChatTimings, noteChatTraceContext } from '@/lib/laminarTelemetry'
import { useQwen3TextToSpeech } from './qwen3TextToSpeech'
import { useTextToSpeech } from './textToSpeech'
import { useSpeechToText } from './speechToText'
import { transcribeAudioBlob } from '@/lib/transcribe'
import * as toast from '@/assets/js/toast'
import { buildTtsAudioFileName, conversationLabelForTtsFile } from '@/lib/ttsAudioFileName'

// Web tools that share browseWeb's single "Browse the web" enablement toggle:
// they all act on the same background browser browseWeb drives.
const WEB_COMPANION_TOOLS = new Set(['searchWeb', 'interactWithWebPage', 'screenshotWebPage'])

// toUIMessageStreamResponse's default onError returns a generic "An error
// occurred." to avoid leaking server details to a browser client. Here the
// "server" is a loopback inference backend (llama.cpp / OVMS) in the same
// desktop app, so that default only hides the one thing we need: e.g. an OVMS
// HTTP 400 whose response body explains why a request was rejected. Surface the
// underlying status + body so failures are diagnosable (in the toast, the error
// ring buffer, and e2e smoke-test output) instead of an opaque "An error occurred."
function describeInferenceError(error: unknown): string {
  if (APICallError.isInstance(error)) {
    const body = typeof error.responseBody === 'string' ? error.responseBody.trim() : ''
    const detail = body || error.message
    const status = error.statusCode ? `HTTP ${error.statusCode}` : ''
    // Cap the body so a verbose backend error can't blow up the toast/log line.
    const capped = detail.length > 500 ? `${detail.slice(0, 500)}…` : detail
    return [status, capped].filter(Boolean).join(': ') || 'Inference request failed'
  }
  return extractMessage(error)
}

// Map opaque GPU/driver faults from the local inference backend to an actionable
// hint. A Vulkan `ErrorDeviceLost` (a.k.a. device-lost / TDR reset) means the GPU
// was torn down mid-decode — almost always a driver-level fault on Intel Arc
// (Battlemage / B-series), not user error. Surface what actually fixes it instead
// of leaving the raw `vk::Device::getFenceStatus: ErrorDeviceLost` string alone.
export function inferenceFailureHint(message: string): string | null {
  const lower = message.toLowerCase()
  if (
    lower.includes('devicelost') ||
    lower.includes('device lost') ||
    lower.includes('device_lost')
  ) {
    return 'The GPU was reset during generation. Update your GPU drivers to the latest version; if it keeps happening, reduce the context size or try a smaller model.'
  }
  return null
}

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

const LlamaCppRawValueSchema = z.object({
  choices: z.array(z.any()).optional(),
  created: z.number().optional(),
  id: z.string().optional(),
  model: z.string().optional(),
  system_fingerprint: z.string().optional(),
  object: z.string().optional(),
  usage: z
    .object({
      completion_tokens: z.number(),
      prompt_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
  timings: LlamaCppRawValueTimingsSchema.optional(),
})

export type AipgMetadata = {
  model?: string
  timestamp?: number
  conversationTitle?: string
  timings?: z.infer<typeof LlamaCppRawValueTimingsSchema>
  ragSource?: string
  usage?: LanguageModelUsage
}

export type AipgUiMessage = UIMessage<AipgMetadata, UIDataTypes, AipgTools>

export type GenerateOptions = {
  conversationKey?: string
  clearInputs?: boolean
  files?: FileUIPart[]
}

export const useOpenAiCompatibleChat = defineStore(
  'openAiCompatibleChat',
  () => {
    const textInference = useTextInference()
    const textToSpeech = useTextToSpeech()
    const speechToText = useSpeechToText()
    const backendServices = useBackendServices()
    const conversations = useConversations()
    const errors = useErrors()
    const activities = useActivities()
    const confirmations = useConfirmations()
    const i18nState = useI18N().state
    const manuallyStopped = ref(false)

    // True while the model is actively emitting reasoning (i.e. the last content
    // chunk was a reasoning delta and no text/tool chunk has followed). Driven
    // straight off the chunk stream so the UI never has to infer "is reasoning
    // still going?" from part positions or the per-delta `reasoningFinished`
    // timestamp (which is bumped to "now" on every delta and so always looks
    // recent). Cleared when the turn ends (see the `processing` safety-net watch).
    const reasoningInProgress = ref(false)
    // Wall-clock start of the reasoning block currently in progress. The part's
    // own `reasoningStarted` metadata isn't attached to the live (still-
    // streaming) UI part, so the chat view needs this to drive an increasing
    // "Reasoned for X.Xs" timer; once the block finishes the view falls back to
    // the part metadata. Updated to the block start whenever a new block begins.
    const reasoningStartedAt = ref(0)

    // Last failure per conversation, captured in the chat `onError` hook. Lets
    // callers (e.g. the Home Agent channel handlers) surface a turn's error even
    // though stream failures are swallowed by `onError` and `generate()` returns
    // normally. Cleared at the start of each turn and consumed via
    // `consumeTurnError`.
    const turnErrors = new Map<string, AppError>()

    // Per-conversation AI SDK chat instances. Declared up here (before the
    // `processing` computed and its safety-net watch below) because Vue evaluates
    // a watch's source getter once eagerly at setup time; reading `chats` from a
    // later `const` would otherwise hit the temporal dead zone ("Cannot access
    // 'chats' before initialization"). Populated lazily via getOrCreateChat().
    const chats: Record<string, Chat<AipgUiMessage>> = {}

    // In-flight `generate()` calls per conversation key. `generate()` awaits the
    // whole turn — backend/model prep, then `chat.sendMessage` (which for an
    // agentic turn resolves only after every step completes) — so this is the
    // authoritative "a turn is running" signal. The chat `status` alone is not:
    // it can momentarily read non-streaming between agentic steps and at the very
    // end before the final content is committed, which briefly flips the send/stop
    // control back to "Send" mid-turn (letting a second prompt be submitted into a
    // half-finished turn). A count (not a bool) tolerates re-entrancy.
    const generatingKeys = ref<Record<string, number>>({})
    function markGenerating(key: string): void {
      generatingKeys.value = {
        ...generatingKeys.value,
        [key]: (generatingKeys.value[key] ?? 0) + 1,
      }
    }
    function unmarkGenerating(key: string): void {
      const remaining = (generatingKeys.value[key] ?? 0) - 1
      const next = { ...generatingKeys.value }
      if (remaining > 0) next[key] = remaining
      else delete next[key]
      generatingKeys.value = next
    }

    const processing = computed(() => {
      // If manually stopped, immediately return false to unblock UI
      if (manuallyStopped.value) return false
      const key = conversations.activeKey
      // A running generate() keeps us busy for the entire turn, independent of any
      // transient chat-status dip between steps or before the last chunk settles.
      if ((generatingKeys.value[key] ?? 0) > 0) return true
      const status = chats[key]?.status
      return status === 'submitted' || status === 'streaming'
    })

    // Safety net: when the active turn ends (completes, is stopped, or errors
    // before onFinish), clear any lingering chat-scoped inference/tools activities
    // so the status line can't get stuck (mirrors the generation watchdog).
    watch(
      () => processing.value,
      (isProcessing, wasProcessing) => {
        if (wasProcessing && !isProcessing) {
          reasoningInProgress.value = false
          const key = conversations.activeKey
          activities.endScope(
            (a) =>
              a.scope.kind === 'chat' &&
              a.scope.conversationKey === key &&
              (a.category === 'inference' || a.category === 'tools'),
          )
          // Settle any confirmation still awaiting input for this turn as
          // declined, so a tool's execute() can never hang on a card the user
          // will never see again (stopped/errored/navigated-away turn).
          confirmations.cancelForConversation(key, false)
        }
      },
    )

    // Model construction (incl. cloud/Home-Agent routing, relaunch-retry and
    // stream tracking) lives in the shared factory so nested tool agents run
    // against the exact same endpoint/model. Reading store state inside the
    // computed keeps the reactive dependencies (backend, model, URL) intact.
    const model = computed(() => createChatModel())

    function isToolEnabled(toolName: string): boolean {
      const name = toolName.toLowerCase()
      // These blender tools fill up context, but still only work with separate api keys
      const excludedKeywords = ['hyper', 'rodin', 'sketchfab', 'hunyuan', 'polyhaven']
      return !excludedKeywords.some((keyword) => name.includes(keyword))
    }

    async function resolveTools(): Promise<ToolSet> {
      if (!textInference.modelSupportsToolCalling) return {}

      const builtinTools = resolveBuiltinTools()
      const mcpTools = await resolveMcpTools()
      return { ...builtinTools, ...mcpTools }
    }

    function resolveBuiltinTools(): ToolSet {
      if (!textInference.aipgToolsEnabled) return {}
      const tools: ToolSet = {}
      // With tool delegation on, the two heavy comfy tools are replaced by the
      // thin `media` tool (whose nested agent runs them internally, honoring
      // the same per-tool/per-workflow enablement); with it off, `media` is
      // dropped and the comfy tools are exposed directly as before.
      const delegationEnabled = textInference.toolDelegationEnabled
      const mediaDelegationAvailable =
        (textInference.isBuiltinToolEnabled('comfyUI') && getAvailableWorkflows().length > 0) ||
        (textInference.isBuiltinToolEnabled('comfyUiImageEdit') &&
          getAvailableEditWorkflows().length > 0)
      for (const [name, builtinTool] of Object.entries(aipgTools)) {
        if (name === 'media') {
          if (delegationEnabled && mediaDelegationAvailable) tools[name] = builtinTool
          continue
        }
        if (delegationEnabled && (name === 'comfyUI' || name === 'comfyUiImageEdit')) continue
        // searchWeb/interactWithWebPage/screenshotWebPage are companions to
        // browseWeb (they search for, act on, or capture a page in the same
        // background browser), so they all share the single "Browse the web" toggle.
        const enablementKey = WEB_COMPANION_TOOLS.has(name) ? 'browseWeb' : name
        // Per-tool enablement (off by default for opt-in tools like captureScreenshot).
        if (!textInference.isBuiltinToolEnabled(enablementKey)) continue
        // The screenshot tool needs a user-bound window and a vision-capable model
        // (the model receives the capture as an image and can't use it otherwise).
        if (
          name === 'captureScreenshot' &&
          (!textInference.screenshotWindow || !textInference.modelSupportsVision)
        ) {
          continue
        }
        // screenshotWebPage also delivers the page as an image, so it only makes
        // sense for vision-capable models.
        if (name === 'screenshotWebPage' && !textInference.modelSupportsVision) {
          continue
        }
        // Preset-backed tools with every workflow disabled (via the per-workflow
        // sub-checkboxes) would otherwise fall back to a generic "any workflow"
        // schema — skip them entirely so the model can't invoke a tool the user
        // effectively turned off.
        if (name === 'comfyUI' && getAvailableWorkflows().length === 0) continue
        if (name === 'comfyUiImageEdit' && getAvailableEditWorkflows().length === 0) continue
        // TTS is available when its selected engine is: Qwen3 (its own backend set
        // up) or Kokoro (OpenVINO installable / fallback configured).
        if (name === 'synthesizeTextToSpeech') {
          const qwenInfo = backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')
          const ttsReady =
            textToSpeech.selectedEngine === 'kokoro'
              ? textToSpeech.isKokoroAvailable
              : textToSpeech.selectedEngine === 'external'
                ? textToSpeech.isExternalAvailable
                : qwenInfo?.isSetUp === true
          if (!ttsReady) continue
        }
        // Offer the transcription tool whenever ANY engine can serve it (OpenVINO
        // Whisper, the standalone torch sidecar, or the external endpoint) — the
        // transcription path itself falls back to an installed engine via
        // `effectiveSttEngine`. Keying this off the selected engine hid the tool
        // from users whose persisted selection named an engine they never
        // installed, even though speech-to-text was usable.
        if (name === 'transcribeAudio' && !speechToText.available) continue
        tools[name] = builtinTool
      }
      // The Home Agent self-inspection/configuration tools are only meaningful
      // for the Home Agent preset; never expose them to ordinary chat presets.
      if (textInference.activePreset?.name === HOME_AGENT_CHAT_PRESET_NAME) {
        Object.assign(tools, homeAgentTools)
      }
      return tools
    }

    async function resolveMcpInstructions(): Promise<string> {
      if (!textInference.mcpToolsEnabled) return ''

      let servers: Awaited<ReturnType<typeof window.electronAPI.mcp.listServers>>
      try {
        servers = await window.electronAPI.mcp.listServers()
      } catch (error) {
        console.error('Failed to list MCP servers for instructions:', error)
        return ''
      }

      const blocks: string[] = []
      for (const server of servers) {
        const trimmed = server.instructions?.trim()
        if (!trimmed) continue
        let status: Awaited<ReturnType<typeof window.electronAPI.mcp.getServerStatus>>
        try {
          status = await window.electronAPI.mcp.getServerStatus(server.id)
        } catch (error) {
          console.error(`Failed to get MCP server status for ${server.id}:`, error)
          continue
        }
        if (status.state !== 'running') continue
        blocks.push(`## MCP server: ${server.name}\n${trimmed}`)
      }

      if (blocks.length === 0) return ''
      return `\n\n# MCP server instructions\n\n${blocks.join('\n\n')}`
    }

    async function resolveMcpTools(): Promise<ToolSet> {
      if (!textInference.mcpToolsEnabled) return {}

      const resolvedTools: ToolSet = {}
      let servers: Awaited<ReturnType<typeof window.electronAPI.mcp.listServers>>
      try {
        servers = await window.electronAPI.mcp.listServers()
      } catch (error) {
        console.error('Failed to list MCP servers:', error)
        return {}
      }

      for (const server of servers) {
        let status: Awaited<ReturnType<typeof window.electronAPI.mcp.getServerStatus>>
        try {
          status = await window.electronAPI.mcp.getServerStatus(server.id)
        } catch (error) {
          console.error(`Failed to get MCP server status for ${server.id}:`, error)
          continue
        }
        if (status.state !== 'running') {
          continue
        }

        let allMcpTools: Awaited<ReturnType<typeof window.electronAPI.mcp.listServerTools>>
        try {
          allMcpTools = await window.electronAPI.mcp.listServerTools(server.id)
        } catch (error) {
          console.error(`Failed to list MCP tools for ${server.id}:`, error)
          continue
        }
        const mcpTools = allMcpTools.filter((t) => isToolEnabled(t.name))

        for (const mcpTool of mcpTools) {
          const aiToolName = `mcp__${server.id}__${mcpTool.name}`
          resolvedTools[aiToolName] = dynamicTool({
            description: mcpTool.description || `${server.name} tool: ${mcpTool.name}`,
            inputSchema: jsonSchema({
              ...mcpTool.inputSchema,
              properties: mcpTool.inputSchema.properties ?? {},
              additionalProperties: false,
            } as JSONSchema7),
            execute: async (input) => {
              const args = input as Record<string, unknown>
              return await activities.track(
                {
                  category: 'tools',
                  label: i18nState.COM_ACTIVITY_RUNNING_TOOL.replace('{tool}', mcpTool.name),
                  scope: { kind: 'chat', conversationKey: conversations.activeKey },
                },
                () => window.electronAPI.mcp.invokeServerTool(server.id, mcpTool.name, args),
              )
            },
          }) as ToolSet[string]
        }
      }

      return resolvedTools
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const customFetch = async (_: any, options: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = JSON.parse(options.body) as any
      // Read and strip per-request conversation key injected by DefaultChatTransport's
      // body, so the upstream request stays a clean OpenAI-compatible payload.
      const requestConversationKey: string | undefined =
        typeof m._aipgConversationKey === 'string' ? m._aipgConversationKey : undefined
      delete m._aipgConversationKey
      const reasoningTimings = new Map<string, { started: number; finished: number }>()
      // A reasoning block is a contiguous run of reasoning deltas. It ends the
      // moment any non-reasoning content (text/tool) arrives; the next reasoning
      // delta then starts a fresh block. Using "was reasoning interrupted?"
      // instead of a time-gap heuristic keeps slow models — whose reasoning
      // tokens can be >100ms apart — from resetting the block on every token
      // (which collapsed the displayed elapsed time to ~0.0s).
      let reasoningInterrupted = true
      const startOfRequestTime: number = Date.now()
      let firstTokenTime: number = 0
      let finishTime: number = 0
      let timings: z.infer<typeof LlamaCppRawValueTimingsSchema> | undefined = undefined
      let usage: LanguageModelUsage | undefined = undefined
      let usageFromRawChunk: LanguageModelUsage | undefined = undefined
      let lastStepUsage: LanguageModelUsage | undefined = undefined
      const perConversationPrompt = requestConversationKey
        ? temporarySystemPrompts[requestConversationKey]
        : null
      const baseSystemPrompt = perConversationPrompt || textInference.systemPrompt
      const activityScope = {
        kind: 'chat' as const,
        conversationKey: requestConversationKey ?? conversations.activeKey,
      }
      const mcpInstructions = await activities.track(
        { category: 'tools', label: i18nState.COM_ACTIVITY_PREPARING_TOOLS, scope: activityScope },
        () => resolveMcpInstructions(),
      )
      const systemPromptToUse = `${baseSystemPrompt}${mcpInstructions}`
      // Self-heal orphaned tool calls (interrupted/stopped turns, HMR) before
      // converting: an assistant tool-call with no matching result would make
      // convertToModelMessages/streamText throw "Tool result is missing …" and
      // brick the thread. See toolMessageSanitize.ts.
      let messages = await convertToModelMessages(
        sanitizeBulkyToolOutputs(completeOrphanedToolParts(m.messages)),
      )
      // [HA-DIAG] Temporary: gate perf logging to Home Agent turns. Declared here
      // (not at the streamText callbacks) so the earlier image-trim block can log.
      const haDiag = textInference.activePreset?.name === HOME_AGENT_CHAT_PRESET_NAME

      // Convert aipg-media image URLs to base64 for the backend (can be slow for
      // large images), so surface it as an activity when there is anything to do.
      const hasMediaToConvert = messages.some(
        (msg) =>
          msg.role === 'user' &&
          Array.isArray(msg.content) &&
          msg.content.some(
            (part) =>
              part.type === 'file' &&
              typeof part.data === 'string' &&
              part.data.startsWith('aipg-media://'),
          ),
      )
      const convertMedia = async () =>
        Promise.all(
          messages.map(async (msg) => {
            if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg
            const content = await Promise.all(
              msg.content.map(async (part) => {
                if (
                  part.type === 'file' &&
                  part.mediaType?.startsWith('image/') &&
                  typeof part.data === 'string' &&
                  part.data.startsWith('aipg-media://')
                ) {
                  return { ...part, data: await imageUrlToDataUri(part.data) }
                }
                return part
              }),
            )
            return { ...msg, content }
          }),
        )
      messages = hasMediaToConvert
        ? await activities.track(
            {
              category: 'tools',
              label: i18nState.COM_ACTIVITY_READING_IMAGES,
              scope: activityScope,
            },
            convertMedia,
          )
        : await convertMedia()

      // Filter out annotatedImageUrl json from tool results
      messages = messages.map((m) => {
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
              const value = part.output.value as MediaToolOutput | null
              if (value && Array.isArray(value.images)) {
                return {
                  ...part,
                  output: slimMediaModelOutput(value) as ToolResultOutput,
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

      // Screenshot tool results carry the capture as a data URI. The OpenAI-compatible
      // provider JSON.stringifies a tool result's value into the tool message text, so
      // the raw base64 would be sent as text (the model can't "see" it and the context
      // explodes). Instead, replace the tool result with a short text and inject the
      // capture as a real vision image in a following user message — the same path that
      // user-uploaded images take (and which the backend actually supports).
      type ChatModelMessage = (typeof messages)[number]
      messages = messages.flatMap((m): ChatModelMessage[] => {
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
        const rewritten = { ...m, content } as ChatModelMessage
        if (injectedImages.length === 0) return [rewritten]
        const imageMessage = {
          role: 'user',
          content: [
            { type: 'text', text: 'Here is the captured screenshot to inspect:' },
            ...injectedImages.map((img) => ({
              type: 'file' as const,
              mediaType: img.mediaType,
              data: img.data,
            })),
          ],
        } as ChatModelMessage
        return [rewritten, imageMessage]
      })

      // Filter out image parts from messages if model doesn't support vision
      if (!textInference.modelSupportsVision) {
        messages = messages.map((msg) => {
          if (msg.role === 'user' && Array.isArray(msg.content)) {
            const filteredContent = msg.content.filter((part) => part.type === 'text')
            // If all content was images, keep at least an empty text
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

      // Keep only the most recent images in the prompt. A vision model re-encodes
      // (CLIP) every image in the history on every turn, so replaying old images
      // makes each turn progressively slower as the conversation grows. Scan from
      // the newest message backwards, keep the first MAX_HISTORY_IMAGES found, and
      // replace all earlier ones with a short text placeholder. No-op without
      // vision (images were already stripped above) or when there are at most that
      // many images.
      const MAX_HISTORY_IMAGES = 2
      if (textInference.modelSupportsVision) {
        let keptImages = 0
        let droppedImages = 0
        for (let i = messages.length - 1; i >= 0; i--) {
          const content = messages[i].content
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
          if (changed)
            messages[i] = { ...messages[i], content: newContent } as (typeof messages)[number]
        }
        if (haDiag && (keptImages || droppedImages)) {
          console.log(`[HA-DIAG] images kept=${keptImages} droppedFromHistory=${droppedImages}`)
        }
      }

      // Only enable tools if model supports tool calling and tools are enabled
      const availableTools = await activities.track(
        { category: 'tools', label: i18nState.COM_ACTIVITY_PREPARING_TOOLS, scope: activityScope },
        () => resolveTools(),
      )
      const hasTools = Object.keys(availableTools).length > 0

      // Surface the silent inference waits as an activity: before the first token the
      // backend is prefilling the prompt/context ("Processing prompt…"); after a tool
      // runs the model incorporates its output before continuing ("Processing
      // results…"). Cleared on first content / tool call, re-armed after tool results.
      // (Genuine chain-of-thought surfaces inline via reasoning-delta, which clears
      // this — we are not relabelling real reasoning.)
      let inferenceActivityId: string | null = null
      let sawToolResult = false
      const ensureInferenceActivity = () => {
        if (!inferenceActivityId) {
          inferenceActivityId = activities.begin({
            category: 'inference',
            label: sawToolResult
              ? i18nState.COM_ACTIVITY_PROCESSING_RESULTS
              : i18nState.COM_ACTIVITY_PROCESSING_PROMPT,
            scope: activityScope,
          })
        }
      }
      const clearInferenceActivity = () => {
        if (inferenceActivityId) {
          activities.end(inferenceActivityId)
          inferenceActivityId = null
        }
      }
      ensureInferenceActivity()

      // ── [HA-DIAG] Temporary Home Agent perf diagnostics ───────────────────
      // Per-turn model + tool surface + prompt size, then per-step prefill
      // timings and which tools were called. Metadata only — no prompt/response
      // content. (`haDiag` is declared just after convertToModelMessages above.)
      const diagTurnStart = Date.now()
      let diagStepIdx = 0
      if (haDiag) {
        const toolNames = Object.keys(availableTools)
        console.log(
          `[HA-DIAG] turn start model=${textInference.activeModel} backend=${textInference.backend} ` +
            `tools=${toolNames.length} [${toolNames.join(',')}] ` +
            `systemPromptChars=${systemPromptToUse.length} inputMsgs=${messages.length} stepCap=20`,
        )
      }

      // Surfaced to each tool's execute() via its `contextSchema` (see
      // toolContext.ts) so tools (e.g. configureHomeAgent) know which
      // conversation/channel they are running in. Keyed per tool name as v7's
      // `toolsContext` requires; extra keys for tools without a contextSchema
      // are ignored. `availableTools` is a plain ToolSet (tools are resolved
      // dynamically), so the per-tool context typing can't be inferred here —
      // hence the cast.
      const toolsContext = Object.fromEntries(
        Object.keys(availableTools).map((name) => [
          name,
          { conversationKey: requestConversationKey ?? conversations.activeKey },
        ]),
      ) as never

      // Which backend, on what device, thinking or not — the facts a trace of
      // this turn needs and the AI SDK has no field for. Built from the same
      // helpers that build the request body, so it cannot claim something the
      // model was never sent. No-op unless a developer opted into tracing.
      noteChatTraceContext(chatTraceContext())

      const result = await streamText({
        model: model.value,
        messages,
        abortSignal: options.signal,
        instructions: systemPromptToUse,
        // Bounded by the model's window, not the raw setting — a preset's
        // `maxNewTokens` routinely exceeds what a small model can hold, and OVMS
        // rejects the whole turn for it. See `effectiveMaxTokens`.
        maxOutputTokens: textInference.effectiveMaxTokens,
        temperature: textInference.temperature,

        ...(hasTools
          ? {
              tools: availableTools,
              stopWhen: isStepCount(20),
              toolsContext,
              // Repair a comfy image tool call whose `workflow` the model omitted
              // or set to an unknown value: coerce it to that tool's default
              // workflow. Without this the SDK drops the bad call and the chat
              // renders an "unknown preset" card / failed generation.
              experimental_repairToolCall: async ({ toolCall, error }) => {
                if (NoSuchToolError.isInstance(error)) return null
                const repaired =
                  toolCall.toolName === 'comfyUiImageEdit'
                    ? repairEditToolInput(toolCall.input)
                    : toolCall.toolName === 'comfyUI'
                      ? repairCreateToolInput(toolCall.input)
                      : null
                if (repaired === null) return null
                return { ...toolCall, input: repaired }
              },
            }
          : {}),

        onChunk: (chunk) => {
          // Drive the inference activity: content/tool-call means the model is no
          // longer waiting; a tool result means it will process that output next.
          const chunkType = chunk.chunk.type
          if (haDiag && (chunkType === 'tool-call' || chunkType === 'tool-result')) {
            const c = chunk.chunk as { toolName?: string; toolCallId?: string }
            // Prefill stats (promptN/cacheN/promptMs) are stable once prefill is
            // done, so they're accurate here even though onStepFinish (which has
            // the full step line) is delayed by tool execution on tool turns.
            const t = timings
            console.log(
              `[HA-DIAG] ${chunkType} tool=${c.toolName ?? '?'} id=${c.toolCallId ?? '?'} ` +
                `promptN=${t?.prompt_n ?? '?'} cacheN=${t?.cache_n ?? '?'} promptMs=${t?.prompt_ms == null ? '?' : Math.round(t.prompt_ms)}`,
            )
          }
          if (
            chunkType === 'text-delta' ||
            chunkType === 'reasoning-delta' ||
            chunkType === 'tool-call' ||
            chunkType === 'tool-input-start'
          ) {
            clearInferenceActivity()
          } else if (chunkType === 'tool-result') {
            sawToolResult = true
            ensureInferenceActivity()
          }
          // Track whether reasoning is the model's current output. Any non-
          // reasoning content chunk closes the open reasoning block.
          if (chunkType === 'reasoning-delta') {
            reasoningInProgress.value = true
          } else if (
            chunkType === 'text-delta' ||
            chunkType === 'tool-call' ||
            chunkType === 'tool-input-start' ||
            chunkType === 'tool-result'
          ) {
            reasoningInProgress.value = false
            reasoningInterrupted = true
          }
          if (chunk.chunk.type === 'raw') {
            const rawValue = LlamaCppRawValueSchema.safeParse(chunk.chunk.rawValue)
            if (rawValue.success) {
              if (rawValue.data.timings) {
                timings = rawValue.data.timings
              }
              if (rawValue.data.usage) {
                // Usage rides the step's final chunk, so this is the last look
                // at its timings before the AI SDK closes the call — and the
                // point where a trace can still be given the real numbers.
                if (timings) noteChatTimings(timings)
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
          // Track per-block reasoning timing. The SDK reuses the same reasoning ID (e.g., "reasoning-0")
          // across multiple tool call cycles, but onChunk never receives reasoning-start/reasoning-end.
          // A new block begins whenever reasoning resumes after being interrupted by other content
          // (text/tool); otherwise we extend the open block by bumping its `finished` timestamp.
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
              reasoningStartedAt.value = now
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
            // `timings` (captured from llama.cpp raw chunks in onChunk) holds the
            // just-finished step's numbers. promptN/promptMs = prefill size/time;
            // cacheN = prefix tokens reused from the prompt cache (high = good);
            // predN/predMs = tokens decoded and decode time. promptMs >> predMs with
            // low cacheN means we are re-prefilling the whole history every step.
            const t = timings
            const ms = (v?: number) => (v == null ? '?' : Math.round(v))
            console.log(
              `[HA-DIAG] step ${diagStepIdx} finishReason=${step.finishReason} ` +
                `inTok=${step.usage?.inputTokens ?? '?'} outTok=${step.usage?.outputTokens ?? '?'} ` +
                `promptN=${t?.prompt_n ?? '?'} cacheN=${t?.cache_n ?? '?'} promptMs=${ms(t?.prompt_ms)} ` +
                `predN=${t?.predicted_n ?? '?'} predMs=${ms(t?.predicted_ms)} ` +
                `toolCalls=${step.toolCalls.length} [${calls}] textLen=${step.text?.length ?? 0}`,
            )
          }
          // After a step that ran tool(s), the model processes their output before the
          // next step's first token. Re-arm so that inter-step gap (e.g. the chat
          // backend reloading after an image tool) isn't silent. Cleared on the next
          // text/reasoning delta; the final step has no tool calls so it won't re-arm,
          // and onFinish clears any straggler.
          if (step.toolCalls.length > 0 || step.toolResults.length > 0) {
            sawToolResult = true
            ensureInferenceActivity()
          }
        },

        onEnd: (result) => {
          finishTime = Date.now()
          reasoningInProgress.value = false
          if (haDiag) {
            console.log(
              `[HA-DIAG] turn done steps=${diagStepIdx} wallMs=${finishTime - diagTurnStart} ` +
                `finalInTok=${result.usage?.inputTokens ?? '?'} finalOutTok=${result.usage?.outputTokens ?? '?'}`,
            )
          }
          clearInferenceActivity()
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
        onError: () => {
          // streamText does NOT call onFinish when the stream errors (e.g. a
          // provider rejects a tool schema with HTTP 400 before the first token).
          // Without this, the inference activity armed above (ensureInferenceActivity)
          // stays open forever and the UI is wedged showing "Processing prompt…"
          // until the whole app is restarted — restarting only the backend can't
          // clear renderer-side activity state. Mirror onFinish's teardown so any
          // pre-first-token failure settles cleanly. The Chat's own onError hook
          // still reports the error to the user (toast) and preserves the prompt
          // for retry.
          reasoningInProgress.value = false
          clearInferenceActivity()
        },

        include: {
          rawChunks: true,
        },
      })

      return result.toUIMessageStreamResponse({
        onError: describeInferenceError,
        sendReasoning: true,
        messageMetadata: (options) => {
          if (options.part.type === 'text-delta' || options.part.type === 'reasoning-delta') {
            return {}
          }

          if (options.part.type === 'finish-step') {
            lastStepUsage = options.part.usage
          }

          let effectiveUsage: LanguageModelUsage | undefined = undefined
          if (options.part.type === 'finish') {
            effectiveUsage = lastStepUsage ?? options.part.totalUsage
          }

          return {
            model: textInference.activeModel,
            timestamp: Date.now(),
            timings,
            usage: effectiveUsage ?? usage,
          }
        },
      })
    }

    function getOrCreateChat(conversationKey: string): Chat<AipgUiMessage> {
      const existing = chats[conversationKey]
      if (existing) return existing
      conversations.ensureConversationBucket(conversationKey)
      const chat = new Chat<AipgUiMessage>({
        transport: new DefaultChatTransport({
          fetch: customFetch,
          // Tag every request with its conversation key so `customFetch` can look up
          // the per-conversation `temporarySystemPrompts` entry. Stripped before
          // forwarding upstream.
          body: { timings_per_token: true, _aipgConversationKey: conversationKey },
        }),
        messages: conversations.conversationList[conversationKey],
        // Single sink for streaming/transport/tool failures. Surface a toast only
        // for the conversation the user is actively looking at; background threads
        // (e.g. Home Agent side-channels) are recorded silently here and reported
        // to their own channel in the deferred channel phase. A manual stop is not
        // an error.
        onError: (error) => {
          if (manuallyStopped.value) return
          const isActiveDesktop = conversationKey === conversations.activeKey
          const detail = extractMessage(error)
          const hint = inferenceFailureHint(detail)
          turnErrors.set(
            conversationKey,
            errors.report(error, {
              category: 'inference',
              code: 'inference/stream-failed',
              userMessage: hint
                ? `Generation failed: ${detail}. ${hint}`
                : `Generation failed: ${detail}`,
              surface: isActiveDesktop ? 'toast' : 'silent',
              context: { conversationKey },
            }),
          )
        },
      })
      chats[conversationKey] = chat
      return chat
    }

    watch(
      () => conversations.activeKey,
      (activeKey) => {
        if (!activeKey) return
        getOrCreateChat(activeKey)
      },
      { immediate: true },
    )

    const messages = computed(() => chats[conversations.activeKey]?.messages)

    const contextUsage = computed(() => {
      const lastAssistantMessage = messages.value?.findLast((m) => m.metadata?.usage)
      return lastAssistantMessage?.metadata?.usage
    })

    const usedTokens = computed(() => {
      return (contextUsage.value?.inputTokens ?? 0) + (contextUsage.value?.outputTokens ?? 0)
    })

    const messageInput = ref('')
    const fileInput = ref<FileUIPart[]>([])
    // Per-conversation temporary system prompts (e.g. RAG-augmented system prompt for the
    // current turn). Keyed by conversationKey so concurrent generate() calls — desktop
    // chat and Home Agent side-channel — cannot leak each other's prompt.
    const temporarySystemPrompts: Record<string, string | null> = {}

    function getMessagesForKey(conversationKey: string): AipgUiMessage[] | undefined {
      // Prefer live chat instance state when present; otherwise fall back to the
      // persisted bucket so threads that exist in `conversationList` but haven't
      // been opened yet (e.g. Home Agent threads listed via `/history`) still
      // return their messages.
      const fromChat = chats[conversationKey]?.messages
      if (fromChat) return fromChat
      return conversations.conversationList[conversationKey]
    }

    /**
     * One-shot non-tool generation that turns a snippet of conversation text
     * into a 5-word-or-less summary. Reuses the same `model` wiring as the
     * normal chat (so the X-Upstream-Url header is preserved when Home Agent
     * is active and the active model is whatever `textInference` resolved).
     *
     * Caller is responsible for ensuring backend readiness (e.g. via
     * `textInference.ensureReadyForInference()`).
     */
    async function summarizeMessages(messagesText: string): Promise<string> {
      try {
        const { text } = await generateText({
          model: model.value,
          prompt:
            'Summarize this conversation in 5 words or less. ' +
            'Output only the summary, no quotes, no punctuation.\n\n' +
            messagesText,
          maxOutputTokens: 24,
        })
        return text.trim().split(/\s+/).slice(0, 5).join(' ')
      } catch (error) {
        console.error('summarizeMessages failed:', error)
        return ''
      }
    }

    /**
     * Direct Text-to-Speech turn (no LLM). Used when the active preset is a TTS
     * preset: synthesize the typed text with Qwen3-TTS and append the same
     * `tool-synthesizeTextToSpeech` assistant part the agentic tool emits, so the
     * chat renders a ChatTtsToolResult audio bubble. Voice/language/mode come from
     * the shared qwen3TextToSpeech store (edited in SettingsTts).
     */
    async function synthesizeDirect(
      question: string,
      targetKey: string,
      opts: {
        clearInputs: boolean
        sideChannel: boolean
        /** Regenerate: the user's message is already in the thread — don't duplicate it. */
        keepExistingUserMessage?: boolean
      },
    ): Promise<void> {
      const qwen3 = useQwen3TextToSpeech()
      const engine = textToSpeech.selectedEngine
      const chat = getOrCreateChat(targetKey)

      // Show the user's message right away so the turn isn't blank while we
      // synthesize — this path has no streaming LLM to fill the bubble, and the
      // audio can take a while to generate.
      if (!opts.keepExistingUserMessage) {
        const userMessage = {
          id: crypto.randomUUID(),
          role: 'user',
          parts: [{ type: 'text', text: question }],
          metadata: { timestamp: Date.now() },
        } as unknown as AipgUiMessage
        chat.messages.push(userMessage)
        conversations.updateConversation(chat.messages, targetKey)
      }
      if (opts.clearInputs) {
        messageInput.value = ''
        fileInput.value = []
      }

      // Surface progress while synthesizing: "Loading voice model…" (first use /
      // backend start) then "Generating audio file…". The standalone
      // ChatActivityIndicator renders this because the last message is the user's
      // (no assistant bubble exists yet). Begin the activity FIRST (before the
      // isModelLoaded probe and backend start, both of which can take a moment),
      // so the indicator is visible for the whole load — matching how other
      // backends show "Loading AI Model" from the start of the turn.
      const ttsScope = { kind: 'chat' as const, conversationKey: targetKey }
      // Qwen3 may need to load a per-voice model first; Kokoro (OVMS) / external
      // only ever show the "generating" phase.
      const alreadyLoaded = engine !== 'qwen3' ? true : await qwen3.isModelLoaded()
      const ttsActivityId = activities.begin({
        category: 'tools',
        label: 'Loading voice model…',
        scope: ttsScope,
      })

      let output: {
        ok: boolean
        message: string
        savedFilePath: string
        speaker: string
        language: string
        mode: string
      }
      try {
        const label = conversationLabelForTtsFile({
          conversationKey: targetKey,
          messages: getMessagesForKey(targetKey),
          threadMeta: conversations.getThreadMeta(targetKey),
        })
        const fileName = buildTtsAudioFileName({
          conversationKey: targetKey,
          conversationLabel: label,
        })
        if (engine !== 'qwen3') {
          const { audioBase64, voice } = await textToSpeech.synthesizeToWav(question)
          const savedFilePath = await qwen3.saveWavToDisk(audioBase64, fileName)
          const engineLabel = engine === 'kokoro' ? 'Kokoro' : 'the external endpoint'
          output = {
            ok: true,
            message: `Synthesized speech with ${engineLabel} (${voice}).`,
            savedFilePath,
            speaker: voice,
            language: '',
            mode: 'custom_voice',
          }
        } else {
          if (!alreadyLoaded) {
            await qwen3.ensureModelLoaded()
            activities.update(ttsActivityId, { label: 'Generating audio file…' })
          }
          const result = await qwen3.synthesize({ text: question })
          const savedFilePath = await qwen3.saveWavToDisk(result.audioBase64, fileName)
          output = {
            ok: true,
            message: `Synthesized ${result.mode} speech (${result.language}, ${result.speaker}).`,
            savedFilePath,
            speaker: result.speaker,
            language: result.language,
            mode: result.mode,
          }
        }
      } catch (error) {
        errors.report(error, {
          category: 'inference',
          code: 'inference/tts-failed',
          userMessage: `Text To Speech failed: ${extractMessage(error)}`,
          surface: opts.sideChannel ? 'silent' : 'toast',
          context: { conversationKey: targetKey },
        })
        // Fall through and record the failure as the turn's result rather than
        // returning here. A toast is the only thing this path used to leave behind,
        // and it fades — so a synthesis that died in the sidecar (an Intel XPU
        // `UR_RESULT_ERROR_DEVICE_LOST` mid-generation, say) left the thread showing
        // the user's message with nothing under it and no way to tell whether it had
        // failed or was still working. ChatTtsToolResult already renders `ok: false`
        // as an error line; nothing had ever produced one.
        const hint = inferenceFailureHint(extractMessage(error))
        output = {
          ok: false,
          message: `Text To Speech failed: ${extractMessage(error)}${hint ? ` — ${hint}` : ''}`,
          savedFilePath: '',
          speaker: '',
          language: '',
          mode: '',
        }
      } finally {
        activities.end(ttsActivityId)
      }

      // Cast to the message type: the AI SDK's inferred tool-UI-part shape is wider
      // than what we construct by hand, but this part mirrors exactly what the tool
      // produces (see synthesizeTextToSpeech + toolMessageSanitize fixtures).
      const assistantMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        parts: [
          {
            type: 'tool-synthesizeTextToSpeech',
            toolCallId: crypto.randomUUID(),
            state: 'output-available',
            input: { text: question },
            output,
          },
        ],
        metadata: {
          model:
            engine === 'kokoro' ? 'Kokoro' : engine === 'external' ? 'External TTS' : 'Qwen TTS',
          timestamp: Date.now(),
        },
      } as unknown as AipgUiMessage
      chat.messages.push(assistantMessage)
      conversations.updateConversation(chat.messages, targetKey)
    }

    /**
     * Regenerate an audio turn in a TTS thread: drop the audio message (and
     * anything after it) and synthesize the same prompt again, keeping the user's
     * message in place. No LLM is involved — a TTS thread has no chat model.
     */
    async function regenerateSynthesis(messageId: string, targetKey: string): Promise<void> {
      const chat = getOrCreateChat(targetKey)
      const targetIdx = chat.messages.findIndex((m) => m.id === messageId)
      if (targetIdx < 0) return
      const priorUserMessage = [...chat.messages.slice(0, targetIdx)]
        .reverse()
        .find((m) => m.role === 'user')
      const question =
        priorUserMessage?.parts
          ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('\n\n')
          .trim() ?? ''
      if (!question) return

      // A previous Stop leaves `manuallyStopped` set, which would keep `processing`
      // false for this turn and let the UI accept a second submission mid-synthesis.
      manuallyStopped.value = false
      markGenerating(targetKey)
      try {
        // Drop the old audio turn first so the retry replaces it rather than
        // appending a second player under the same prompt.
        chat.messages.splice(targetIdx, chat.messages.length - targetIdx)
        conversations.updateConversation(chat.messages, targetKey)
        await synthesizeDirect(question, targetKey, {
          clearInputs: false,
          sideChannel: false,
          keepExistingUserMessage: true,
        })
      } finally {
        unmarkGenerating(targetKey)
      }
    }

    /**
     * Append a completed speech-to-text turn to a conversation: a lightweight user
     * "audio" message (label only) followed by an assistant message holding the
     * transcript text. Used by the STT preset for both the recorded-mic path (where
     * the audio recorder already produced the transcript) and the upload path.
     *
     * An empty transcript (silence, or an unintelligible clip) is not appended: a
     * blank assistant bubble tells the user nothing about what went wrong. Both
     * callers can produce one, so the check lives here — the user is told instead,
     * matching what the Home Agent replies on the remote voice path.
     */
    function appendTranscriptTurn(
      transcript: string,
      targetKey: string,
      sourceLabel?: string,
    ): void {
      if (!transcript.trim()) {
        toast.warning("Couldn't make out any speech in that audio. Please try again.")
        return
      }
      const chat = getOrCreateChat(targetKey)
      const userMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        parts: [{ type: 'text', text: sourceLabel ?? '🎤 Audio input' }],
        metadata: { timestamp: Date.now() },
      } as unknown as AipgUiMessage
      const assistantMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        parts: [{ type: 'text', text: transcript }],
        metadata: { model: 'Whisper', timestamp: Date.now() },
      } as unknown as AipgUiMessage
      chat.messages.push(userMessage, assistantMessage)
      conversations.updateConversation(chat.messages, targetKey)
    }

    /**
     * Direct Speech-to-Text turn (no LLM). Used when the active preset is an STT
     * preset and the user uploads an audio file: transcribe it with the OVMS Whisper
     * server (or the configured fallback) and append the transcript as a chat turn.
     * The recorded-mic path reuses the audio recorder's own transcription and calls
     * {@link appendTranscriptTurn} directly instead.
     */
    async function transcribeDirect(
      blob: Blob,
      opts?: { conversationKey?: string; sourceLabel?: string },
    ): Promise<void> {
      const targetKey = opts?.conversationKey ?? conversations.activeKey
      const scope = { kind: 'chat' as const, conversationKey: targetKey }
      const activityId = activities.begin({
        category: 'tools',
        label: 'Transcribing audio…',
        scope,
      })
      try {
        // Ready the selected engine before resolving the endpoint: OVMS Whisper or
        // the standalone torch sidecar (both may prompt a model download on first
        // use); the External engine needs nothing started.
        if (speechToText.effectiveSttEngine === 'whisper') {
          await speechToText.ensureWhisperReady()
        } else if (speechToText.effectiveSttEngine === 'standalone') {
          await speechToText.ensureStandaloneReady()
        }
        const endpoint = await speechToText.resolveTranscription()
        if (!endpoint) {
          throw new Error(
            'Speech To Text is not available (no OVMS server or fallback configured).',
          )
        }
        const text = await transcribeAudioBlob(blob, endpoint)
        // Silence / no recognizable speech is handled inside appendTranscriptTurn.
        appendTranscriptTurn(text, targetKey, opts?.sourceLabel)
      } catch (error) {
        errors.report(error, {
          category: 'inference',
          code: 'inference/stt-failed',
          userMessage: `Speech To Text failed: ${extractMessage(error)}`,
          surface: 'toast',
          context: { conversationKey: targetKey },
        })
      } finally {
        activities.end(activityId)
      }
    }

    async function generate(question: string, options?: GenerateOptions) {
      const sideChannel = options?.conversationKey !== undefined
      const targetKey = sideChannel ? options.conversationKey! : conversations.activeKey
      const clearInputs = options?.clearInputs ?? !sideChannel

      // Mark the turn in flight for its whole duration (prep + all stream steps),
      // so `processing` stays true until the turn genuinely finishes. Cleared in
      // `finally` so a thrown/aborted turn can never leave the UI stuck busy.
      markGenerating(targetKey)
      try {
        // 1a. Reactivate the target thread's preset (if any) so the stream uses
        //     the right model/tools/system-prompt for THIS conversation, not
        //     whatever was last selected for an unrelated chat. For Home Agent
        //     threads this pins the bundled Home Agent preset.
        textInference.ensureGlobalsMatchConversation(targetKey)

        // 1b. Stamp meta so the thread keeps a record of its current profile.
        textInference.stampMetaForConversation(targetKey)

        // Reset manual stop flag
        manuallyStopped.value = false
        // Clear any prior failure so consumeTurnError only ever reflects this turn.
        turnErrors.delete(targetKey)

        // TTS preset: synthesize directly from the typed text, bypassing the LLM
        // entirely (no model load, no tool calling).
        if (textInference.activePreset?.ttsPreset) {
          await synthesizeDirect(question, targetKey, { clearInputs, sideChannel })
          return
        }

        // 2. Block if images attached to non-vision model (UI path only). Validate
        //    before touching the backend so we don't load a model just to reject.
        if (!sideChannel && fileInput.value.length > 0 && !textInference.modelSupportsVision) {
          const hasImageFiles = fileInput.value.some((part) => part.mediaType?.startsWith('image/'))
          if (hasImageFiles) {
            throw errors.report(
              createAppError({
                category: 'validation',
                code: 'inference/vision-unsupported',
                userMessage:
                  'The selected model does not support image inputs. Please remove the images or select a vision-capable model.',
                surface: 'toast',
                context: { conversationKey: targetKey },
              }),
            )
          }
        }

        // 3. Ensure backend/models are ready and prepare RAG context. These run
        //    before the stream starts, so failures never reach the Chat onError
        //    hook — report them here (toast for the active desktop conversation).
        let ragContext: Awaited<ReturnType<typeof textInference.prepareRagContext>>
        try {
          await textInference.ensureReadyForInference()
          ragContext = await textInference.prepareRagContext(question)
        } catch (error) {
          // The user cancelling a required model download is not a failure — abort
          // the turn quietly, keeping their prompt/attachments for a retry.
          if (isCancellation(error)) return
          throw errors.report(error, {
            category: 'inference',
            code: 'inference/preparation-failed',
            userMessage: `Could not start generation: ${extractMessage(error)}`,
            surface: sideChannel ? 'silent' : 'toast',
            context: { conversationKey: targetKey },
          })
        }
        temporarySystemPrompts[targetKey] = ragContext.systemPrompt

        // 4. Get chat instance and send message
        const chat = getOrCreateChat(targetKey)

        if (!sideChannel) {
          messageInput.value = question
        }
        const effectiveFiles =
          options?.files && options.files.length > 0
            ? options.files
            : !sideChannel && fileInput.value.length > 0
              ? fileInput.value
              : undefined
        try {
          await chat.sendMessage({
            text: question,
            files: effectiveFiles,
            metadata: {
              model: textInference.activeModel,
              timestamp: Date.now(),
            },
          })
        } finally {
          temporarySystemPrompts[targetKey] = null
        }

        // The Chat onError hook records stream failures. A failed turn should keep
        // the user's prompt/attachments for retry instead of clearing them.
        const hadError = !!chat.error && !manuallyStopped.value

        const outgoingMessages = chat.messages

        // 5. Store RAG source in message metadata
        if (ragContext.ragSourceText) {
          const latestMessage = outgoingMessages[outgoingMessages.length - 1]
          if (latestMessage && latestMessage.role === 'assistant' && latestMessage.metadata) {
            latestMessage.metadata.ragSource = ragContext.ragSourceText
          }
        }

        // Strip bulky tool outputs (e.g. base64 WAV from synthesizeTextToSpeech)
        // before persisting so they never bloat the stored history or the LLM
        // context on subsequent turns.
        const sanitizedForStorage = sanitizeBulkyToolOutputs(outgoingMessages)
        if (sanitizedForStorage !== outgoingMessages) {
          chat.messages.splice(0, chat.messages.length, ...sanitizedForStorage)
        }

        // 6. Persist conversation (sanitize base64 image parts to aipg-media)
        conversations.updateConversation(chat.messages, targetKey)

        // 7. Clear inputs only on a clean turn, so failures/stops are retryable.
        if (clearInputs && !hadError) {
          messageInput.value = ''
          fileInput.value = []
        }
      } finally {
        unmarkGenerating(targetKey)
      }
    }

    async function stop() {
      // Set manual stop flag to immediately show as not processing
      manuallyStopped.value = true
      await chats[conversations.activeKey]?.stop()
    }

    async function regenerate(messageId: string) {
      const targetKey = conversations.activeKey
      // Reactivate the conversation's preset and stamp meta before regenerating
      // so the new turn matches the thread's current profile (matches `generate`).
      textInference.ensureGlobalsMatchConversation(targetKey)
      textInference.stampMetaForConversation(targetKey)

      // TTS preset: re-synthesize the prompt instead of running the LLM. Without
      // this the regenerate button falls through to `ensureReadyForInference()`
      // and loads a chat model into a thread that never uses one.
      if (textInference.activePreset?.ttsPreset) {
        await regenerateSynthesis(messageId, targetKey)
        return
      }

      // STT preset: same trap as TTS above — falling through would load a chat
      // model into a thread that never uses one. Unlike TTS there is nothing to
      // redo: the transcript's source audio is not kept in the thread (the user
      // message is only a label), so re-transcribing is impossible.
      if (textInference.activePreset?.sttPreset) {
        toast.warning('A transcript cannot be regenerated — record or upload the audio again.')
        return
      }

      try {
        await textInference.ensureReadyForInference()
      } catch (error) {
        // Cancelling a required model download aborts the regenerate quietly.
        if (isCancellation(error)) return
        throw errors.report(error, {
          category: 'inference',
          code: 'inference/preparation-failed',
          userMessage: `Could not start generation: ${extractMessage(error)}`,
          context: { conversationKey: targetKey },
        })
      }
      manuallyStopped.value = false

      const chat = chats[targetKey]
      if (!chat) return

      // Find the user message that produced the assistant message being regenerated
      // so RAG retrieval re-runs against the same question.
      const targetIdx = chat.messages.findIndex((m) => m.id === messageId)
      const priorUserMessage =
        targetIdx > 0
          ? [...chat.messages.slice(0, targetIdx)].reverse().find((m) => m.role === 'user')
          : undefined
      const question =
        priorUserMessage?.parts
          ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text ?? '')
          .join('\n\n') ?? ''

      const ragContext = await textInference.prepareRagContext(question)
      temporarySystemPrompts[targetKey] = ragContext.systemPrompt

      try {
        await chat.regenerate({ messageId })
      } finally {
        temporarySystemPrompts[targetKey] = null
      }

      if (ragContext.ragSourceText) {
        const latestMessage = messages.value?.[messages.value.length - 1]
        if (latestMessage && latestMessage.role === 'assistant' && latestMessage.metadata) {
          latestMessage.metadata.ragSource = ragContext.ragSourceText
        }
      }

      conversations.updateConversation(messages.value, targetKey)
    }

    async function removeMessage(messageId: string) {
      const chat = chats[conversations.activeKey]
      if (!chat) return
      const indexOfAssistantMeessage = chat.messages.findIndex((m) => m.id === messageId)
      if (indexOfAssistantMeessage > 0) {
        chat.messages.splice(indexOfAssistantMeessage - 1, 2)
      } else {
        chat.messages.splice(indexOfAssistantMeessage, 1)
      }
      conversations.updateConversation(chat.messages, conversations.activeKey)
    }

    const error = computed(() => chats[conversations.activeKey]?.error?.message)

    // Read-and-clear the last failure for a conversation. Used by background
    // callers (Home Agent channels) to relay a turn's error to the remote user,
    // since stream failures are reported silently and never thrown.
    function consumeTurnError(conversationKey: string): AppError | undefined {
      const e = turnErrors.get(conversationKey)
      turnErrors.delete(conversationKey)
      return e
    }

    return {
      chat: chats[conversations.activeKey],
      messages,
      contextUsage,
      usedTokens,
      messageInput,
      fileInput,
      generate,
      transcribeDirect,
      appendTranscriptTurn,
      getMessagesForKey,
      summarizeMessages,
      stop,
      processing,
      reasoningInProgress,
      reasoningStartedAt,
      removeMessage,
      regenerate,
      error,
      consumeTurnError,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: [],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useOpenAiCompatibleChat, import.meta.hot))
}
