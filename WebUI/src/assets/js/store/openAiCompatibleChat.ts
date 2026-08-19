import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { Chat } from '@ai-sdk/vue'
import {
  APICallError,
  convertToModelMessages,
  type FileUIPart,
  DefaultChatTransport,
  extractReasoningMiddleware,
  generateText,
  LanguageModelUsage,
  NoSuchToolError,
  streamText,
  stepCountIs,
  type ToolSet,
  UIDataTypes,
  UIMessage,
  wrapLanguageModel,
} from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { useTextInference } from './textInference'
import { useCloudMode, CLOUD_DEFAULT_MODEL } from './cloudMode'
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
import z from 'zod'
import { AipgTools } from '../tools/tools'
import { LanguageModelV2ToolResultOutput, JSONSchema7 } from '@ai-sdk/provider'
import { dynamicTool, jsonSchema } from '@ai-sdk/provider-utils'
import { imageUrlToDataUri } from '@/lib/utils'
import { getHomeAgentAuthToken, invalidateHomeAgentAuthToken } from '@/lib/loopbackAuth'
import { useQwen3TextToSpeech } from './qwen3TextToSpeech'
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
    const cloudMode = useCloudMode()
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

    // Full OpenAI-compatible API base for the active backend. The version segment is
    // NOT uniform across backends: llama.cpp, the Cloud proxy and the Home Agent proxy
    // serve under /v1 (added here), while OVMS serves under /v3 — already baked into its
    // baseUrl (openVINOBackendService: `http://127.0.0.1:<port>/v3`). Detect a base that
    // already carries a /vN path and use it as-is; otherwise append /v1. Kept in one
    // place so the provider baseURL and the per-call re-rooting below can never disagree
    // (e.g. a mid-turn backend switch that changes /v1 → /v3).
    function resolveInferenceApiBaseUrl(): string | undefined {
      const base = textInference.currentBackendUrl
      if (!base) return undefined
      return /\/v\d+\/?$/.test(base) ? base.replace(/\/$/, '') : `${base}/v1`
    }

    const model = computed(() => {
      const base = createOpenAICompatible({
        name: 'model',
        baseURL: `${resolveInferenceApiBaseUrl() ?? textInference.currentBackendUrl}/`,
        includeUsage: true,
        // For models that support toggling thinking (Qwen3 family, gemma4), send the
        // explicit enable_thinking value so the toggle is authoritative regardless of
        // the family's template default (Qwen3 defaults on, gemma4 defaults off). Both
        // llama-server (--jinja) and OVMS (--reasoning_parser qwen3) honor this kwarg.
        transformRequestBody: (args) => {
          let body: Record<string, unknown> = args
          // The Cloud "default" model is a placeholder for providers that serve
          // a single model / accept a request without one. Omit `model` entirely
          // so the provider uses its own default instead of a bogus "default" id.
          if (
            textInference.backend === 'cloud' &&
            textInference.activeModel === CLOUD_DEFAULT_MODEL
          ) {
            body = { ...body }
            delete body.model
          }
          if (textInference.modelSupportsThinkingToggle) {
            body = {
              ...body,
              chat_template_kwargs: {
                ...(body.chat_template_kwargs as Record<string, unknown> | undefined),
                enable_thinking: textInference.thinkingEnabled,
              },
            }
          }
          return body
        },
        fetch: async (url, init) => {
          // Resolve the request against the latest backend URL each call, so a
          // retry after a relaunch picks up the (possibly new) port.
          const doFetch = async (): Promise<Response> => {
            const requestUrl = new URL(url as string)
            // Re-root the request onto the LATEST API base each call. The provider's
            // baseURL is captured when `model` is created; a mid-turn backend relaunch
            // (new port) or switch (e.g. llama.cpp /v1 ⇄ OVMS /v3) must be honored. We
            // graft the OpenAI operation path (the tail after the base's /vN segment,
            // e.g. "chat/completions") onto the current base — carrying host, port AND
            // path — instead of only syncing host+port, which would otherwise keep a
            // stale /v1 while the live backend expects /v3 (→ "Invalid request URL").
            const latestApiBase = resolveInferenceApiBaseUrl()
            if (latestApiBase) {
              const apiBase = new URL(latestApiBase)
              const endpointMatch = requestUrl.pathname.match(/\/v\d+\/(.+)$/)
              const endpoint = endpointMatch
                ? endpointMatch[1]
                : requestUrl.pathname.replace(/^\//, '')
              const basePath = apiBase.pathname.replace(/\/$/, '')
              requestUrl.protocol = apiBase.protocol
              requestUrl.hostname = apiBase.hostname
              requestUrl.port = apiBase.port
              requestUrl.pathname = `${basePath}/${endpoint}`
            }
            // Cloud Mode routes through the main-process loopback proxy (see
            // cloudProxy.ts): it attaches the API key and calls the provider from
            // Node, so upstream failures are logged in the Node console. We only
            // tag the request with the upstream base URL and provider id — the key
            // never leaves main.
            if (textInference.backend === 'cloud') {
              const headers = new Headers(init?.headers)
              const upstream = cloudMode.activeProviderBaseUrl
              if (upstream) headers.set('X-Cloud-Upstream', upstream)
              headers.set('X-Cloud-Provider', cloudMode.selectedProviderId)
              headers.set('X-Cloud-Auth-Style', cloudMode.activeProviderAuthStyle)
              return globalThis.fetch(requestUrl.toString(), { ...init, headers })
            }
            // When Home Agent is active, the LLM proxy lives behind the Home
            // Agent Flask service. Attach the upstream inference URL header and
            // the per-launch loopback auth token so the proxy accepts the call.
            const upstreamUrl = textInference.homeAgentUpstreamUrl
            if (upstreamUrl) {
              let token = await getHomeAgentAuthToken()
              const build = (t: string): RequestInit => {
                const headers = new Headers(init?.headers)
                headers.set('X-Upstream-Url', upstreamUrl)
                if (t) headers.set('X-AIPG-Auth', t)
                return { ...init, headers }
              }
              let response = await globalThis.fetch(requestUrl.toString(), build(token))
              if (response.status === 401) {
                invalidateHomeAgentAuthToken()
                token = await getHomeAgentAuthToken(true)
                if (token) {
                  response = await globalThis.fetch(requestUrl.toString(), build(token))
                }
              }
              return response
            }
            return globalThis.fetch(requestUrl.toString(), init)
          }

          // A local inference server briefly answers with a transient error right after
          // it (re)starts: it accepts connections and reports healthy a beat before it
          // can actually serve a completion. Two shapes seen, both after the agentic
          // image tool stops + restarts the chat server mid-turn (comfyUi.ts →
          // restartChatBackend) and immediately issues a follow-up completion:
          //   • 400 {"error":"Invalid request URL"} — the OpenAI REST route isn't mounted
          //     yet (OVMS after /v2/health/ready; llama.cpp before routing is fully up).
          //   • 404 {"error":"Mediapipe graph definition with requested name is not found"}
          //     — OVMS's text-generation graph hasn't registered yet.
          // The backend now gates readiness on the model graph too (openVINOBackendService),
          // so this is a belt-and-suspenders backstop. Re-issue the request (plain JSON
          // body — safe to replay) until it clears or a time budget elapses. Time-based,
          // not a fixed attempt count, so a remount that lags the health gate by a couple
          // seconds isn't overshot. Scoped to local backends (never cloud, which isn't
          // restarted mid-turn) and to these exact signals so a genuine, persistent 4xx
          // is never masked — only the final response is returned/logged.
          const isTransientRestartSignal = (status: number, body: string): boolean => {
            const lower = body.toLowerCase()
            if (status === 400 && lower.includes('invalid request url')) return true
            if (status === 404 && lower.includes('graph definition') && lower.includes('not found'))
              return true
            return false
          }
          const doFetchWithRouteRetry = async (): Promise<Response> => {
            const retryDelayMs = 400
            const retryBudgetMs = 20_000
            const isLocalInferenceBackend =
              textInference.backend === 'openVINO' || textInference.backend === 'llamaCPP'
            const deadline = Date.now() + retryBudgetMs
            let response = await doFetch()
            while (!response.ok && isLocalInferenceBackend) {
              let body: string
              try {
                body = await response.clone().text()
              } catch {
                break
              }
              if (!isTransientRestartSignal(response.status, body)) break
              if (Date.now() >= deadline) break
              await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
              response = await doFetch()
            }
            return response
          }

          // Track one attempt as an in-flight inference stream for its whole
          // lifetime — from dispatch until the response body is fully read,
          // cancelled, or errored. Image tools wait on this (via
          // textInference.waitForInferenceIdle) before freeing the GPU, so they
          // can't stop the chat backend while a stream to it is still open
          // (which would reset the socket mid-stream => "network error").
          const runTracked = async (): Promise<Response> => {
            textInference.beginInferenceStream()
            let response: Response
            try {
              response = await doFetchWithRouteRetry()
            } catch (error) {
              textInference.endInferenceStream()
              throw error
            }
            // Surface a failed inference response body straight to the console. The
            // AI SDK reads the original body to build its APICallError, so we read a
            // *clone* to avoid consuming it. This makes the backend's actual reason
            // (e.g. an OVMS HTTP 400 rejecting an unsupported request) visible in
            // logs and e2e screenshots even when downstream plumbing would otherwise
            // mask it as a generic "An error occurred."
            if (!response.ok) {
              response
                .clone()
                .text()
                .then((body) =>
                  console.error(
                    `[inference] backend responded ${response.status} ${response.statusText}: ${
                      body?.trim() || '(empty body)'
                    } (url=${response.url || '(none)'}, backend=${
                      textInference.backend
                    }, backendUrl=${textInference.currentBackendUrl ?? '(none)'})`,
                  ),
                )
                .catch(() => {})
            }
            if (!response.body) {
              textInference.endInferenceStream()
              return response
            }
            let settled = false
            const settle = () => {
              if (settled) return
              settled = true
              textInference.endInferenceStream()
            }
            const reader = response.body.getReader()
            const tracked = new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const { done, value } = await reader.read()
                  if (done) {
                    settle()
                    controller.close()
                    return
                  }
                  controller.enqueue(value)
                } catch (error) {
                  settle()
                  controller.error(error)
                }
              },
              cancel(reason) {
                settle()
                return reader.cancel(reason)
              },
            })
            return new Response(tracked, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            })
          }

          try {
            return await runTracked()
          } catch (error) {
            // A thrown fetch error (vs. an HTTP error status) means the request
            // never reached a live server — typically the llama-server process
            // crashed or wedged (connection refused / timeout). Don't retry a
            // user-initiated abort. Otherwise relaunch the backend once (which
            // re-probes health and relaunches a dead/hung server) and retry
            // against the refreshed port.
            if (init?.signal?.aborted) throw error
            console.warn('Inference request failed; relaunching backend and retrying once:', error)
            await textInference.ensureBackendReadiness()
            return await runTracked()
          }
        },
        // Local backends encode model paths with '---' (a '/' in the repo path
        // would break the URL). Remote providers expect their model id verbatim.
      }).chatModel(
        textInference.backend === 'cloud'
          ? (textInference.activeModel ?? '')
          : (textInference.activeModel?.split('/').join('---') ?? ''),
      )
      // Local backends parse chain-of-thought server-side (llama-server --jinja /
      // OVMS --reasoning_parser qwen3) and emit it as separate reasoning content.
      // Remote Cloud Mode providers usually don't — <think>…</think> arrives inline
      // in the text stream, so it would render as answer text. Extract it into
      // reasoning parts client-side so the UI shows it as collapsible thinking.
      if (textInference.backend !== 'cloud') return base
      return wrapLanguageModel({
        model: base,
        middleware: extractReasoningMiddleware({ tagName: 'think' }),
      })
    })

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
      for (const [name, builtinTool] of Object.entries(aipgTools)) {
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
        if (name === 'synthesizeTextToSpeech') {
          const qwenInfo = backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')
          if (!qwenInfo?.isSetUp) continue
        }
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
                } as LanguageModelV2ToolResultOutput,
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
                output: { type: 'text', value: text } as LanguageModelV2ToolResultOutput,
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
                } as LanguageModelV2ToolResultOutput,
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

      const result = await streamText({
        model: model.value,
        messages,
        abortSignal: options.signal,
        system: systemPromptToUse,
        maxOutputTokens: textInference.maxTokens,
        temperature: textInference.temperature,
        includeRawChunks: true,
        // Surfaced to tool execute() so tools (e.g. configureHomeAgent) know
        // which conversation/channel they are running in.
        experimental_context: {
          conversationKey: requestConversationKey ?? conversations.activeKey,
        },
        ...(hasTools
          ? {
              tools: availableTools,
              stopWhen: stepCountIs(20),
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
        onStepFinish: (step) => {
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
        onFinish: (result) => {
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
              cache_n: effectiveUsage?.cachedInputTokens ?? 0,
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
        const alreadyLoaded = await qwen3.isModelLoaded()
        if (!alreadyLoaded) {
          await qwen3.ensureModelLoaded()
        }
        activities.update(ttsActivityId, { label: 'Generating audio file…' })
        const result = await qwen3.synthesize({ text: question })
        const label = conversationLabelForTtsFile({
          conversationKey: targetKey,
          messages: getMessagesForKey(targetKey),
          threadMeta: conversations.getThreadMeta(targetKey),
        })
        const fileName = buildTtsAudioFileName({
          conversationKey: targetKey,
          conversationLabel: label,
        })
        const savedFilePath = await qwen3.saveWavToDisk(result.audioBase64, fileName)
        output = {
          ok: true,
          message: `Synthesized ${result.mode} speech (${result.language}, ${result.speaker}).`,
          savedFilePath,
          speaker: result.speaker,
          language: result.language,
          mode: result.mode,
        }
      } catch (error) {
        errors.report(error, {
          category: 'inference',
          code: 'inference/tts-failed',
          userMessage: `Text To Speech failed: ${extractMessage(error)}`,
          surface: opts.sideChannel ? 'silent' : 'toast',
          context: { conversationKey: targetKey },
        })
        return
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
        metadata: { model: 'Qwen TTS', timestamp: Date.now() },
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
