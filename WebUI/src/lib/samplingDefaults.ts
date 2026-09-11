import type { InferenceDefaults, ReasoningEffort, SamplingProfile } from '@/types/shared'

// ── Per-model recommended inference settings ─────────────────────────────────
//
// Model publishers ship sampling recommendations (Unsloth's model pages, for
// instance) and hybrid-thinking models want different numbers depending on
// whether the turn thinks. `models.json` carries them per model as
// `inferenceDefaults`; this module turns that declaration into the values the
// app actually applies: `temperature` and `reasoningEffort` feed the settings
// the user can override, everything else goes straight onto the request body.
//
// Kept free of store imports so both the renderer (chat) and the turn config
// the Electron agent runs on can use it, and so it is unit-testable on its own.

/** Which server the body is built for; they disagree on a few parameter names. */
export type SamplingDialect = 'llamaCPP' | 'openVINO'

/** Sampling for one mode: the shared base with the active profile merged over it. */
export function resolveSampling(
  defaults: InferenceDefaults | undefined,
  thinking: boolean,
): SamplingProfile {
  if (!defaults) return {}
  const { thinking: whenThinking, instruct, reasoningEffort: _reasoningEffort, ...base } = defaults
  return { ...base, ...(thinking ? whenThinking : instruct) }
}

/**
 * Whether a user-facing setting may take a new recommendation: it either still
 * holds the value adopted from the previous one, or — before anything was ever
 * adopted — the app's own default. Anything else was chosen deliberately and is
 * left alone.
 */
export function isAdoptable<T>(current: T, adopted: T | undefined, appDefault?: T): boolean {
  return adopted === undefined ? current === appDefault : current === adopted
}

/** The effort a model recommends, if it reads `reasoning_effort` at all. */
export function recommendedReasoningEffort(
  defaults: InferenceDefaults | undefined,
): ReasoningEffort | undefined {
  return defaults?.reasoningEffort
}

/**
 * The `chat_template_kwargs` a local turn carries.
 *
 * Whether the turn thinks has to be stated, not left to the template: Qwen3
 * thinks unless told otherwise and gemma4 does the reverse, so silence means
 * something different per family. Chat and agent turns build this from one
 * place because they drifted apart once — agent turns sent the effort but never
 * the toggle, which left the thinking switch doing nothing for a whole preset.
 */
export function chatTemplateKwargs(options: {
  supportsThinkingToggle: boolean
  thinkingEnabled: boolean
  thinkingActive: boolean
  reasoningEffort?: ReasoningEffort
}): Record<string, unknown> {
  const kwargs: Record<string, unknown> = {}
  if (options.supportsThinkingToggle) kwargs.enable_thinking = options.thinkingEnabled
  // A turn that does not think has no trace to size.
  if (options.reasoningEffort && options.thinkingActive) {
    kwargs.reasoning_effort = options.reasoningEffort
  }
  return kwargs
}

/**
 * The sampling fields as an OpenAI-compatible request body fragment.
 *
 * `temperature` is deliberately left out: it is a user-facing setting that
 * reaches the request through the chat call itself, so emitting it here too
 * would let a stale model default win over the slider.
 *
 * Dialects: llama.cpp names the repetition penalty `repeat_penalty` and also
 * accepts `min_p`, while OVMS knows neither — it takes `repetition_penalty` and
 * rejects parameters it does not model, so those two are shaped per server
 * rather than sent blindly to both.
 */
export function toRequestBody(
  profile: SamplingProfile,
  dialect: SamplingDialect = 'llamaCPP',
): Record<string, number> {
  const body: Record<string, number> = {}
  const put = (key: string, value: number | undefined) => {
    if (value !== undefined) body[key] = value
  }
  put('top_p', profile.topP)
  put('top_k', profile.topK)
  put('presence_penalty', profile.presencePenalty)
  put('frequency_penalty', profile.frequencyPenalty)
  if (dialect === 'llamaCPP') {
    put('min_p', profile.minP)
    put('repeat_penalty', profile.repetitionPenalty)
  } else {
    put('repetition_penalty', profile.repetitionPenalty)
  }
  return body
}
