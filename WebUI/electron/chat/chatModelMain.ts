import { extractReasoningMiddleware, wrapLanguageModel, type LanguageModel } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { appLoggerInstance } from '../observability/logger'
import { fetchCloudUpstream } from '../adapters/cloudUpstream'
import { openAiApiBase } from '@/lib/inferenceApiBase'
import type { ChatModelConfig } from '@/types/chatIpc'

// ── Main-side chat model factory (docs/architecture-target.md §7, step 6) ────
//
// Port of src/lib/chatModel.ts, config-driven: the renderer resolves backend
// selection, sampling and thinking kwargs at submit time and ships them on the
// turn request, and main builds the language model from that data. The
// endpoint is re-rooted onto the LATEST backend URL on every call — a
// llama-server relaunch moves ports, and pi-ai's stamped-URL lesson (see
// piLocalEndpoint.ts) applies to the AI SDK just the same.
//
// Also tracks in-flight inference streams for its whole lifetime (dispatch →
// body drained), the main-side twin of the renderer counter the image tools
// consult before freeing the GPU (waitForInferenceIdle → chat:inferenceIdle).

const appLogger = appLoggerInstance

export type ChatReadinessArgs = NonNullable<ChatModelConfig['readiness']>

export type ChatModelDeps = {
  /** Live API base for a local backend (llmServerBaseUrl), or null when down. */
  llmApiBase: (backend: 'llamaCPP' | 'openVINO') => string | undefined
  /** Relaunch a local backend (the relaunch-and-retry path). Throws on failure. */
  ensureBackendReadiness: (args: ChatReadinessArgs) => Promise<void>
  /** Fresh loopback token for the Home Agent proxy (regenerated per spawn). */
  homeAgentAuthToken: () => string
  /** Decrypt one provider's stored API key. The plaintext stays in main. */
  readCloudProviderKey: (providerId: string) => string | null
}

let chatModelDeps: ChatModelDeps | null = null

export function setChatModelDeps(deps: ChatModelDeps): void {
  chatModelDeps = deps
}

export function resetChatModelDepsForTest(): void {
  chatModelDeps = null
  activeInferenceStreams = 0
}

// ── In-flight inference stream tracking ────────────────────────────────────────

let activeInferenceStreams = 0

export function chatInferenceStreamsActive(): number {
  return activeInferenceStreams
}

function beginInferenceStream(): void {
  activeInferenceStreams++
}

function endInferenceStream(): void {
  if (activeInferenceStreams > 0) activeInferenceStreams--
}

/**
 * Builds the AI SDK language model for one chat turn. Reads nothing but the
 * request's config; the returned model resolves its endpoint per request so a
 * mid-turn relaunch (new port) or backend switch (/v1 ⇄ /v3) is honored.
 */
export function createMainChatModel(config: ChatModelConfig): LanguageModel {
  if (!chatModelDeps) throw new Error('Chat model deps not wired')
  const deps = chatModelDeps
  const isLocal = config.backend === 'llamaCPP' || config.backend === 'openVINO'

  function resolveApiBase(): string | undefined {
    if (config.backend !== 'cloud') {
      const live = deps.llmApiBase(config.backend)
      return live ? openAiApiBase(live) : undefined
    }
    const upstream = config.cloud?.upstreamBaseUrl
    if (upstream) return openAiApiBase(upstream)
    return config.baseUrl ? openAiApiBase(config.baseUrl) : undefined
  }

  const base = createOpenAICompatible({
    name: 'model',
    baseURL: `${resolveApiBase() ?? config.baseUrl}/`,
    includeUsage: true,
    transformRequestBody: (args) => {
      let body: Record<string, unknown> = args
      if (config.omitModelInBody) {
        body = { ...body }
        delete body.model
      }
      if (config.timingsPerToken) {
        body = { ...body, timings_per_token: true }
      }
      if (config.samplingRequestBody) {
        body = { ...body, ...config.samplingRequestBody }
      }
      const kwargs = {
        ...(body.chat_template_kwargs as Record<string, unknown> | undefined),
        ...(config.chatTemplateKwargs ?? {}),
      }
      if (Object.keys(kwargs).length > 0) {
        body = { ...body, chat_template_kwargs: kwargs }
      }
      return body
    },
    fetch: async (url, init) => {
      const doFetch = async (): Promise<Response> => {
        const requestUrl = new URL(url as string)
        // Re-root onto the latest API base each call (port AND /vN path).
        const latestApiBase = resolveApiBase()
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
        if (config.backend === 'cloud' && config.cloud) {
          return await fetchCloudUpstream({
            providerId: config.cloud.providerId,
            baseUrl: config.cloud.upstreamBaseUrl ?? '',
            authStyle: config.cloud.authStyle,
            url: requestUrl.toString(),
            init,
            getKey: deps.readCloudProviderKey,
          })
        }
        if (config.homeAgentUpstreamUrl) {
          const build = (t: string): RequestInit => {
            const headers = new Headers(init?.headers)
            headers.set('X-Upstream-Url', config.homeAgentUpstreamUrl!)
            if (t) headers.set('X-AIPG-Auth', t)
            return { ...init, headers }
          }
          const token = deps.homeAgentAuthToken()
          let response = await globalThis.fetch(requestUrl.toString(), build(token))
          if (response.status === 401) {
            // The proxy restarted with a fresh token; the read above is already
            // uncached in main, so simply retry with a re-read.
            response = await globalThis.fetch(
              requestUrl.toString(),
              build(deps.homeAgentAuthToken()),
            )
          }
          return response
        }
        return await globalThis.fetch(requestUrl.toString(), init)
      }

      // A local inference server briefly answers with a transient error right
      // after it (re)starts, before its routes are mounted (see chatModel.ts
      // for the two observed shapes). Re-issue until it clears or the budget
      // elapses; only these exact signals, so a persistent 4xx is never masked.
      const isTransientRestartSignal = (status: number, body: string): boolean => {
        const lower = body.toLowerCase()
        if (status === 400 && lower.includes('invalid request url')) return true
        if (status === 404 && lower.includes('graph definition') && lower.includes('not found')) {
          return true
        }
        return false
      }
      const doFetchWithRouteRetry = async (): Promise<Response> => {
        const retryDelayMs = 400
        const retryBudgetMs = 20_000
        const deadline = Date.now() + retryBudgetMs
        let response = await doFetch()
        while (!response.ok && isLocal) {
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
      // lifetime — dispatch until the body is fully read, cancelled or
      // errored — so the GPU-swap paths can wait for idle before stopping the
      // chat backend mid-stream.
      const runTracked = async (): Promise<Response> => {
        beginInferenceStream()
        let response: Response
        try {
          response = await doFetchWithRouteRetry()
        } catch (error) {
          endInferenceStream()
          throw error
        }
        if (!response.ok) {
          response
            .clone()
            .text()
            .then((body) =>
              appLogger.error(
                `[inference] backend responded ${response.status} ${response.statusText}: ${
                  body?.trim() || '(empty body)'
                } (backend=${config.backend})`,
                'electron-backend',
              ),
            )
            .catch(() => {})
        }
        if (!response.body) {
          endInferenceStream()
          return response
        }
        let settled = false
        const settle = () => {
          if (settled) return
          settled = true
          endInferenceStream()
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
        if (init?.signal?.aborted) throw error
        if (!isLocal || !config.readiness) throw error
        appLogger.warn(
          `Inference request failed; relaunching backend and retrying once: ${String(error)}`,
          'electron-backend',
        )
        await deps.ensureBackendReadiness(config.readiness)
        return await runTracked()
      }
    },
  }).chatModel(config.backend === 'cloud' ? config.modelId : config.modelId.split('/').join('---'))

  // Cloud providers inline reasoning in the text stream; extract it into
  // reasoning parts so the UI renders it as collapsible thinking.
  if (config.backend !== 'cloud' || !config.extractReasoning) return base
  return wrapLanguageModel({
    model: base,
    middleware: extractReasoningMiddleware({ tagName: 'think' }),
  })
}
