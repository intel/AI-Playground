import z from 'zod'

export const llmBackendTypes = ['openVINO', 'llamaCPP', 'ollama'] as const

export const ModelSchema = z.object({
  name: z.string(),
  mmproj: z.string().optional(),
  downloaded: z.boolean().optional(),
  type: z.enum(['embedding', 'undefined', ...llmBackendTypes]),
  default: z.boolean(),
  backend: z.enum(llmBackendTypes).optional(),
  supportsToolCalling: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  maxContextSize: z.number().optional(),
  npuSupport: z.boolean().optional(),
})

//type Model = z.infer<typeof ModelSchema>
