import z from 'zod'

// 'cloud' is a remote OpenAI-compatible provider backend (e.g. a self-hosted
// or cloud LLM endpoint). Unlike openVINO/llamaCPP it has no local Python
// subprocess: inference is proxied directly to a configured provider base URL.
export const llmBackendTypes = ['openVINO', 'llamaCPP', 'cloud'] as const

// Tool-call parsers supported by the bundled OpenVINO Model Server (OVMS).
// Used for the `--tool_parser` flag; hermes3 is the fallback when unset.
export const ovmsToolParsers = [
  'llama3',
  'hermes3',
  'phi4',
  'mistral',
  'gptoss',
  'qwen3coder',
  'devstral',
  'lfm2',
  'gemma4',
] as const

// OVMS compiles a static graph for `--max_prompt_len` on NPU, so the window is
// paid for up front in compile time and memory — unlike GPU, which sizes its KV
// cache at runtime. The preset's context size therefore cannot be handed to NPU
// unchecked (agent presets ask for 128k), so it is capped here for that device.
export const OPENVINO_NPU_MAX_PROMPT_LEN = 8192

export const npuPromptLen = (contextSize?: number): number =>
  Math.min(contextSize ?? OPENVINO_NPU_MAX_PROMPT_LEN, OPENVINO_NPU_MAX_PROMPT_LEN)

// Sampling knobs a model publisher recommends. Names are camelCase here and
// mapped to the wire names (top_p, min_p, repeat_penalty, ...) when a request is
// built; see src/lib/samplingDefaults.ts.
const SamplingSchema = z
  .object({
    temperature: z.number(),
    topP: z.number(),
    topK: z.number(),
    minP: z.number(),
    presencePenalty: z.number(),
    frequencyPenalty: z.number(),
    repetitionPenalty: z.number(),
  })
  .partial()

// Depth of the reasoning trace, sent as chat_template_kwargs.reasoning_effort by
// templates that read it. Cheapest first, and exactly the levels Qwen3.8 accepts:
// its template raises "Unexpected reasoning effort" for anything else — including
// `none`, which the model card lists but the shipped GGUF template rejects (no
// thinking at all is the `enable_thinking` toggle's job, not an effort level).
export const reasoningEfforts = ['low', 'medium', 'xhigh'] as const

// Per-model recommended inference settings. The top-level keys are the shared
// base; `thinking` / `instruct` override it depending on the thinking toggle,
// because hybrid-thinking models want different sampling per mode.
export const InferenceDefaultsSchema = SamplingSchema.extend({
  thinking: SamplingSchema.optional(),
  instruct: SamplingSchema.optional(),
  reasoningEffort: z.enum(reasoningEfforts).optional(),
})

export type ReasoningEffort = (typeof reasoningEfforts)[number]
export type SamplingProfile = z.infer<typeof SamplingSchema>
export type InferenceDefaults = z.infer<typeof InferenceDefaultsSchema>

export const ModelSchema = z.object({
  name: z.string(),
  mmproj: z.string().optional(),
  downloaded: z.boolean().optional(),
  type: z.enum(['embedding', 'undefined', ...llmBackendTypes]),
  default: z.boolean().optional(), // No longer required - priority is determined by position in models.json
  backend: z.enum(llmBackendTypes).optional(),
  supportsReasoning: z.boolean().optional(),
  // Model template honors `chat_template_kwargs.enable_thinking` so thinking can
  // be toggled on/off per request (Qwen3 family, gemma4). Independent of
  // `supportsReasoning`: gemma4 defaults to thinking off but still supports the toggle.
  supportsThinkingToggle: z.boolean().optional(),
  supportsToolCalling: z.boolean().optional(),
  // OVMS tool-call parser override; defaults to 'hermes3' when omitted.
  toolParser: z.enum(ovmsToolParsers).optional(),
  supportsVision: z.boolean().optional(),
  // Good enough at writing code to drive a coding preset (Game Agent). A judgement
  // about the model's training rather than a hard capability like vision.
  supportsCoding: z.boolean().optional(),
  maxContextSize: z.number().optional(),
  // Sampling/reasoning settings the model publisher recommends. Applied as
  // defaults the preset or the user can still override.
  inferenceDefaults: InferenceDefaultsSchema.optional(),
  // Extra `llama-server` command-line flags this model wants, in the same
  // syntax as the backend-settings parameter box (e.g. speculative decoding).
  // Only the llama.cpp server sees them — OVMS takes a different command line.
  // Appended before the user's own parameters so a hand-written flag wins.
  llamaCppArgs: z.string().optional(),
  npuSupport: z.boolean().optional(),
  largeMoe: z.boolean().optional(), // Large Mixture-of-Experts model; Phison aiDAPTIV+ SSD offload enables loading models larger than VRAM
})

//type Model = z.infer<typeof ModelSchema>
