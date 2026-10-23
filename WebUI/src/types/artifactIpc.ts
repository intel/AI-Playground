import { z } from 'zod'
import { ComfyInputSchema, ComfyUiPresetSchema } from '@/lib/presetSchemas'
import type { MediaItem } from './mediaItem'

/**
 * The `artifact:run` request as it crosses IPC — the renderer ships a fully
 * resolved run (step 5: preset entry, params, dynamic inputs, pre-registered
 * item stubs). Main re-validates it: the payload is data from another process,
 * and a preset that fails its schema here must fail the run, not the engine.
 */
export const ArtifactRunRequestSchema = z.object({
  runId: z.string().min(1),
  mode: z.enum(['imageGen', 'imageEdit', 'video']),
  preset: ComfyUiPresetSchema,
  params: z.object({
    prompt: z.string(),
    negativePrompt: z.string(),
    seed: z.number(),
    inferenceSteps: z.number(),
    width: z.number(),
    height: z.number(),
    batchSize: z.number().int().min(1),
  }),
  inputs: z.array(ComfyInputSchema.extend({ current: z.unknown() })),
  /** Item stubs the renderer registered so slots show immediately; the runner owns settlement. */
  items: z.array(z.object({ id: z.string().min(1) }).passthrough()).optional(),
  source: z.string().optional(),
  /**
   * The variant that was applied to `preset`. `applyVariant` keeps the full
   * variants list on the merged entry, so `preset.variants[0]` is not the
   * selected name.
   */
  variant: z.string().optional(),
  /** Who submitted: renderer drivers register UI items; in-process agent tools do not. */
  origin: z.enum(['renderer', 'agent']).optional(),
  modelsConsented: z.boolean().optional(),
  showPreview: z.boolean().optional(),
  safetyCheck: z.boolean().optional(),
  keepModelsLoaded: z.boolean().optional(),
  /** Chat conversation the run was asked from — routes orchestrator queue events. */
  conversationKey: z.string().optional(),
  /** The renderer activity the tool began for this run — lets queue events relabel it. */
  activityId: z.string().optional(),
})

export type ArtifactRunRequest = z.infer<typeof ArtifactRunRequestSchema>

/** How a submitted run settled — the `artifact:run` invoke's reply. */
export type ArtifactRunResult = {
  state: 'completed' | 'failed' | 'cancelled'
  items: MediaItem[]
  error?: string
}
