import type { TraceAttributes } from './laminarSpans'
import type { GenerationSettings } from '@/assets/js/store/imageGenerationPresets'

// ── What a generation was asked for, for its trace ───────────────────────────
//
// "Why does this image look like that / why did it take four minutes" is a
// question about the run's parameters, and a `comfyui.generate` span naming only
// its preset cannot answer it. Two shapes are produced from one snapshot,
// because Laminar reads them differently: attributes are what its SQL can group
// and filter by, so they stay scalar and few, while the span's input is the
// whole picture, read by a human looking at one trace.
//
// A preset's own workflow inputs are the interesting half (checkpoint, LoRA,
// guidance, sampler — whatever that workflow exposes), and some of them hold a
// base64 data URI of an entire image. Those are described rather than recorded:
// a span is worth less than the megabytes it would ship, and every value that
// goes through here is capped.

/** One workflow input as the run resolved it, from `imageGeneration.comfyInputs`. */
export type TracedComfyInput = {
  nodeTitle: string
  nodeInput: string
  /** Setting type from the preset (`model`, `number`, `image`, …). */
  type: string
  value: unknown
}

export type ComfyRun = {
  preset: string
  variant?: string
  mode: string
  mediaType?: string
  /** The standard settings the preset considers relevant, prompts included. */
  settings: GenerationSettings
  /** Seed the batch starts from — `settings.seed` may still be the `-1` wildcard. */
  seed?: number
  batchSize?: number
  keepModelsLoaded?: boolean
  inputs?: TracedComfyInput[]
  /** Whether an image was handed to the run (Image Edit, or a tool call). */
  hasSourceImage?: boolean
}

export type TracedComfyRun = {
  attributes: TraceAttributes
  input: Record<string, unknown>
}

/** Inputs whose value is an image (a data URI), not something to record. */
const MEDIA_INPUT_TYPES = new Set(['image', 'video', 'inpaintMask', 'outpaintCanvas'])

/** What an optional model input holds when the user picked nothing. */
const MODEL_NONE = 'None'

/** A workflow input's value; long enough for a prompt-shaped one. */
const MAX_VALUE_CHARS = 300

/** Prompt and negative prompt, which are the point of the whole span. */
const MAX_TEXT_CHARS = 2000

export function comfyTraceParameters(run: ComfyRun): TracedComfyRun {
  const settings = run.settings ?? {}
  const inputs = run.inputs ?? []
  // The variant is part of the settings the preset resolved, so a caller does
  // not have to look it up a second time to have it on the span.
  const variant = run.variant ?? settings.variant
  const models = inputs
    .filter((input) => input.type === 'model')
    .map((input) => (typeof input.value === 'string' ? input.value : ''))
    .filter((name) => name !== '' && name !== MODEL_NONE)

  const attributes = defined({
    'aipg.preset': run.preset,
    'aipg.variant': variant,
    'aipg.mode': run.mode,
    'aipg.media_type': run.mediaType,
    'aipg.batch_size': run.batchSize,
    'aipg.keep_models_loaded': run.keepModelsLoaded,
    'aipg.seed': run.seed ?? settings.seed,
    'aipg.steps': settings.inferenceSteps,
    'aipg.width': settings.width,
    'aipg.height': settings.height,
    'aipg.resolution': settings.resolution,
    'aipg.models': models.length > 0 ? models.join(', ') : undefined,
    'aipg.source_image': run.hasSourceImage,
  })

  const workflowInputs = describeInputs(inputs)
  const input = defined({
    preset: run.preset,
    variant,
    mode: run.mode,
    mediaType: run.mediaType,
    prompt: text(settings.prompt),
    negativePrompt: text(settings.negativePrompt),
    seed: run.seed ?? settings.seed,
    steps: settings.inferenceSteps,
    width: settings.width,
    height: settings.height,
    resolution: settings.resolution,
    batchSize: run.batchSize,
    keepModelsLoaded: run.keepModelsLoaded,
    sourceImage: run.hasSourceImage,
    inputs: Object.keys(workflowInputs).length > 0 ? workflowInputs : undefined,
  })

  return { attributes, input }
}

/** Keyed by where the value goes in the workflow, which is what identifies it. */
function describeInputs(inputs: TracedComfyInput[]): Record<string, unknown> {
  const described: Record<string, unknown> = {}
  for (const input of inputs) {
    described[`${input.nodeTitle}.${input.nodeInput}`] = MEDIA_INPUT_TYPES.has(input.type)
      ? media(input.value)
      : value(input.value)
  }
  return described
}

/**
 * An image input, as a sentence. A data URI is summarized by what it weighs;
 * anything else a user can have set here is a reference (`aipg-media://…`, a
 * file name) and says more kept than measured.
 */
function media(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') return '<none>'
  if (!raw.startsWith('data:')) return cap(raw, MAX_VALUE_CHARS)
  const [header] = raw.split(',', 1)
  const kind = header.slice('data:'.length).split(';')[0] || 'binary'
  return `<${kind}, ${bytes(payloadBytes(raw))}>`
}

/** Base64 carries 3 bytes in every 4 characters, padding excluded. */
function payloadBytes(dataUri: string): number {
  const payload = dataUri.slice(dataUri.indexOf(',') + 1)
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

function bytes(count: number): string {
  if (count >= 1024 * 1024) return `${(count / (1024 * 1024)).toFixed(1)} MB`
  if (count >= 1024) return `${Math.round(count / 1024)} KB`
  return `${count} B`
}

/** Any other input value: kept as it is, unless it is unexpectedly large. */
function value(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  // A data URI in a non-image input would be a mistake, not a value worth
  // shipping; describe it like an image rather than trusting the cap.
  if (raw.startsWith('data:')) return media(raw)
  return cap(raw, MAX_VALUE_CHARS)
}

function text(raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : cap(raw, MAX_TEXT_CHARS)
}

function cap(raw: string, max: number): string {
  return raw.length <= max ? raw : `${raw.slice(0, max)}… [${raw.length} chars]`
}

function defined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, entry]) => entry !== undefined)) as T
}
