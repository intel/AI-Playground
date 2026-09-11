import { appLoggerInstance } from './logging/logger.ts'

// ── Spans the renderer asks for ──────────────────────────────────────────────
//
// The renderer describes a span (src/lib/laminarSpans.ts); this is where it
// becomes one. Two events on the chat-telemetry channel carry it, and the only
// state kept here is what is needed to close a span again and to know what to
// parent it to.
//
// Parenting is the interesting half. A media tool call is Pi's (or the AI SDK's)
// TOOL span, and neither surface puts its spans on the OpenTelemetry active
// context — so `Laminar.withSpan` around the IPC dispatch would not reach them.
// What both do is create their spans through the SDK's tracer, so the stamping
// span processor sees every one: `noteSpanStart` remembers the open media TOOL
// spans and a renderer span with no explicit parent nests under the oldest one.
//
// Oldest, not newest, because models ask for a whole spritesheet at once and
// both harnesses dispatch those tool calls in parallel, while the media pipeline
// runs them one at a time in call order (assets/js/tools/mediaPipeline.ts). The
// oldest open media TOOL span is therefore the call whose generation is running.

const logger = appLoggerInstance
const LOG_SOURCE = 'laminar'

const SPAN_START_EVENT = 'aipgSpanStart'
const SPAN_END_EVENT = 'aipgSpanEnd'

const SPAN_TYPE = 'lmnr.span.type'
const SPAN_INPUT = 'lmnr.span.input'
const SPAN_OUTPUT = 'lmnr.span.output'

/** AI SDK tool spans are named after the tool, behind this prefix. */
const AI_SDK_TOOL_PREFIX = 'ai.tool '

/**
 * Tools whose work runs in the renderer and is what these spans describe: the
 * agent's (`media`, or `generateImage` / `editImage` with delegation off) and
 * chat's (`comfyUI`, `comfyUiImageEdit`).
 */
const MEDIA_TOOLS = new Set(['media', 'generateImage', 'editImage', 'comfyUI', 'comfyUiImageEdit'])

/** What a span processor hands over, as far as this file cares. */
type ProcessedSpan = {
  name?: string
  attributes?: Record<string, unknown>
  spanContext?: () => { spanId?: string }
}

type LiveSpan = {
  setAttributes: (attributes: Record<string, string | number | boolean>) => unknown
  setAttribute: (key: string, value: string | number | boolean) => unknown
  setStatus: (status: { code: number; message?: string }) => unknown
  end: () => void
}

/** Renderer spans still open, by the id the renderer gave them. */
const openSpans = new Map<string, LiveSpan>()

/**
 * A reload takes the renderer's side of the bookkeeping with it, orphaning
 * whatever it had open. Closing the oldest keeps that from growing without
 * bound, and an orphan is worth more ended (it exports) than not.
 */
const MAX_OPEN_SPANS = 64

/** Open media TOOL spans, oldest first (Map keeps insertion order). */
const openToolSpans = new Map<string, ProcessedSpan>()

export function isSpanEvent(name: string): boolean {
  return name === SPAN_START_EVENT || name === SPAN_END_EVENT
}

/** Remember a media TOOL span as the parent for renderer spans under it. */
export function noteSpanStart(started: unknown): void {
  try {
    const span = started as ProcessedSpan
    if (!isMediaToolSpan(span)) return
    const id = span.spanContext?.().spanId
    if (id) openToolSpans.set(id, span)
  } catch (error) {
    logger.warn(`could not track a tool span: ${error}`, LOG_SOURCE)
  }
}

export function noteSpanEnd(ended: unknown): void {
  try {
    const id = (ended as ProcessedSpan).spanContext?.().spanId
    if (id) openToolSpans.delete(id)
  } catch (error) {
    logger.warn(`could not untrack a tool span: ${error}`, LOG_SOURCE)
  }
}

/**
 * A Pi TOOL span carries its type from creation; the AI SDK integration sets it
 * one statement later, after the tracer (and this processor) has already run —
 * so its name is all there is to go on at start.
 */
function isMediaToolSpan(span: ProcessedSpan): boolean {
  const name = span.name ?? ''
  if (name.startsWith(AI_SDK_TOOL_PREFIX)) {
    return MEDIA_TOOLS.has(name.slice(AI_SDK_TOOL_PREFIX.length))
  }
  return span.attributes?.[SPAN_TYPE] === 'TOOL' && MEDIA_TOOLS.has(name)
}

type SpanStartEvent = {
  id?: string
  name?: string
  parentId?: string
  input?: unknown
  attributes?: Record<string, unknown>
}

type SpanEndEvent = {
  id?: string
  /** What the span was asked to do, when that was only known later. */
  input?: unknown
  output?: unknown
  error?: string
  attributes?: Record<string, unknown>
}

/**
 * Create or finish one renderer span. Fails open in every direction: tracing
 * off, the SDK absent from a packaged build, an id that was never started.
 */
export async function handleSpanEvent(name: string, payload: string): Promise<void> {
  try {
    const event = JSON.parse(payload) as SpanStartEvent | SpanEndEvent
    if (name === SPAN_START_EVENT) await startSpan(event as SpanStartEvent)
    else endSpan(event as SpanEndEvent)
  } catch (error) {
    logger.warn(`dropped span event '${name}': ${error}`, LOG_SOURCE)
  }
}

type LaminarSdk = (typeof import('@lmnr-ai/lmnr'))['Laminar']
/** What `getLaminarSpanContext` accepts — anything the tracer produced. */
type SdkSpan = Parameters<LaminarSdk['getLaminarSpanContext']>[0]

async function startSpan(event: SpanStartEvent): Promise<void> {
  if (!event.id || !event.name) return
  const { Laminar } = await import('@lmnr-ai/lmnr')
  if (!Laminar.initialized()) return
  const parent = parentSpan(event.parentId)
  const parentSpanContext = parent
    ? (Laminar.getLaminarSpanContext(parent as SdkSpan) ?? undefined)
    : undefined
  const span = Laminar.startSpan({
    name: event.name,
    ...(event.input === undefined ? {} : { input: event.input }),
    ...(parentSpanContext ? { parentSpanContext } : {}),
  }) as unknown as LiveSpan
  const attributes = spanAttributes(event.attributes)
  if (Object.keys(attributes).length > 0) span.setAttributes(attributes)
  openSpans.set(event.id, span)
  while (openSpans.size > MAX_OPEN_SPANS) {
    const [oldest, orphan] = openSpans.entries().next().value as [string, LiveSpan]
    openSpans.delete(oldest)
    orphan.end()
  }
}

/**
 * An explicit parent is another renderer span (a generate phase under its
 * generate). Without one, the media tool call currently being served is the
 * parent — and when there is none (desktop Image Gen), the span is a root, which
 * the stamping processor still tags with the host it ran on.
 *
 * The parent's `LaminarSpanContext` carries Pi's session id and the trace
 * metadata with it, so a child lands in the agent's session without this file
 * knowing anything about sessions.
 */
function parentSpan(parentId: string | undefined): LiveSpan | ProcessedSpan | undefined {
  const explicit = parentId === undefined ? undefined : openSpans.get(parentId)
  return explicit ?? openMediaToolSpan()
}

/**
 * The media tool call whose work is running: the oldest open one (see the note
 * on parenting at the top). Also what a delegated AI SDK run is parented to —
 * see `handleChatTelemetryEvent` in laminar.ts.
 */
export function openMediaToolSpan(): ProcessedSpan | undefined {
  for (const span of openToolSpans.values()) return span
  return undefined
}

function endSpan(event: SpanEndEvent): void {
  if (!event.id) return
  const span = openSpans.get(event.id)
  if (!span) return
  openSpans.delete(event.id)
  const attributes = spanAttributes(event.attributes)
  if (Object.keys(attributes).length > 0) span.setAttributes(attributes)
  // A generation's parameters are resolved after its span opened, so they arrive
  // here; a span exports when it ends, which is why late is not too late.
  if (event.input !== undefined) {
    span.setAttribute(SPAN_INPUT, JSON.stringify(event.input))
  }
  if (event.output !== undefined) {
    span.setAttribute(SPAN_OUTPUT, JSON.stringify(event.output))
  }
  // SpanStatusCode.ERROR, spelled out rather than imported: @opentelemetry/api
  // rides along with the SDK, which is a devDependency loaded dynamically.
  if (event.error !== undefined) span.setStatus({ code: 2, message: event.error })
  span.end()
}

function spanAttributes(
  raw: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attributes[key] = value
    }
  }
  return attributes
}
