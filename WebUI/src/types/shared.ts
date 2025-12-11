import z from 'zod'

export const llmBackendTypes = ['openVINO', 'llamaCPP', 'ollama'] as const

export const ModelSchema = z.object({
  name: z.string(),
  mmproj: z.string().optional(),
  downloaded: z.boolean().optional(),
  type: z.enum(['embedding', 'undefined', ...llmBackendTypes]),
  default: z.boolean().optional(), // No longer required - priority is determined by position in models.json
  backend: z.enum(llmBackendTypes).optional(),
  supportsReasoning: z.boolean().optional(),
  supportsToolCalling: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  maxContextSize: z.number().optional(),
  npuSupport: z.boolean().optional(),
})

//type Model = z.infer<typeof ModelSchema>
