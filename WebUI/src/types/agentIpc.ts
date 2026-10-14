import z from 'zod'
import { ChatModelConfigSchema, MediaAgentCatalogSchema } from './chatIpc'

const SamplingParamsSchema = z.record(z.string(), z.unknown())

const LocalModelConfigSchema = z.object({
  source: z.literal('local'),
  model: z.string().min(1),
  baseUrl: z.string().min(1),
  backend: z.enum(['llamaCPP', 'openVINO']).optional(),
  device: z.string().optional(),
  deviceName: z.string().optional(),
  contextWindow: z.number().optional(),
  supportsVision: z.boolean().optional(),
  samplingParams: SamplingParamsSchema.optional(),
})

const CloudModelConfigSchema = z.object({
  source: z.literal('cloud'),
  model: z.string().min(1),
  upstreamBaseUrl: z.string().min(1),
  providerId: z.string().min(1),
  authStyle: z.string().min(1),
  contextWindow: z.number().optional(),
  supportsVision: z.boolean().optional(),
  /**
   * Whether the provider's own catalog declared this model as reasoning. Decides
   * whether the turn asks for thinking at all (agent/piCloudReasoning.ts); a
   * provider that advertises nothing is assumed capable elsewhere, which is too
   * loose a signal to put request parameters on.
   */
  reasoningAdvertised: z.boolean().optional(),
})

export const AgentModeModelConfigSchema = z.discriminatedUnion('source', [
  LocalModelConfigSchema,
  CloudModelConfigSchema,
])

export const AgentToolSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  workspacePathInputs: z.array(z.string()).optional(),
  /** Workflow to run when the model's call names none (generate tool). */
  defaultWorkflow: z.string().optional(),
})

export const AgentModeTurnConfigSchema = z.object({
  sessionId: z.string().min(1),
  workspaceDir: z.string().min(1),
  modelConfig: AgentModeModelConfigSchema,
  toolSpecs: z.array(AgentToolSpecSchema).optional(),
  /**
   * Inner specialist catalog, shipped when the turn has the NL `media` tool.
   * Main runs those Comfy tools in-process (step 12); the renderer only
   * resolves which workflows are enabled.
   */
  mediaAgent: MediaAgentCatalogSchema.optional(),
  instructions: z.string().optional(),
  /** The agent preset this turn was held with, for labelling its trace. */
  presetName: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  mcpServerIds: z.array(z.string()).optional(),
  unsandboxed: z.boolean().optional(),
  planningThinkingOnly: z.boolean().optional(),
  /** Downloaded embedding model for the `rag` capability; absent disables it. */
  embeddingModel: z.string().optional(),
  embeddingBackend: z.enum(['llamaCPP', 'openVINO']).optional(),
  /** Developer setting: skip the GPU swap around in-process media calls. */
  keepModelsLoaded: z.boolean().optional(),
  /**
   * Local backend load facts (step 15). Main occupies as a `text` request then
   * loads; absent for cloud and for older tests that only exercise the harness.
   */
  readiness: ChatModelConfigSchema.shape.readiness,
})

export type AgentModeModelConfig = z.infer<typeof AgentModeModelConfigSchema>
export type AgentToolSpec = z.infer<typeof AgentToolSpecSchema>
export type AgentModeTurnConfig = z.infer<typeof AgentModeTurnConfigSchema>

/**
 * An `agentMode:executeTool` dispatch: main hands a renderer-implemented tool
 * call to the window to run, and the renderer answers over `agentMode:toolResult`.
 */
export type AgentToolExecuteRequest = {
  requestId: string
  /** Model-side tool call id, matching the UI message part (progress keying). */
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

export type AgentCapabilityInfo = {
  id: string
  label: string
  summary: string
  requires: string[]
  commands: { command: string; description: string }[]
  unavailableReason?: string
}

/** A row in the arcade manager: what the gallery could list, and whether it does. */
export type ArcadeCatalogEntry = {
  /** `user` is a game in the library, `sample` one of the games the app ships. */
  kind: 'user' | 'sample'
  /** Folder name — under the library root for a game, under the samples folder. */
  id: string
  name: string
  description: string
  createdAt: number
  iconUrl?: string
  /** Whether the arcade page lists it as things stand. */
  shown: boolean
}

export type GameLibraryEntry = {
  id: string
  name: string
  description: string
  entry: string
  icon?: string
  published: boolean
  createdAt: number
  updatedAt: number
  /** How the first turn ran; absent on games made before this was recorded. */
  backend?: string
  startingModel?: string
  initialPrompt?: string
  dir: string
  entryPath: string
  iconPath?: string
  iconUrl?: string
}
