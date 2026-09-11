import { extractReasoningMiddleware, wrapLanguageModel, type LanguageModel } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { useTextInference } from '@/assets/js/store/textInference'
import { useCloudMode, CLOUD_DEFAULT_MODEL } from '@/assets/js/store/cloudMode'
import { usePresets } from '@/assets/js/store/presets'
import { getHomeAgentAuthToken, invalidateHomeAgentAuthToken } from '@/lib/loopbackAuth'
import { chatTemplateKwargs } from '@/lib/samplingDefaults'
import type { ChatTraceContext } from '@/lib/laminarTelemetry'
import { openAiApiBase } from '@/lib/inferenceApiBase'

// ── Shared chat model factory ────────────────────────────────────────────────
//
// Builds the AI SDK language model for the currently selected backend/model
// (textInference + cloudMode), including all the routing/retry behavior chat
// inference depends on: cloud loopback-proxy headers, Home Agent proxy auth,
// backend relaunch-and-retry, and inference-stream tracking. Extracted from
// the openAiCompatibleChat store so nested tool agents (see
// assets/js/agents/toolAgent.ts) run against the exact same endpoint and
// model as the parent conversation.
//
// Reads reactive store state — calling it inside a computed() tracks the
// relevant dependencies (backend, model, backend URL) as before.

/**
 * The setup of a turn run against this model, for its trace: which backend on
 * which device, whether the model was told to think and how deeply, and the
 * sampling that rides the request. `chatTemplateKwargs` is the same call
 * `createChatModel` makes to build the body, so a trace reports what was sent
 * and not what the settings happen to say.
 *
 * Lives here rather than in the chat store because every surface that runs on
 * this model needs it — chat turns and the nested tool agents, which are AI SDK
 * calls of their own (see assets/js/agents/mediaAgent.ts).
 */
export function chatTraceContext(): ChatTraceContext {
  const textInference = useTextInference()
  const cloudMode = useCloudMode()
  const presets = usePresets()
  const kwargs = chatTemplateKwargs({
    supportsThinkingToggle: textInference.modelSupportsThinkingToggle,
    thinkingEnabled: textInference.thinkingEnabled,
    thinkingActive: textInference.thinkingActive,
    reasoningEffort: textInference.effectiveReasoningEffort,
  })
  const cloud = textInference.backend === 'cloud'
  return {
    preset: presets.activePresetName ?? undefined,
    backend: textInference.backend,
    ...(cloud
      ? { cloudProvider: cloudMode.selectedProviderId }
      : {
          device: textInference.getCurrentDeviceId() ?? undefined,
          deviceName: textInference.getCurrentDeviceName() ?? undefined,
        }),
    ...(typeof kwargs.enable_thinking === 'boolean' ? { thinking: kwargs.enable_thinking } : {}),
    ...(typeof kwargs.reasoning_effort === 'string'
      ? { reasoningEffort: kwargs.reasoning_effort }
      : {}),
    sampling: {
      temperature: textInference.temperature,
      topP: textInference.samplingRequestBody.top_p,
      maxTokens: textInference.maxTokens,
    },
  }
}

export function createChatModel(): LanguageModel {
  const textInference = useTextInference()
  const cloudMode = useCloudMode()

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
    return openAiApiBase(base)
  }

  const base = createOpenAICompatible({
    name: 'model',
    baseURL: `${resolveInferenceApiBaseUrl() ?? textInference.currentBackendUrl}/`,
    includeUsage: true,
    // For models that support toggling thinking (Qwen3 family, gemma4), send the
    // explicit enable_thinking value so the toggle is authoritative regardless of
    // the family's template default (Qwen3 defaults on, gemma4 defaults off). Both
    // llama-server (--jinja) and OVMS (--reasoning_parser qwen3) honor this kwarg.
    // The same hook carries the sampling a model's publisher recommends, since
    // the AI SDK models none of top_k / min_p / the penalties.
    transformRequestBody: (args) => {
      let body: Record<string, unknown> = args
      // The Cloud "default" model is a placeholder for providers that serve
      // a single model / accept a request without one. Omit `model` entirely
      // so the provider uses its own default instead of a bogus "default" id.
      if (textInference.backend === 'cloud' && textInference.activeModel === CLOUD_DEFAULT_MODEL) {
        body = { ...body }
        delete body.model
      }
      body = { ...body, ...textInference.samplingRequestBody }
      const kwargs: Record<string, unknown> = {
        ...(body.chat_template_kwargs as Record<string, unknown> | undefined),
        ...chatTemplateKwargs({
          supportsThinkingToggle: textInference.modelSupportsThinkingToggle,
          thinkingEnabled: textInference.thinkingEnabled,
          thinkingActive: textInference.thinkingActive,
          reasoningEffort: textInference.effectiveReasoningEffort,
        }),
      }
      if (Object.keys(kwargs).length > 0) {
        body = { ...body, chat_template_kwargs: kwargs }
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
          const endpoint = endpointMatch ? endpointMatch[1] : requestUrl.pathname.replace(/^\//, '')
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
}
