import type { Telemetry } from 'ai'

// ── Laminar tracing for chat turns ───────────────────────────────────────────
//
// Chat runs on the Vercel AI SDK in the renderer, so its traces start here;
// agent turns run on Pi in the main process and are traced there
// (electron/laminar.ts).
//
// Laminar ships an AI SDK 7 integration, but it cannot run here: `@lmnr-ai/lmnr`
// is a Node library (it reached for `createRequire` and died on the browser
// stub), and this page is a browser page with `nodeIntegration` off — which is
// worth keeping. So only the *callbacks* live in the renderer: AI SDK 7 hands
// every telemetry event to a registered integration as plain data keyed by
// `callId`, and Laminar's integration is data-driven too (it keys its spans off
// `callId` / `stepNumber` and never inspects the model object), so the events
// can be forwarded to the main process and replayed into the real integration
// there. The span mapping, the exporter and the project key all stay in main.
//
// Off unless a Laminar config sits beside the app's external resources
// (`laminar.dev.json` / `laminar.localhost.json`) — see AGENTS.md,
// 'Tracing agent and chat turns (Laminar)'.

/** Events forwarded to main. `onChunk` is left out on purpose (see below). */
const FORWARDED = [
  'onStart',
  'onStepStart',
  'onLanguageModelCallStart',
  'onLanguageModelCallEnd',
  'onToolExecutionStart',
  'onToolExecutionEnd',
  'onStepEnd',
  'onEmbedStart',
  'onEmbedEnd',
  'onEnd',
  'onAbort',
  'onError',
] as const satisfies ReadonlyArray<keyof Telemetry>

/**
 * Two events of our own, on the same channel as the SDK's so they stay ordered
 * against them: the turn's backend/thinking setup, and llama.cpp's own timings.
 * The main process turns both into span attributes (electron/laminar.ts).
 */
const CHAT_CONTEXT_EVENT = 'aipgChatContext'
const CHAT_TIMINGS_EVENT = 'aipgChatTimings'

/** What the AI SDK's telemetry has no field for, because only this app knows it. */
export type ChatTraceContext = {
  /** Chat preset the turn was held with, so both surfaces label a trace the same way. */
  preset?: string
  backend?: 'llamaCPP' | 'openVINO' | 'cloud'
  device?: string
  deviceName?: string
  cloudProvider?: string
  thinking?: boolean
  reasoningEffort?: string
  sampling?: { temperature?: number; topP?: number; maxTokens?: number }
  /**
   * A nested run inside a tool call of the parent turn (the media specialist),
   * whose spans belong in the parent's trace rather than in one of their own.
   */
  delegated?: boolean
}

let registered = false

/** JSON-safe copy of an event: no functions, no cycles, Errors kept readable. */
function serializeEvent(event: unknown): string | null {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(event, (_key, value: unknown) => {
      if (typeof value === 'function') return undefined
      if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack }
      }
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[circular]'
        seen.add(value)
      }
      return value
    })
  } catch {
    return null
  }
}

/**
 * Register the forwarding telemetry integration. Safe to call more than once,
 * and never throws: a tracing problem must not cost the user a chat turn.
 */
export async function initLaminarTelemetry(): Promise<void> {
  if (registered) return
  try {
    const config = await window.electronAPI.getLaminarConfig()
    if (!config) return
    const { registerTelemetry } = await import('ai')
    const integration: Telemetry = Object.fromEntries(
      FORWARDED.map((name) => [
        name,
        (event: unknown) => {
          // Fire-and-forget: the send must not add latency to a streaming turn,
          // and a dropped span is not worth surfacing to the user.
          const payload = serializeEvent(event)
          if (payload !== null) window.electronAPI.laminarTelemetryEvent(name, payload)
        },
      ]),
      // `Telemetry`'s callbacks are typed per event; the forwarder is uniform
      // and only ever serializes, so the per-event types buy nothing here.
    ) as Telemetry
    registerTelemetry(integration)
    registered = true
    console.info(`[laminar] chat traces via main to ${config.baseUrl}:${config.httpPort}`)
  } catch (error) {
    console.warn('[laminar] chat traces disabled:', error)
  }
}

/**
 * How the turn about to run is set up. Sent once per turn, before the first
 * span exists; main keeps it as the context every chat span is stamped with.
 */
export function noteChatTraceContext(context: ChatTraceContext): void {
  send(CHAT_CONTEXT_EVENT, context)
}

/**
 * llama.cpp's `timings` for the step that just finished — the only source of a
 * real prefill-vs-generation split and of how much of the prompt its cache
 * served. Send it as the step's final chunk arrives, so it is in main before
 * the LLM span is closed; without it main falls back to the AI SDK's own
 * around-the-call measurements, which every backend has.
 */
export function noteChatTimings(timings: unknown): void {
  send(CHAT_TIMINGS_EVENT, timings)
}

/**
 * Whether tracing is on for this run. The single gate every producer checks —
 * without a config there is nobody in main to replay events into, so building
 * them at all is waste.
 */
export function laminarTelemetryActive(): boolean {
  return registered
}

/** Send one event of our own on the telemetry channel. See laminarSpans.ts. */
export function sendLaminarEvent(name: string, value: unknown): void {
  send(name, value)
}

function send(name: string, value: unknown): void {
  if (!registered) return
  const payload = serializeEvent(value)
  if (payload !== null) window.electronAPI.laminarTelemetryEvent(name, payload)
}

// `onChunk` is deliberately not forwarded: it fires per streamed chunk, which
// would put thousands of IPC messages on a single reply. All it feeds in
// Laminar's integration is the time-to-first-token attribute.
