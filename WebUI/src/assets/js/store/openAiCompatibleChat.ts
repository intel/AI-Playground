import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { Chat } from '@ai-sdk/vue'
import {
  type FileUIPart,
  type LanguageModelUsage,
  type ToolSet,
  UIDataTypes,
  UIMessage,
  type UIMessageChunk,
} from 'ai'
import { buildChatModelConfig } from '@/lib/chatModel'
import { buildChatRagRequest } from '@/lib/chatRagRequest'
import { createKernelChatTransport } from '@/lib/kernelChatTransport'
import { serializeToolSet } from '@/lib/chatToolRegistry'
import { buildHomeAgentInferenceSnapshot } from '@/lib/homeAgentInferenceSnapshot'
import type { ChatTurnRequest } from '@/types/chatIpc'
import { withResponseLanguageAtStart } from '@/lib/responseLanguage'
import { useTextInference } from './textInference'
import { useConversations, HOME_AGENT_CHAT_PRESET_NAME } from './conversations'
import { usePresets } from './presets'
import { sessionIdOfChatKey } from '@/lib/sessionChat'
import { sanitizeBulkyToolOutputs } from '@/lib/toolMessageSanitize'
import { restoreMissingHistory } from '@/lib/threadHistoryMerge'
import { useErrors } from './errors'
import { useActivities } from './activities'
import { useConfirmations } from './confirmations'
import { useI18N } from './i18n'
import { useDeveloperSettings } from './developerSettings'
import { useComputeMetrics } from './computeMetrics'
import type { ChatTurnEnergy } from '@/lib/chatEnergy'
import { createAppError, extractMessage, isCancellation } from '../errors/appError'
import type { AppError } from '../errors/types'
import { aipgTools, homeAgentTools, sessionTools } from '../tools/tools'
import { getAvailableWorkflows, createToolRepairData } from '../tools/comfyUi'
import { getAvailableEditWorkflows, createEditToolRepairData } from '../tools/comfyUiImageEdit'
import z from 'zod'
import { AipgTools } from '../tools/tools'
import { JSONSchema7 } from '@ai-sdk/provider'
import { dynamicTool, jsonSchema } from '@ai-sdk/provider-utils'
import { synthesizeToolAvailable, transcriptionAvailable } from '../speech/speechIO'
import { conversationLabelForTtsFile } from '@/lib/ttsAudioFileName'

// Web tools that share browseWeb's single "Browse the web" enablement toggle:
// they all act on the same background browser browseWeb drives.
const WEB_COMPANION_TOOLS = new Set(['searchWeb', 'interactWithWebPage', 'screenshotWebPage'])

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

export type AipgMetadata = {
  model?: string
  timestamp?: number
  conversationTitle?: string
  timings?: z.infer<typeof LlamaCppRawValueTimingsSchema>
  compute?: import('@/types/computeMetrics').ComputeWindowStats
  energy?: ChatTurnEnergy
  ragSource?: string
  usage?: LanguageModelUsage
  /** In a Session's chat transcript; the Session Update main put ahead of this prompt. */
  chatTurn?: boolean
  sessionUpdate?: string
}

export type AipgUiMessage = UIMessage<AipgMetadata, UIDataTypes, AipgTools>

export type GenerateOptions = {
  conversationKey?: string
  clearInputs?: boolean
  files?: FileUIPart[]
}

/** The turn request minus what the transport fills in (key, trigger, messages). */
type ChatTurnExtras = Omit<ChatTurnRequest, 'conversationKey' | 'trigger' | 'messages'>

export const useOpenAiCompatibleChat = defineStore(
  'openAiCompatibleChat',
  () => {
    const textInference = useTextInference()
    const conversations = useConversations()
    const presets = usePresets()
    const errors = useErrors()
    const activities = useActivities()
    const confirmations = useConfirmations()
    const i18n = useI18N()
    const i18nState = i18n.state
    const developerSettings = useDeveloperSettings()
    const computeMetrics = useComputeMetrics()
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

    // An attached clip is only useful to a turn that can transcribe it — no
    // chat backend accepts audio itself.
    const canTranscribeAttachments = computed(
      () =>
        textInference.modelSupportsToolCalling &&
        textInference.aipgToolsEnabled &&
        textInference.isBuiltinToolEnabled('transcribeAudio') &&
        transcriptionAvailable(),
    )

    function isToolEnabled(toolName: string): boolean {
      const name = toolName.toLowerCase()
      // These blender tools fill up context, but still only work with separate api keys
      const excludedKeywords = ['hyper', 'rodin', 'sketchfab', 'hunyuan', 'polyhaven']
      return !excludedKeywords.some((keyword) => name.includes(keyword))
    }

    async function resolveTools(conversationKey: string): Promise<ToolSet> {
      if (!textInference.modelSupportsToolCalling) return {}

      const builtinTools = resolveBuiltinTools(conversationKey)
      const mcpTools = await resolveMcpTools()
      return { ...builtinTools, ...mcpTools }
    }

    function resolveBuiltinTools(conversationKey: string): ToolSet {
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
          if (!synthesizeToolAvailable()) continue
        }
        // Offer the transcription tool whenever ANY engine can serve it (OpenVINO
        // Whisper, the standalone torch sidecar, or the external endpoint) — the
        // transcription path itself falls back to an installed engine via
        // `effectiveSttEngine`. Keying this off the selected engine hid the tool
        // from users whose persisted selection named an engine they never
        // installed, even though speech-to-text was usable.
        if (name === 'transcribeAudio' && !transcriptionAvailable()) continue
        tools[name] = builtinTool
      }
      // The Home Agent self-inspection/configuration tools are only meaningful
      // for the Home Agent preset; never expose them to ordinary chat presets.
      if (textInference.activePreset?.name === HOME_AGENT_CHAT_PRESET_NAME) {
        Object.assign(tools, homeAgentTools)
      }
      if (sessionIdOfChatKey(conversationKey)) Object.assign(tools, sessionTools)
      return tools
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
          // Schema only: the MCP client lives in main, so the turn engine
          // invokes it there (`electron/chat/chatMcpTool.ts`) rather than
          // bouncing main → renderer → `mcp:invokeServerTool` → main. The
          // name carries the routing.
          resolvedTools[`mcp__${server.id}__${mcpTool.name}`] = dynamicTool({
            description: mcpTool.description || `${server.name} tool: ${mcpTool.name}`,
            inputSchema: jsonSchema({
              ...mcpTool.inputSchema,
              properties: mcpTool.inputSchema.properties ?? {},
              additionalProperties: false,
            } as JSONSchema7),
          }) as ToolSet[string]
        }
      }

      return resolvedTools
    }

    // ── Chunk observation (was customFetch's onChunk) ─────────────────────
    //
    // The turn engine in main owns the AI SDK call now; what the renderer still
    // needs from the stream is UI state: the reasoning indicator and the
    // inference activity labels ("Processing prompt…"/"Processing results…").
    // The transport's onChunk seam feeds this observer with every chunk that
    // reaches the Chat, replay included.
    function makeChunkObserver(conversationKey: string): (chunk: UIMessageChunk) => void {
      let reasoningInterrupted = true
      let inferenceActivityId: string | null = null
      let sawToolResult = false
      const scope = { kind: 'chat' as const, conversationKey }
      const ensureInferenceActivity = () => {
        if (!inferenceActivityId) {
          inferenceActivityId = activities.begin({
            category: 'inference',
            label: sawToolResult
              ? i18nState.COM_ACTIVITY_PROCESSING_RESULTS
              : i18nState.COM_ACTIVITY_PROCESSING_PROMPT,
            scope,
          })
        }
      }
      const clearInferenceActivity = () => {
        if (inferenceActivityId) {
          activities.end(inferenceActivityId)
          inferenceActivityId = null
        }
      }
      return (chunk) => {
        // Drive the inference activity: content/tool-input means the model is
        // no longer waiting; a tool result means it will process that output
        // next. Re-armed with the "results" label from then on.
        if (chunk.type === 'start') {
          textInference.completeBackendPreparation()
          ensureInferenceActivity()
        } else if (
          chunk.type === 'text-delta' ||
          chunk.type === 'reasoning-delta' ||
          chunk.type === 'tool-input-start' ||
          chunk.type === 'tool-input-available'
        ) {
          clearInferenceActivity()
        } else if (chunk.type === 'tool-output-available' || chunk.type === 'tool-output-error') {
          sawToolResult = true
          ensureInferenceActivity()
        } else if (chunk.type === 'finish' || chunk.type === 'abort' || chunk.type === 'error') {
          clearInferenceActivity()
        }
        // Track whether reasoning is the model's current output. Any non-
        // reasoning content chunk closes the open reasoning block; the next
        // reasoning delta then starts a fresh one (keeping slow models' blocks
        // from resetting per token, as before the move).
        if (chunk.type === 'reasoning-delta') {
          reasoningInProgress.value = true
          if (reasoningInterrupted) {
            reasoningStartedAt.value = Date.now()
            reasoningInterrupted = false
          }
        } else if (
          chunk.type === 'text-delta' ||
          chunk.type === 'tool-input-start' ||
          chunk.type === 'tool-input-available' ||
          chunk.type === 'tool-output-available' ||
          chunk.type === 'tool-output-error'
        ) {
          reasoningInProgress.value = false
          reasoningInterrupted = true
        }
      }
    }

    const pendingRagSource: Record<string, string | null> = {}
    const ragActivityByKey: Record<string, string> = {}

    // ── Per-turn request extras (was customFetch's request prep) ───────────
    //
    // Everything the main-side engine needs beyond the messages themselves,
    // assembled at submit time: the model config (backend/sampling/proxy
    // routing), the base system prompt (RAG is retrieved in main when `rag`
    // is set), the tool specs + executors (registry), and the flags.
    async function buildTurnExtras(
      targetKey: string,
      ragQuery?: string,
      outgoingUser = false,
    ): Promise<ChatTurnExtras> {
      const toolSet = await activities.track(
        {
          category: 'tools',
          label: i18nState.COM_ACTIVITY_PREPARING_TOOLS,
          scope: { kind: 'chat' as const, conversationKey: targetKey },
        },
        () => resolveTools(targetKey),
      )
      const hasTools = Object.keys(toolSet).length > 0
      const specs = hasTools ? serializeToolSet(toolSet) : []
      const repairData = {
        ...(toolSet.comfyUI ? { comfyUI: createToolRepairData() ?? undefined } : {}),
        ...(toolSet.comfyUiImageEdit
          ? { comfyUiImageEdit: createEditToolRepairData() ?? undefined }
          : {}),
      }
      const rag = ragQuery ? buildChatRagRequest(ragQuery) : undefined
      const mediaAgent = specs.some((spec) => spec.name === 'media')
        ? (await import('../agents/mediaAgent')).serializeMediaAgentInner()
        : undefined
      const existing = chats[targetKey]?.messages ?? []
      const languageMessages = outgoingUser ? [...existing, { role: 'user' as const }] : existing
      return {
        model: buildChatModelConfig(),
        systemPrompt: withResponseLanguageAtStart(
          textInference.systemPrompt,
          i18n.langName,
          languageMessages,
        ),
        tools: specs,
        ...(hasTools ? { repairData } : {}),
        ...(rag ? { rag } : {}),
        // Direct comfy tools stop the LLM unless this rides every turn, not only the media specialist.
        keepModelsLoaded: developerSettings.keepModelsLoaded,
        ...(mediaAgent ? { mediaAgent } : {}),
        persist: {
          meta: conversations.getThreadMeta(targetKey) ?? null,
          ragHashes: conversations.getThreadRagHashes(targetKey),
          lastMainKey: conversations.lastMainKey,
        },
        includeMcpInstructions: textInference.mcpToolsEnabled,
        // `captureScreenshot` executes in main and takes no arguments, so the
        // window the user bound it to travels with the turn.
        ...(textInference.screenshotWindow
          ? {
              screenshotWindow: {
                id: textInference.screenshotWindow.id,
                name: textInference.screenshotWindow.name,
              },
            }
          : {}),
        // The TTS tool names its file after the thread, whose title lives here.
        ...(specs.some((spec) => spec.name === 'synthesizeTextToSpeech')
          ? {
              conversationLabel: conversationLabelForTtsFile({
                conversationKey: targetKey,
                messages: conversations.conversationList[targetKey],
                threadMeta: conversations.getThreadMeta(targetKey),
              }),
            }
          : {}),
        // The Home Agent's settings tools run in main and read this instead of
        // the stores; without it they refuse, which is the guard that kept a
        // stray call from mutating another preset's settings.
        ...(textInference.activePreset?.name === HOME_AGENT_CHAT_PRESET_NAME
          ? { homeAgentInference: buildHomeAgentInferenceSnapshot() }
          : {}),
        homeAgentDiagnostics: textInference.activePreset?.name === HOME_AGENT_CHAT_PRESET_NAME,
        ...sessionTurnFields(targetKey),
      }
    }

    function sessionTurnFields(conversationKey: string) {
      const sessionRef = sessionIdOfChatKey(conversationKey)
      const presetName = presets.activePresetName
      if (!sessionRef || !presetName) return {}
      const variant = presets.activeVariantName[presetName]
      return { sessionRef, presetName, ...(variant ? { variant } : {}) }
    }

    /** Replaces a chat's messages with its stored transcript unless a turn is running in it. */
    function loadTranscript(conversationKey: string, messages: AipgUiMessage[]): void {
      if ((generatingKeys.value[conversationKey] ?? 0) > 0) return
      const chat = chats[conversationKey]
      if (chat && (chat.status === 'submitted' || chat.status === 'streaming')) return
      conversations.applyConversationMessages(messages, conversationKey)
      if (chat) chat.messages = [...(conversations.conversationList[conversationKey] ?? [])]
    }

    function getOrCreateChat(conversationKey: string): Chat<AipgUiMessage> {
      const existing = chats[conversationKey]
      if (existing) return existing
      conversations.ensureConversationBucket(conversationKey)
      const chat = new Chat<AipgUiMessage>({
        // The turn runs in main (step 6): submit over `chat:submitTurn`,
        // consume the stream as kernel `chat-chunk` events, resume via the
        // bus sequence handshake on a renderer reload. The per-request body
        // (model config, prompt, tools) is attached per send by
        // `buildTurnExtras` and spread by the transport.
        // `id` must be the conversation key: send/resume put it on the wire as
        // `chatId`, and main's turn table / tool registry / kernel events all
        // key off it. A generated id would orphan cancel, tools, and resume.
        id: conversationKey,
        transport: createKernelChatTransport({
          submitTurn: (request) => window.electronAPI.chat.submitTurn(request),
          resumeTurn: (key) => window.electronAPI.chat.resumeTurn(key),
          cancelTurn: (key, turnId) => window.electronAPI.chat.cancelTurn(key, turnId),
          subscribe: (listener) => window.electronAPI.onKernelEvent(listener),
          onChunk: makeChunkObserver(conversationKey),
          onRag: (key, sourceText) => {
            pendingRagSource[key] = sourceText
            const ragActivityId = ragActivityByKey[key]
            if (ragActivityId) {
              activities.end(ragActivityId)
              delete ragActivityByKey[key]
            }
          },
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

    /**
     * The resume stream carries the running turn and nothing else, so a Chat
     * that opened on a thread it could not read yet would show — and then
     * persist — a conversation starting mid-way. This store is instantiated
     * before the thread files hydrate (promptArea → setupWizard → homeAgent),
     * hence the seed rather than trusting the constructor's `messages`.
     */
    function seedFromPersistedThread(chat: Chat<AipgUiMessage>, conversationKey: string): void {
      const stored = conversations.conversationList[conversationKey] ?? []
      if (stored.length === 0) return
      if (chat.messages.length === 0) {
        chat.messages = [...stored]
        return
      }
      const merged = restoreMissingHistory(stored, chat.messages)
      if (merged !== chat.messages) chat.messages = merged
    }

    // A reloaded renderer re-adopts chat turns that kept streaming in main
    // (step 6): one snapshot read at boot. Turns started later are always this
    // renderer's own (channel traffic drains through the Home Agent store
    // here) and stream through their transport from the start, so a second
    // subscription would only duplicate the transport's.
    void window.electronAPI
      ?.getKernelSnapshot?.()
      .then(async (snapshot) => {
        const running = snapshot.state.chatTurns ?? []
        if (running.length === 0) return
        await conversations.init()
        for (const turn of running) {
          const chat = getOrCreateChat(turn.conversationKey)
          seedFromPersistedThread(chat, turn.conversationKey)
          void chat.resumeStream().catch((error: unknown) => {
            errors.report(error, {
              category: 'inference',
              code: 'inference/chat-resume-failed',
              userMessage: `Could not resume the interrupted chat turn: ${extractMessage(error)}`,
              surface: 'silent',
            })
          })
        }
      })
      .catch(() => {})

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
     * into a 5-word-or-less summary. The model call runs in main (step 6) off
     * the same model config a turn ships, so cloud/Home-Agent proxy routing is
     * preserved. Main occupies and loads when `model.readiness` is present.
     */
    async function summarizeMessages(messagesText: string): Promise<string> {
      const result = await window.electronAPI.chat.summarize({
        messagesText,
        model: buildChatModelConfig(),
      })
      if (!result.success) {
        throw new Error(result.error || 'summarize failed')
      }
      return result.data
    }

    /**
     * Whether an image reaches the model on this turn — newly attached or
     * already in the thread, since history is sent too. It is the only thing
     * the multimodal projector is needed for.
     */
    function turnCarriesImage(conversationKey: string, options?: GenerateOptions): boolean {
      const files = options?.files?.length ? options.files : fileInput.value
      if (files.some((part) => part.mediaType?.startsWith('image/'))) return true
      return (getMessagesForKey(conversationKey) ?? []).some((message) =>
        message.parts?.some((part) => part.type === 'file' && part.mediaType?.startsWith('image/')),
      )
    }

    async function generate(question: string, options?: GenerateOptions) {
      const sideChannel = options?.conversationKey !== undefined
      const targetKey = sideChannel ? options.conversationKey! : conversations.activeKey
      const clearInputs = options?.clearInputs ?? !sideChannel

      // Mark the turn in flight for its whole duration (prep + all stream steps),
      // so `processing` stays true until the turn genuinely finishes. Cleared in
      // `finally` so a thrown/aborted turn can never leave the UI stuck busy.
      markGenerating(targetKey)
      computeMetrics.beginTurn()
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

        // 3. Download consent stays renderer-side. LLM load and RAG retrieval
        //    run in main after submit (step 9).
        try {
          await textInference.checkModelAvailability({
            needsVision: turnCarriesImage(targetKey, options),
            conversationKey: targetKey,
          })
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

        if (textInference.backend === 'llamaCPP' || textInference.backend === 'openVINO') {
          textInference.startBackendPreparation()
        }
        if (buildChatRagRequest(question)) {
          ragActivityByKey[targetKey] = activities.begin({
            category: 'rag',
            label: i18nState.COM_ACTIVITY_SEARCHING_DOCS,
            scope: { kind: 'chat', conversationKey: targetKey },
          })
        }

        // 4. Get chat instance and send message. The turn request extras
        //    (model config, prompt, tools + executors) ship as the request
        //    body; the engine in main runs the stream from there.
        const chat = getOrCreateChat(targetKey)

        const effectiveFiles =
          options?.files && options.files.length > 0
            ? options.files
            : !sideChannel && fileInput.value.length > 0
              ? fileInput.value
              : undefined
        // The field clears on Send: the message (and its attachments) is in the
        // transcript from here on, queued or running, and can be regenerated there.
        if (clearInputs) {
          messageInput.value = ''
          fileInput.value = []
        }
        const turnExtras = await buildTurnExtras(targetKey, question, true)
        try {
          await chat.sendMessage(
            {
              text: question,
              files: effectiveFiles,
              metadata: {
                model: textInference.activeModel,
                timestamp: Date.now(),
              },
            },
            { body: turnExtras },
          )
        } finally {
          textInference.completeBackendPreparation()
          const ragActivityId = ragActivityByKey[targetKey]
          if (ragActivityId) {
            activities.end(ragActivityId)
            delete ragActivityByKey[targetKey]
          }
        }

        const outgoingMessages = chat.messages

        // 5. Store RAG source in message metadata
        if (pendingRagSource[targetKey]) {
          const latestMessage = outgoingMessages[outgoingMessages.length - 1]
          if (latestMessage && latestMessage.role === 'assistant' && latestMessage.metadata) {
            latestMessage.metadata.ragSource = pendingRagSource[targetKey] ?? undefined
          }
        }
        delete pendingRagSource[targetKey]

        // Strip bulky tool outputs (e.g. base64 WAV from synthesizeTextToSpeech)
        // before persisting so they never bloat the stored history or the LLM
        // context on subsequent turns.
        const sanitizedForStorage = sanitizeBulkyToolOutputs(outgoingMessages)
        if (sanitizedForStorage !== outgoingMessages) {
          chat.messages.splice(0, chat.messages.length, ...sanitizedForStorage)
        }

        // 6. Live projection only — the engine already wrote the thread file.
        conversations.applyConversationMessages(chat.messages, targetKey)
      } finally {
        computeMetrics.endTurn()
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

      try {
        await textInference.checkModelAvailability({
          needsVision: turnCarriesImage(targetKey),
          conversationKey: targetKey,
        })
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

      if (textInference.backend === 'llamaCPP' || textInference.backend === 'openVINO') {
        textInference.startBackendPreparation()
      }
      if (buildChatRagRequest(question)) {
        ragActivityByKey[targetKey] = activities.begin({
          category: 'rag',
          label: i18nState.COM_ACTIVITY_SEARCHING_DOCS,
          scope: { kind: 'chat', conversationKey: targetKey },
        })
      }

      const turnExtras = await buildTurnExtras(targetKey, question)
      try {
        computeMetrics.beginTurn()
        await chat.regenerate({ messageId, body: turnExtras })
      } finally {
        computeMetrics.endTurn()
        textInference.completeBackendPreparation()
        const ragActivityId = ragActivityByKey[targetKey]
        if (ragActivityId) {
          activities.end(ragActivityId)
          delete ragActivityByKey[targetKey]
        }
      }

      if (pendingRagSource[targetKey]) {
        const latestMessage = messages.value?.[messages.value.length - 1]
        if (latestMessage && latestMessage.role === 'assistant' && latestMessage.metadata) {
          latestMessage.metadata.ragSource = pendingRagSource[targetKey] ?? undefined
        }
      }
      delete pendingRagSource[targetKey]

      conversations.applyConversationMessages(messages.value, targetKey)
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
      canTranscribeAttachments,
      generate,
      loadTranscript,
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
