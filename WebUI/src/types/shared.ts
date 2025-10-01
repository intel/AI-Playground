import z from 'zod'

export const llmBackendTypes = ['openVINO', 'ipexLLM', 'llamaCPP', 'ollama'] as const

export const ModelSchema = z.object({
  name: z.string(),
  downloaded: z.boolean().optional(),
  type: z.enum([
    'embedding',
    'stableDiffusion',
    'inpaint',
    'lora',
    'vae',
    'undefined',
    ...llmBackendTypes,
  ]),
  default: z.boolean(),
  backend: z.enum(llmBackendTypes).optional(),
})

//type Model = z.infer<typeof ModelSchema>
