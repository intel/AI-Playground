import { appLoggerInstance } from '../logging/logger.ts'
import { recordAgentCallStats, type InferenceCallStats } from '../laminarAttributes.ts'

// ── How fast an agent step actually ran ──────────────────────────────────────
//
// Pi hands its extensions the assembled request (`before_provider_request`) and
// the response *headers* (`after_provider_response`), but never the body, and
// pi-ai's assistant message keeps only token counts — so nothing in the agent
// stack can say how long prefill took or how much of the prompt the server's
// cache served. The one place those numbers pass through is the HTTP response
// itself: llama.cpp puts a `timings` object on its final SSE chunk, and every
// OpenAI-compatible server puts `usage` there.
//
// So the response stream is observed on its way past — only for the endpoint
// the current agent model is registered at, so the cloud proxy forwarding a
// *chat* turn (also a `/chat/completions` call out of this process) is never
// mistaken for an agent step. Only the tail of the stream is kept, and it is
// parsed once, at the end.
//
// Off unless tracing is on: nothing installs this otherwise.

const logger = appLoggerInstance
const LOG_SOURCE = 'laminar'

/** Enough to hold the final SSE event, which carries usage and timings. */
const TAIL_LIMIT = 16_384

let installed = false
let agentEndpoint: (() => string) | null = null

/**
 * Watch model calls to the agent's registered provider endpoint and report each
 * one's speeds. Idempotent; a later call re-points it at the endpoint of the
 * model the next session runs on.
 *
 * The endpoint is asked for per request rather than kept, because a local LLM
 * server relaunched mid-turn comes back on another port (see `localBaseUrl` in
 * piAgentManager.ts) — a remembered prefix would stop matching and every step
 * after the relaunch would lose its speeds.
 */
export function observeAgentModelCalls(endpoint: () => string): void {
  agentEndpoint = endpoint
  if (installed) return
  installed = true
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    // Before the call: a streaming server answers with headers as soon as it
    // has the first token, so timing from the resolved response would put
    // prefill at ~0 ms and report an absurd prefill rate.
    const startedAt = Date.now()
    const response = await original(input, init)
    try {
      const prefix = agentEndpoint?.().replace(/\/+$/, '')
      if (!prefix || !response.ok || !response.body) return response
      if (!requestUrl(input).startsWith(prefix)) return response
      return observe(response, startedAt)
    } catch (error) {
      logger.warn(`could not observe a model call: ${error}`, LOG_SOURCE)
      return response
    }
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

/** Pass the body through untouched, keeping only its tail and two timestamps. */
function observe(response: Response, startedAt: number): Response {
  let firstChunkAt = 0
  let tail = ''
  const decoder = new TextDecoder()
  const body = response.body!.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk)
        if (!firstChunkAt) firstChunkAt = Date.now()
        tail = (tail + decoder.decode(chunk, { stream: true })).slice(-TAIL_LIMIT)
      },
      flush() {
        const stats = summarize(tail, startedAt, firstChunkAt, Date.now())
        if (stats) recordAgentCallStats(stats)
      },
    }),
  )
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

type FinalChunk = {
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  timings?: {
    cache_n?: number
    prompt_ms?: number
    prompt_per_second?: number
    predicted_ms?: number
    predicted_per_second?: number
  }
}

/**
 * llama.cpp's own numbers when it sent them (it separates prefill from
 * generation and reports the prompt cache hit); otherwise the same split
 * measured from the outside — prompt tokens over the wait for the first byte,
 * completion tokens over the rest.
 */
function summarize(
  tail: string,
  startedAt: number,
  firstChunkAt: number,
  endedAt: number,
): InferenceCallStats | null {
  const final = lastEvent(tail)
  if (!final) return null
  if (final.timings?.predicted_per_second !== undefined) {
    return {
      prefillTokensPerSecond: final.timings.prompt_per_second,
      generationTokensPerSecond: final.timings.predicted_per_second,
      promptMs: final.timings.prompt_ms,
      predictedMs: final.timings.predicted_ms,
      cacheTokens: final.timings.cache_n,
    }
  }
  if (!final.usage || !firstChunkAt) return null
  const promptMs = firstChunkAt - startedAt
  const predictedMs = endedAt - firstChunkAt
  const perSecond = (tokens: number | undefined, ms: number) =>
    tokens && ms > 0 ? (tokens / ms) * 1000 : undefined
  return {
    prefillTokensPerSecond: perSecond(final.usage.prompt_tokens, promptMs),
    generationTokensPerSecond: perSecond(final.usage.completion_tokens, predictedMs),
    promptMs,
    predictedMs,
  }
}

/** The last SSE event in the tail that parses as JSON — `[DONE]` does not. */
function lastEvent(tail: string): FinalChunk | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (!payload.startsWith('{')) continue
    try {
      return JSON.parse(payload) as FinalChunk
    } catch {
      // A truncated first line of the tail: keep looking further back.
    }
  }
  return null
}
