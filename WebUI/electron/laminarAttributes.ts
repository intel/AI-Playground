import os from 'node:os'
import { appLoggerInstance } from './logging/logger.ts'
import { llmServerSnapshot, type LocalLlmBackend } from './llmServerSnapshot.ts'

// ── What a trace has to say about the turn that produced it ──────────────────
//
// Token counts and durations are on every LLM span already; what Laminar cannot
// know is which of our backends served the turn, on what device, with which
// build and command line, whether it was thinking, and how fast it actually ran
// (prefill and generation are different numbers, and only the server can tell
// them apart). None of that has an official OpenTelemetry key, so it goes on as
// trace metadata (filterable on the Traces page) plus `aipg.*` span attributes.
//
// Both surfaces converge here. Neither can call `Laminar.setSpanAttributes()`:
// that writes to the span on the OTel *context*, and neither the Pi extension
// nor Laminar's AI SDK integration ever puts its spans there (the integration's
// own source says so — they are parked in a map). What both do is create and
// end their spans through the SDK's tracer, so a span processor sees every one
// of them. `stampSpanStart` / `stampSpanEnd` are that processor's hooks; the
// context they read is set per agent run (main) or per chat turn (renderer, via
// the telemetry IPC).

const logger = appLoggerInstance
const LOG_SOURCE = 'laminar'

/** Laminar's wire format for trace metadata; the Traces page filters on these. */
const METADATA_PREFIX = 'lmnr.association.properties.metadata.'
const SPAN_TYPE = 'lmnr.span.type'

export type InferenceBackend = LocalLlmBackend | 'cloud'

/** The turn's setup, as far as the surface running it knows. */
export type InferenceTraceContext = {
  /** Preset the turn was held with; agent runs carry theirs on the identity instead. */
  preset?: string
  backend?: InferenceBackend
  /** Device the local backend is set to (`GPU.0`, `NPU`, …). */
  device?: string
  /** Human-readable name of that device (`Intel Arc B580`, …). */
  deviceName?: string
  /** Provider id a cloud turn is routed to. */
  cloudProvider?: string
  /** Whether the model was told to think (`chat_template_kwargs.enable_thinking`). */
  thinking?: boolean
  /** Reasoning depth, for templates that read `reasoning_effort`. */
  reasoningEffort?: string
  /** Sampling that rides the request, under the OTel `gen_ai.request.*` names. */
  sampling?: { temperature?: number; topP?: number; maxTokens?: number }
  /**
   * This run is nested inside a tool call of the parent turn (the media
   * specialist). Read by laminar.ts to parent it there; never stamped, since it
   * describes where the trace belongs rather than how the turn was set up.
   */
  delegated?: boolean
}

/** Which run a trace belongs to, for the Traces page's metadata column and its filters. */
export type AgentRunIdentity = {
  /** Agent preset the turn was held with (`Game Agent`, `Acer Quick Coder`, …). */
  preset?: string
  /** The shape of the run, low-cardinality so it groups and filters. */
  type?: 'agent' | 'game-agent' | 'quick-coder'
  /** Capability ids, sorted and comma-joined. */
  capabilities?: string
  /** Our own session id (`aipg-agent-*`), which survives a Pi session rebuild. */
  appSession?: string
  /** Display name of the game being built, as of this turn. */
  game?: string
  /** Its folder slug, which never moves. */
  gameId?: string
}

/** How fast one model call actually ran. */
export type InferenceCallStats = {
  prefillTokensPerSecond?: number
  generationTokensPerSecond?: number
  promptMs?: number
  predictedMs?: number
  /** Prompt tokens served from the server's prefix cache (llama.cpp only). */
  cacheTokens?: number
}

type SpanAttributes = Record<string, string | number | boolean>

/**
 * Structural view of the span a processor is handed. Deliberately not typed
 * against `@opentelemetry/api`: the SDK is a devDependency loaded dynamically,
 * and all this needs is a name, a parent and an attribute bag.
 */
type ProcessedSpan = {
  name?: string
  attributes?: Record<string, unknown>
  parentSpanId?: string
  parentSpanContext?: { spanId?: string }
  isRecording?: () => boolean
  setAttribute?: (key: string, value: string | number | boolean) => unknown
  updateName?: (name: string) => unknown
  spanContext?: () => { spanId?: string; traceId?: string }
}

/** The name Pi gives an agent run's root span, and the only one we rename. */
const PI_ROOT_SPAN = 'pi agent run'

// ── The two surfaces' contexts ───────────────────────────────────────────────
//
// The agent's is a getter, because thinking can be switched off in the middle
// of a run (planningPhase.ts) and the span that follows should say so. The
// chat's is a value the renderer pushes before its turn starts.

let agentContext: (() => InferenceTraceContext | undefined) | null = null
let chatContext: InferenceTraceContext | null = null
let agentCallStats: InferenceCallStats | null = null
let chatCallStats: InferenceCallStats | null = null
let agentIdentity: (() => AgentRunIdentity | undefined) | null = null

export function setAgentTraceContext(get: () => InferenceTraceContext | undefined): void {
  agentContext = get
}

export function clearAgentTraceContext(): void {
  agentContext = null
  agentCallStats = null
}

/**
 * A getter for the same reason the context is one: the run is named while it
 * runs, so what a span says has to be read when that span starts.
 */
export function setAgentRunIdentity(get: () => AgentRunIdentity | undefined): void {
  agentIdentity = get
}

export function clearAgentRunIdentity(): void {
  agentIdentity = null
}

// ── How fast a whole run was ─────────────────────────────────────────────────
//
// The per-call speeds are on the LLM spans, which is where they belong, but the
// Traces list cannot reach into a trace's spans: its columns are expressions
// over the trace row, and Laminar's own per-trace numbers (tokens, cost) are
// aggregated at ingestion. So the run's own speeds are summed here and shipped
// as trace metadata, which a custom column reads (see AGENTS.md).
//
// Summed, not averaged: a duration-weighted mean is total tokens over total
// time, whereas a plain mean of the per-call numbers would let a five-token
// reply count as much as a two-thousand-token one.

type RunSpeeds = {
  /** The span the aggregate is written to: the last one of the run to end. */
  rootSpanId?: string
  generationTokens: number
  generationMs: number
  promptTokens: number
  promptMs: number
  calls: number
}

/** A trace whose root never ends (a crash mid-run) would otherwise stay forever. */
const MAX_TRACKED_RUNS = 32

const runSpeeds = new Map<string, RunSpeeds>()

export function setChatTraceContext(context: InferenceTraceContext | null): void {
  chatContext = context
}

/**
 * The numbers of the model call that just finished. Read by the next LLM span
 * that ends, which is that same call's — both surfaces end the span from the
 * code path that has already consumed the whole response.
 */
export function recordAgentCallStats(stats: InferenceCallStats): void {
  agentCallStats = stats
}

export function recordChatCallStats(stats: InferenceCallStats | null): void {
  chatCallStats = stats
}

// ── Span processor hooks ─────────────────────────────────────────────────────

/**
 * Chat spans come from Laminar's AI SDK integration, which names every one of
 * them `ai.<operation>`; agent spans come from the Pi extension (`pi agent run`,
 * `LLM call (turn N)`, tool names). One trace never mixes the two.
 */
function isChatSpan(span: ProcessedSpan): boolean {
  return (span.name ?? '').startsWith('ai.')
}

function isRootSpan(span: ProcessedSpan): boolean {
  return !span.parentSpanId && !span.parentSpanContext?.spanId
}

function contextFor(span: ProcessedSpan): InferenceTraceContext | undefined {
  return isChatSpan(span) ? (chatContext ?? undefined) : agentContext?.()
}

/**
 * Trace-wide facts, on the root span where Laminar reads a trace's metadata.
 * Pi's spans are all parentless at start (it links them by path attributes
 * afterwards), so an agent run carries them on every span and a chat turn on
 * `ai.streamText` alone — the Traces page is happy either way.
 */
export function stampSpanStart(started: unknown): void {
  try {
    const span = started as ProcessedSpan
    if (!isRootSpan(span)) return
    // The host is a fact of this process, not of the turn: stamp it even when
    // the renderer has not yet sent a context, so traces from two test boxes
    // never look interchangeable.
    apply(span, optional(`${METADATA_PREFIX}hostname`, hostName()))
    noteRunRoot(span)
    if (!isChatSpan(span)) labelAgentRun(span)
    const context = contextFor(span)
    if (!context) return
    const local =
      context.backend && context.backend !== 'cloud' ? llmServerSnapshot(context.backend) : {}
    apply(span, {
      ...optional(`${METADATA_PREFIX}preset`, context.preset),
      ...optional(`${METADATA_PREFIX}backend`, context.backend),
      ...optional(`${METADATA_PREFIX}device`, context.device ?? local.device),
      ...optional(`${METADATA_PREFIX}deviceName`, context.deviceName ?? local.deviceName),
      ...optional(`${METADATA_PREFIX}cloudProvider`, context.cloudProvider),
      ...optional(`${METADATA_PREFIX}backendVersion`, local.backendVersion),
      ...optional(`${METADATA_PREFIX}serverArgs`, local.serverArgs),
    })
  } catch (error) {
    logger.warn(`could not stamp trace metadata: ${error}`, LOG_SOURCE)
  }
}

/**
 * What the run was, on the row that stands for it. The metadata is what the
 * Traces table's column and filters read; the name is the row's own label, and
 * is only rewritten on the span Pi named, so nothing else can be caught by it.
 */
function labelAgentRun(span: ProcessedSpan): void {
  const identity = agentIdentity?.()
  if (!identity) return
  apply(span, {
    ...optional(`${METADATA_PREFIX}preset`, identity.preset),
    ...optional(`${METADATA_PREFIX}agentType`, identity.type),
    ...optional(`${METADATA_PREFIX}capabilities`, identity.capabilities),
    ...optional(`${METADATA_PREFIX}appSession`, identity.appSession),
    ...optional(`${METADATA_PREFIX}game`, identity.game),
    ...optional(`${METADATA_PREFIX}gameId`, identity.gameId),
  })
  if (span.name !== PI_ROOT_SPAN) return
  const label = [identity.preset, identity.game].filter(Boolean).join(' · ')
  if (label) rename(span, label)
}

function rename(span: ProcessedSpan, name: string): void {
  if (typeof span.updateName === 'function') span.updateName(name)
  else span.name = name
}

function hostName(): string | undefined {
  try {
    return os.hostname() || undefined
  } catch {
    return undefined
  }
}

/**
 * Per-call facts, on the LLM span. Everything is known by the time it ends —
 * including the speeds, which only exist once the response has been read — and
 * an ended span is the one place both surfaces reliably pass through.
 */
export function stampSpanEnd(ended: unknown): void {
  try {
    const span = ended as ProcessedSpan
    if (span.attributes?.[SPAN_TYPE] === 'LLM') {
      const chat = isChatSpan(span)
      const context = chat ? chatContext : agentContext?.()
      const stats = chat ? chatCallStats : agentCallStats
      if (chat) chatCallStats = null
      else agentCallStats = null
      apply(span, { ...requestAttributes(context), ...statsAttributes(stats) })
      noteCallSpeeds(span, stats)
    }
    // Every LLM call of the trace has ended by the time its root does, whichever
    // surface made them — a delegated media run's calls included.
    stampRunSpeeds(span)
  } catch (error) {
    logger.warn(`could not stamp LLM span: ${error}`, LOG_SOURCE)
  }
}

/**
 * The span a run's totals belong on: the one that outlives every call of it.
 * For an agent run that is the span Pi opens for the run, for a chat turn the
 * AI SDK operation that holds the calls — matched by name, since a span's type
 * is not set yet when the processor first sees it, and a nested `ai.llm` would
 * otherwise claim to be the root of anything it is not visibly parented to.
 * A delegated run is parented to the media tool call, so it is not a root and
 * its calls count towards the trace it was made for.
 */
const AI_SDK_OPERATIONS = [
  'ai.streamText',
  'ai.generateText',
  'ai.streamObject',
  'ai.generateObject',
]

function isRunRoot(span: ProcessedSpan): boolean {
  if (span.name === PI_ROOT_SPAN) return true
  const name = span.name ?? ''
  return isRootSpan(span) && AI_SDK_OPERATIONS.some((operation) => name.startsWith(operation))
}

function noteRunRoot(span: ProcessedSpan): void {
  if (!isRunRoot(span)) return
  const context = span.spanContext?.()
  if (!context?.traceId || !context.spanId) return
  speedsOf(context.traceId).rootSpanId = context.spanId
}

function speedsOf(traceId: string): RunSpeeds {
  const known = runSpeeds.get(traceId)
  if (known) return known
  const fresh: RunSpeeds = {
    generationTokens: 0,
    generationMs: 0,
    promptTokens: 0,
    promptMs: 0,
    calls: 0,
  }
  runSpeeds.set(traceId, fresh)
  while (runSpeeds.size > MAX_TRACKED_RUNS) {
    const oldest = runSpeeds.keys().next().value
    if (oldest === undefined) break
    runSpeeds.delete(oldest)
  }
  return fresh
}

/**
 * One call's contribution. Tokens are recovered from the speed and the duration
 * rather than read off `gen_ai.usage.*`: those two are what the span reports, so
 * the total cannot disagree with the calls it is made of, and a prompt served
 * from cache does not count as tokens the server processed.
 */
function noteCallSpeeds(span: ProcessedSpan, stats: InferenceCallStats | null): void {
  const traceId = span.spanContext?.().traceId
  if (!traceId || !stats) return
  const speeds = speedsOf(traceId)
  speeds.calls += 1
  if (stats.generationTokensPerSecond && stats.predictedMs) {
    speeds.generationMs += stats.predictedMs
    speeds.generationTokens += (stats.generationTokensPerSecond * stats.predictedMs) / 1000
  }
  if (stats.prefillTokensPerSecond && stats.promptMs) {
    speeds.promptMs += stats.promptMs
    speeds.promptTokens += (stats.prefillTokensPerSecond * stats.promptMs) / 1000
  }
}

function stampRunSpeeds(span: ProcessedSpan): void {
  const context = span.spanContext?.()
  if (!context?.traceId) return
  const speeds = runSpeeds.get(context.traceId)
  if (!speeds || speeds.rootSpanId !== context.spanId) return
  runSpeeds.delete(context.traceId)
  if (speeds.calls === 0) return
  apply(span, {
    [`${METADATA_PREFIX}llmCalls`]: speeds.calls,
    ...optional(`${METADATA_PREFIX}genTps`, rate(speeds.generationTokens, speeds.generationMs)),
    ...optional(`${METADATA_PREFIX}prefillTps`, rate(speeds.promptTokens, speeds.promptMs)),
  })
}

function rate(tokens: number, ms: number): number | undefined {
  if (ms <= 0) return undefined
  return Math.round((tokens / ms) * 1000 * 10) / 10
}

function requestAttributes(context: InferenceTraceContext | null | undefined): SpanAttributes {
  if (!context) return {}
  return {
    ...optional('aipg.thinking', context.thinking),
    ...optional('aipg.reasoning_effort', context.reasoningEffort),
    ...optional('gen_ai.request.temperature', context.sampling?.temperature),
    ...optional('gen_ai.request.top_p', context.sampling?.topP),
    ...optional('gen_ai.request.max_tokens', context.sampling?.maxTokens),
  }
}

function statsAttributes(stats: InferenceCallStats | null | undefined): SpanAttributes {
  if (!stats) return {}
  return {
    ...optional('aipg.prefill_tokens_per_second', stats.prefillTokensPerSecond),
    ...optional('aipg.generation_tokens_per_second', stats.generationTokensPerSecond),
    ...optional('aipg.prompt_ms', stats.promptMs),
    ...optional('aipg.predicted_ms', stats.predictedMs),
    ...optional('aipg.cache_n', stats.cacheTokens),
  }
}

function optional(key: string, value: string | number | boolean | undefined): SpanAttributes {
  return value === undefined ? {} : { [key]: value }
}

/**
 * A recording span takes attributes through the SDK; an ended one has to be
 * written to directly, since `setAttribute` is a no-op (with a warning) after
 * `end()`. The exporter reads the same bag, and a processor is called before
 * the span is queued, so the late write still ships.
 */
function apply(span: ProcessedSpan, attributes: SpanAttributes): void {
  const entries = Object.entries(attributes)
  if (entries.length === 0) return
  const recording = span.isRecording?.() === true && typeof span.setAttribute === 'function'
  for (const [key, value] of entries) {
    if (recording) span.setAttribute?.(key, value)
    else if (span.attributes) span.attributes[key] = value
  }
}
