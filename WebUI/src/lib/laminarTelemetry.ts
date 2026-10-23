// ── Laminar tracing: the renderer's send half ────────────────────────────────
//
// Chat inference runs in the main process (step 6), so the AI SDK's telemetry
// events — and the Laminar integration they are replayed into — live there.
// What still starts here is the renderer's own work: the spans for ComfyUI
// phases and GPU swaps (laminarSpans.ts), which ride the same IPC channel so
// they stay ordered against the SDK's events.
//
// Off unless a Laminar config sits beside the app's external resources
// (`laminar.dev.json` / `laminar.localhost.json`) — see AGENTS.md,
// 'Tracing agent and chat turns (Laminar)'.

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
 * Resolve tracing on/off from the config main reads. Safe to call more than
 * once, and never throws: a tracing problem must not cost the user a turn.
 * Gates the span events this process still sends (laminarSpans.ts).
 */
export async function initLaminarTelemetry(): Promise<void> {
  if (registered) return
  try {
    const config = await window.electronAPI.getLaminarConfig()
    if (!config) return
    registered = true
    console.info(`[laminar] renderer spans via main to ${config.baseUrl}:${config.httpPort}`)
  } catch (error) {
    console.warn('[laminar] renderer spans disabled:', error)
  }
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
