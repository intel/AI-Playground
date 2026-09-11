import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { z } from 'zod'
import { appLoggerInstance } from './logging/logger.ts'
import { externalResourcesDir } from './util.ts'
import {
  recordChatCallStats,
  setChatTraceContext,
  stampSpanEnd,
  stampSpanStart,
  type InferenceCallStats,
  type InferenceTraceContext,
} from './laminarAttributes.ts'
import {
  handleSpanEvent,
  isSpanEvent,
  noteSpanEnd,
  noteSpanStart,
  openMediaToolSpan,
} from './laminarSpans.ts'

// ── Laminar tracing ──────────────────────────────────────────────────────────
//
// Observability for the agentic system: one trace per Pi agent run (LLM + tool
// spans, via the official `@lmnr-ai/pi-extension`) and one per Vercel AI SDK
// chat call (registered in the renderer, see src/lib/laminarTelemetry.ts). Both
// export to whichever Laminar instance the config names.
//
// The config file is the whole switch: without `laminar.dev.json` or
// `laminar.localhost.json` beside the app's other external resources nothing is
// imported, nothing is initialized, and the app runs exactly as it did before.
// An installed build is included — a trace from the machine a tester reports a
// slow turn on is worth more than one from a developer's laptop — which is why
// both SDK packages ship, and why the import stays dynamic: a build missing
// them must lose its traces, not its startup.
//
// The renderer needs the same numbers to register its own telemetry, but must
// not have the project API key compiled into its bundle, so the config is read
// here and handed over through the `getLaminarConfig` IPC.

const logger = appLoggerInstance
const LOG_SOURCE = 'laminar'

const CONFIG_FILES = ['laminar.dev.json', 'laminar.localhost.json'] as const

/**
 * The Laminar SDK splits the endpoint into host and ports (`baseUrl` carries no
 * port), because traces and metadata go to different ones. Defaults are the
 * docker-compose app-server's.
 */
const LaminarConfigSchema = z.object({
  projectApiKey: z.string().min(1),
  baseUrl: z
    .string()
    .min(1)
    .default('http://localhost')
    .transform((value) => value.replace(/\/+$/, '')),
  httpPort: z.number().int().positive().default(8000),
  grpcPort: z.number().int().positive().default(8001),
  /**
   * How much of a recorded message list to keep, in characters (`LMNR_MAX_CHARS`
   * for the Pi extension). Its default of 20k clips from the *front*, which on
   * any turn after the first is all system prompt and old history — so the new
   * user message, at the end, is cut off, and Laminar's transcript (which reads
   * the prompt out of the LLM span's message list) shows no input at all. Big
   * enough here for a full agent prompt; each LLM span then carries its own copy,
   * so a long run costs megabytes of local trace storage.
   */
  maxChars: z.number().int().positive().default(1_000_000),
})

export type LaminarConfig = z.infer<typeof LaminarConfigSchema>

/** `undefined` until resolved once; `null` when tracing is off for this run. */
let resolved: LaminarConfig | null | undefined

/**
 * Laminar config for this run, or null when tracing is off (no file, or one
 * that is unreadable or incomplete). Read once — the file is an opt-in placed
 * before the app starts, not something that changes while it runs. In an
 * installed build that means dropping it into the app's `resources` folder; it
 * is never shipped, so a project API key cannot travel in an installer.
 */
export function laminarConfig(): LaminarConfig | null {
  if (resolved !== undefined) return resolved
  try {
    resolved = readConfig()
  } catch (error) {
    resolved = null
    logger.warn(`tracing disabled, config unreadable: ${error}`, LOG_SOURCE)
  }
  return resolved
}

/** The first config file that reads, parses and validates, or null for none. */
function readConfig(): LaminarConfig | null {
  const dir = externalResourcesDir()
  for (const name of CONFIG_FILES) {
    let contents: unknown
    try {
      contents = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'))
    } catch (error) {
      // Absent is the normal case; anything else is a file meant to be used.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        logger.warn(`ignoring ${name}: ${error}`, LOG_SOURCE)
      continue
    }
    const parsed = LaminarConfigSchema.safeParse(contents)
    if (!parsed.success) {
      logger.warn(`ignoring ${name}: ${parsed.error.message}`, LOG_SOURCE)
      continue
    }
    return parsed.data
  }
  return null
}

/**
 * Initialize the Laminar SDK for the main process, before any Pi session is
 * built.
 *
 * The Pi extension initializes the SDK itself, but only ever passes `baseUrl` —
 * so on a self-hosted instance it would export to the cloud's default ports
 * (443/8443) and every span would vanish. Its `initTracing` is a no-op once the
 * SDK is initialized, so getting in first is what makes the ports stick.
 *
 * It also resolves its own on/off switch from `LMNR_PROJECT_API_KEY`, and
 * disables itself when that is absent, so the key is put on the environment of
 * this process too.
 */
export async function initLaminarTracing(): Promise<void> {
  const config = laminarConfig()
  if (!config) return
  try {
    process.env.LMNR_PROJECT_API_KEY = config.projectApiKey
    process.env.LMNR_BASE_URL = config.baseUrl
    // Read by the Pi extension when it truncates what it records (see maxChars).
    process.env.LMNR_MAX_CHARS = String(config.maxChars)
    const { Laminar, LaminarSpanProcessor } = await import('@lmnr-ai/lmnr')
    if (!Laminar.initialized()) {
      Laminar.initialize({
        projectApiKey: config.projectApiKey,
        baseUrl: config.baseUrl,
        httpPort: config.httpPort,
        grpcPort: config.grpcPort,
        // Spans are minted from Pi's own event stream, so the SDK must not also
        // patch the LLM libraries in this process.
        instrumentModules: {},
        // The gRPC exporter would need a native addon inside Electron.
        forceHttp: true,
        spanProcessor: stampingSpanProcessor(
          new LaminarSpanProcessor({
            baseUrl: config.baseUrl,
            port: config.httpPort,
            apiKey: config.projectApiKey,
            forceHttp: true,
          }) as unknown as SpanProcessorHooks,
        ) as unknown as NonNullable<Parameters<typeof Laminar.initialize>[0]>['spanProcessor'],
      })
    }
    logger.info(
      `tracing to ${config.baseUrl}:${config.httpPort} (grpc ${config.grpcPort})`,
      LOG_SOURCE,
    )
  } catch (error) {
    // Fail open: an observability problem must never keep the app from starting.
    logger.warn(`tracing disabled: ${error}`, LOG_SOURCE)
    resolved = null
  }
}

/**
 * A span processor that stamps our own attributes, then hands the span to a
 * real `LaminarSpanProcessor`.
 *
 * It has to be a processor of our own and not a patched `LaminarSpanProcessor`:
 * `Laminar.initialize` wraps whatever it is given in a fresh
 * `LaminarSpanProcessor`, and for one of its own kind it lifts out the inner
 * processor and drops the object — patched hooks included. Anything else is
 * kept and called, which is the seam this uses.
 *
 * The wrapped processor therefore runs behind the SDK's own copy and repeats
 * its path bookkeeping. That is idempotent (the same parent id yields the same
 * path), and it is what keeps the export path entirely the SDK's — the exporter
 * it builds is not exported from the package.
 */
function stampingSpanProcessor(processor: SpanProcessorHooks): SpanProcessorHooks {
  return {
    onStart: (span, parentContext) => {
      stampSpanStart(span)
      noteSpanStart(span)
      processor.onStart(span, parentContext)
    },
    onEnd: (span) => {
      stampSpanEnd(span)
      noteSpanEnd(span)
      processor.onEnd(span)
    },
    forceFlush: () => processor.forceFlush(),
    shutdown: () => processor.shutdown(),
  }
}

type SpanProcessorHooks = {
  onStart(span: unknown, parentContext: unknown): void
  onEnd(span: unknown): void
  forceFlush(): Promise<void>
  shutdown(): Promise<void>
}

/**
 * Laminar's AI SDK integration, living in main on behalf of the renderer.
 *
 * The renderer cannot run the SDK (browser page, `nodeIntegration` off), but AI
 * SDK 7 telemetry is plain data keyed by `callId`, so the renderer forwards its
 * events here and they are replayed into the official integration — which is
 * what maps them to Laminar's span types, `gen_ai.*` attributes and token
 * counts. See src/lib/laminarTelemetry.ts for the sending half.
 */
let aiSdkTelemetry: Record<string, ((event: unknown) => void) | undefined> | null | undefined

async function chatTelemetry(): Promise<typeof aiSdkTelemetry> {
  if (aiSdkTelemetry !== undefined) return aiSdkTelemetry
  aiSdkTelemetry = null
  const config = laminarConfig()
  if (!config) return aiSdkTelemetry
  try {
    const { LaminarAiSdkTelemetry } = await import('@lmnr-ai/lmnr')
    // Already initialized by initLaminarTracing, so no options are needed: the
    // integration picks up the same tracer, endpoint and project key.
    aiSdkTelemetry = new LaminarAiSdkTelemetry() as unknown as NonNullable<typeof aiSdkTelemetry>
  } catch (error) {
    logger.warn(`chat traces disabled: ${error}`, LOG_SOURCE)
  }
  return aiSdkTelemetry
}

/**
 * Event names of our own on the same channel, carrying what the AI SDK's
 * telemetry has no field for: the turn's backend/thinking setup, llama.cpp's own
 * timings, and (in laminarSpans.ts) spans for renderer work that is not a model
 * call at all. They share the channel because it keeps them ordered against the
 * SDK's events — the numbers have to be here before the span they belong to is
 * replayed and ended.
 */
const CHAT_CONTEXT_EVENT = 'aipgChatContext'
const CHAT_TIMINGS_EVENT = 'aipgChatTimings'

/** llama.cpp's `timings` object, as the chat store captures it off a raw chunk. */
type LlamaCppTimings = {
  cache_n?: number
  prompt_ms?: number
  prompt_per_second?: number
  predicted_ms?: number
  predicted_per_second?: number
}

/** The AI SDK's own measurements, on every `onLanguageModelCallEnd` event. */
type CallPerformance = {
  responseTimeMs?: number
  inputTokensPerSecond?: number
  outputTokensPerSecond?: number
  effectiveOutputTokensPerSecond?: number
  timeToFirstOutputMs?: number
}

let chatTimings: LlamaCppTimings | null = null

/**
 * The event on which Laminar's integration creates a call's top-level span; it
 * keeps that span's context and parents the call's steps to it itself.
 */
const AI_SDK_CALL_START = 'onStart'

/**
 * Set by a context that declares its run delegated, and consumed by that run's
 * `onStart`. One `streamText` sends one context and fires one `onStart`, so the
 * flag cannot outlive the run it was meant for — which matters because the
 * parent of a delegated run is Pi, in this process, and never sends a context
 * of its own to clear it.
 */
let delegatedRun = false

/**
 * Replay one forwarded AI SDK telemetry event. `payload` is the JSON the
 * renderer serialized (functions and cycles already removed).
 */
export async function handleChatTelemetryEvent(name: string, payload: string): Promise<void> {
  if (isSpanEvent(name)) {
    await handleSpanEvent(name, payload)
    return
  }
  if (name === CHAT_CONTEXT_EVENT || name === CHAT_TIMINGS_EVENT) {
    try {
      const value = JSON.parse(payload) as unknown
      if (name === CHAT_CONTEXT_EVENT) {
        const context = value as InferenceTraceContext | null
        delegatedRun = context?.delegated === true
        setChatTraceContext(context)
      } else chatTimings = value as LlamaCppTimings | null
    } catch (error) {
      logger.warn(`dropped chat telemetry event '${name}': ${error}`, LOG_SOURCE)
    }
    return
  }
  const telemetry = await chatTelemetry()
  const callback = telemetry?.[name]
  if (!callback) return
  try {
    const event = JSON.parse(payload) as Record<string, unknown>
    // A serialized Error is a plain object again; the integration only records
    // an exception properly for a real one.
    const failure = event.error
    if (failure && typeof failure === 'object' && 'message' in failure) {
      const rebuilt = new Error(String((failure as { message?: unknown }).message))
      rebuilt.stack = String((failure as { stack?: unknown }).stack ?? rebuilt.stack)
      event.error = rebuilt
    }
    // This event ends the LLM span, synchronously, inside the callback — so the
    // call's speeds have to be handed over first for the processor to stamp.
    if (name === 'onLanguageModelCallEnd') {
      recordChatCallStats(chatCallStats(event.performance as CallPerformance | undefined))
      chatTimings = null
    }
    if (name === AI_SDK_CALL_START && delegatedRun) {
      delegatedRun = false
      await underMediaToolCall(() => callback(event))
      return
    }
    callback(event)
  } catch (error) {
    logger.warn(`dropped chat telemetry event '${name}': ${error}`, LOG_SOURCE)
  }
}

/**
 * Create a delegated run's top-level span inside the media tool call it serves.
 *
 * The media specialist (assets/js/agents/mediaAgent.ts) is a nested AI SDK run
 * inside a `media` tool call of the parent turn, and it is where the two model
 * calls around a generation happen: one to pick the workflow and write the
 * prompt, one to report what came back. Laminar's integration reads their
 * parent off the OpenTelemetry context, which nothing sets here — so they
 * formed a trace of their own, beside the trace holding the generation they
 * asked for. `withSpan` puts the tool span on the context for exactly the
 * statement that creates the span, and the association properties it carries
 * (Pi's session id, the trace metadata) come along.
 */
async function underMediaToolCall(create: () => void): Promise<void> {
  const parent = openMediaToolSpan()
  if (!parent) {
    create()
    return
  }
  let created = false
  const once = () => {
    created = true
    create()
  }
  try {
    const { Laminar } = await import('@lmnr-ai/lmnr')
    Laminar.withSpan(parent as Parameters<typeof Laminar.withSpan>[0], once)
  } catch (error) {
    logger.warn(`could not parent a delegated run: ${error}`, LOG_SOURCE)
    if (!created) create()
  }
}

/**
 * Prefer llama.cpp's own numbers — it separates prefill from generation itself
 * and reports how much of the prompt its cache served. Everything else (OVMS,
 * cloud) falls back to what the AI SDK measured around the call: input tokens
 * over the wait for the first output chunk, output tokens over the rest.
 */
function chatCallStats(performance: CallPerformance | undefined): InferenceCallStats {
  const timings = chatTimings
  if (timings?.predicted_per_second !== undefined) {
    return {
      prefillTokensPerSecond: timings.prompt_per_second,
      generationTokensPerSecond: timings.predicted_per_second,
      promptMs: timings.prompt_ms,
      predictedMs: timings.predicted_ms,
      cacheTokens: timings.cache_n,
    }
  }
  if (!performance) return {}
  const { responseTimeMs, timeToFirstOutputMs } = performance
  return {
    prefillTokensPerSecond: performance.inputTokensPerSecond,
    generationTokensPerSecond:
      performance.outputTokensPerSecond ?? performance.effectiveOutputTokensPerSecond,
    promptMs: timeToFirstOutputMs,
    predictedMs:
      responseTimeMs !== undefined && timeToFirstOutputMs !== undefined
        ? responseTimeMs - timeToFirstOutputMs
        : undefined,
  }
}

/** Flush whatever has not been exported yet. Called from the app's teardown. */
export async function shutdownLaminarTracing(): Promise<void> {
  if (!laminarConfig()) return
  try {
    const { Laminar } = await import('@lmnr-ai/lmnr')
    if (Laminar.initialized()) await Laminar.shutdown()
  } catch (error) {
    logger.warn(`failed to flush traces: ${error}`, LOG_SOURCE)
  }
}

/**
 * Path of the Laminar Pi extension, for `additionalExtensionPaths`, or
 * undefined when tracing is off or the package is absent. Pi loads it with jiti,
 * so the TypeScript entry from its own `pi.extensions` manifest is what to hand
 * over — same arrangement as the memory capability's `pi-hermes-memory`.
 */
export function laminarPiExtensionPath(): string | undefined {
  if (!laminarConfig()) return undefined
  try {
    return createRequire(import.meta.url).resolve('@lmnr-ai/pi-extension/src/index.ts')
  } catch (error) {
    logger.warn(`agent traces disabled, @lmnr-ai/pi-extension is missing: ${error}`, LOG_SOURCE)
    return undefined
  }
}
