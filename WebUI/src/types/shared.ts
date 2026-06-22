import z from 'zod'

export const llmBackendTypes = ['openVINO', 'llamaCPP'] as const

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

export const ModelSchema = z.object({
  name: z.string(),
  mmproj: z.string().optional(),
  downloaded: z.boolean().optional(),
  type: z.enum(['embedding', 'undefined', ...llmBackendTypes]),
  default: z.boolean().optional(), // No longer required - priority is determined by position in models.json
  backend: z.enum(llmBackendTypes).optional(),
  supportsReasoning: z.boolean().optional(),
  supportsToolCalling: z.boolean().optional(),
  // OVMS tool-call parser override; defaults to 'hermes3' when omitted.
  toolParser: z.enum(ovmsToolParsers).optional(),
  supportsVision: z.boolean().optional(),
  maxContextSize: z.number().optional(),
  npuSupport: z.boolean().optional(),
  largeMoe: z.boolean().optional(), // Large Mixture-of-Experts model; Phison aiDAPTIV+ SSD offload enables loading models larger than VRAM
})

//type Model = z.infer<typeof ModelSchema>
