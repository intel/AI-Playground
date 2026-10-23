import { z } from 'zod'
import type { UIMessageChunk } from 'ai'
import { ConversationThreadMetaSchema } from './conversationIpc'

// The chat-turn IPC contract (docs/architecture-target.md §7, step 6): the
// renderer's Chat keeps message state and tool cards, but the AI SDK call
// (`streamText`) lives in main. A turn is submitted as resolved data — model
// config, system prompt, serialized tool specs — and streams back as kernel
// `chat-chunk` events (coalesced at the bus). Tool bodies run in main too; the
// ones that need a human answer or the window itself ask for that one answer
// over `chat:ask` (see `chatRequests.ts`) rather than handing the body back.

/** `textInference.backend` — which inference surface the turn runs on. */
export const ChatBackendSchema = z.enum(['llamaCPP', 'openVINO', 'cloud'])
export type ChatBackend = z.infer<typeof ChatBackendSchema>

export const ChatEmbeddingServiceSchema = z.enum(['llamacpp-backend', 'openvino-backend'])

/**
 * Document ids + query for kernel RAG retrieval after GPU admit (step 9).
 * The renderer does not precompute context; main reads the kernel-owned
 * document file, embeds, and augments the system prompt.
 */
export const ChatRagRequestSchema = z.object({
  query: z.string(),
  documentHashes: z.array(z.string()).min(1),
  useGroupRetrieval: z.boolean(),
  embeddingServiceName: ChatEmbeddingServiceSchema,
  embeddingModel: z.string().min(1),
  maxResults: z.number().int().positive(),
  perDocResults: z.number().int().positive(),
})
export type ChatRagRequest = z.infer<typeof ChatRagRequestSchema>

/**
 * Everything the main-side model factory needs, resolved by the renderer at
 * submit time. Backend selection, sampling and thinking kwargs are renderer
 * state; main re-roots the endpoint per request (the llama-server port moves
 * across mid-turn relaunches) and attaches proxy headers itself.
 */
export const ChatModelConfigSchema = z.object({
  backend: ChatBackendSchema,
  /** Model id as the backend expects it on the wire. */
  modelId: z.string(),
  /** The renderer's live backend base URL (main re-resolves per request). */
  baseUrl: z.string().optional(),
  /** Cloud "default" placeholder: omit `model` from the request body. */
  omitModelInBody: z.boolean().optional(),
  /** Cloud provider the turn calls. Main fetches this base and attaches the stored key. */
  cloud: z
    .object({
      providerId: z.string(),
      upstreamBaseUrl: z.string().optional(),
      authStyle: z.string(),
    })
    .optional(),
  /** Home Agent active: route through its Flask proxy with upstream + auth headers. */
  homeAgentUpstreamUrl: z.string().optional(),
  /**
   * Local backend load facts: `runChatTurn` admits the turn as a text request,
   * then loads before streaming. Absent for cloud / Home Agent relays, which
   * are never restarted mid-turn.
   */
  readiness: z
    .object({
      serviceName: z.string(),
      llmModelName: z.string(),
      embeddingModelName: z.string().optional(),
      contextSize: z.number().optional(),
      modelArgs: z.string().optional(),
    })
    .optional(),
  /** Sampling the publisher recommends + user settings (`textInference.samplingRequestBody`). */
  samplingRequestBody: z.record(z.string(), z.unknown()).optional(),
  /** Thinking toggles / reasoning effort, merged into `chat_template_kwargs`. */
  chatTemplateKwargs: z.record(z.string(), z.unknown()).optional(),
  temperature: z.number().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** Vision-capable model: keep image parts (and cap replayed history images). */
  supportsVision: z.boolean().optional(),
  /** Cloud providers inline reasoning; extract it into reasoning parts. */
  extractReasoning: z.boolean().optional(),
  /** Trace context for the turn (no-op unless the developer opted into tracing). */
  trace: z.record(z.string(), z.unknown()).optional(),
  /** Ask llama.cpp for per-token timings in raw chunks (`timings_per_token`). */
  timingsPerToken: z.boolean().optional(),
})
export type ChatModelConfig = z.infer<typeof ChatModelConfigSchema>

/**
 * A chat tool as it crosses to main: name, description and JSON Schema only.
 * The body runs in main unless the tool is on the engine's bridged allowlist.
 */
export const ChatToolSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
})
export type ChatToolSpec = z.infer<typeof ChatToolSpecSchema>

/** Repair data for a comfy tool's malformed workflow field (src/lib/comfyToolRepair). */
export const WorkflowRepairDataSchema = z.object({
  names: z.array(z.string()),
  defaultWorkflow: z.string(),
})
export type WorkflowRepairData = z.infer<typeof WorkflowRepairDataSchema>

/** Inner specialist catalog, frozen at submit time (Chat and Agent Mode). */
export const MediaAgentCatalogSchema = z.object({
  system: z.string(),
  toolSpecs: z.array(ChatToolSpecSchema),
  repairData: z
    .object({
      comfyUI: WorkflowRepairDataSchema.optional(),
      comfyUiImageEdit: WorkflowRepairDataSchema.optional(),
    })
    .optional(),
})
export type MediaAgentCatalog = z.infer<typeof MediaAgentCatalogSchema>

/** UI messages cross as-is; the engine trusts the app's own Chat shapes. */
export const ChatMessageSchema = z.object({ id: z.string(), role: z.string() }).passthrough()

/**
 * Thread fields the engine writes with the messages (step 11). The renderer
 * still holds the live meta; this snapshot is what makes the file durable.
 */
export const ChatTurnPersistSchema = z.object({
  meta: ConversationThreadMetaSchema.nullable(),
  ragHashes: z.array(z.string()),
  lastMainKey: z.string().nullable().optional(),
})
export type ChatTurnPersist = z.infer<typeof ChatTurnPersistSchema>

/**
 * What the Home Agent's own settings tools read, frozen at submit time. The
 * live values are resolved by the renderer's `textInference` / `backendServices`
 * stores, so main is handed the resolved picture rather than asking for it
 * tool-call by tool-call.
 */
const HomeAgentModelSchema = z.object({
  name: z.string(),
  downloaded: z.boolean().optional(),
  maxContextSize: z.number().optional(),
  supportsToolCalling: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
})
const HomeAgentDeviceSchema = z.object({ id: z.string(), name: z.string() }).passthrough()
export const HomeAgentInferenceSnapshotSchema = z.object({
  backend: z.enum(['llamaCPP', 'openVINO', 'cloud']),
  current: z.object({
    model: z.string().nullable(),
    embeddingModel: z.string().nullable(),
    deviceId: z.string().nullable(),
    temperature: z.number(),
    maxTokens: z.number(),
    contextSize: z.number(),
    systemPrompt: z.string(),
    aipgToolsEnabled: z.boolean(),
    mcpToolsEnabled: z.boolean(),
    metricsEnabled: z.boolean(),
    ragDocumentCount: z.number(),
  }),
  currentDeviceName: z.string().nullable().optional(),
  modelMaxContextSize: z.number().nullable().optional(),
  llmModels: z.object({
    llamaCPP: z.array(HomeAgentModelSchema),
    openVINO: z.array(HomeAgentModelSchema),
    cloud: z.array(HomeAgentModelSchema),
  }),
  embeddingModels: z.array(z.object({ name: z.string(), downloaded: z.boolean() })),
  devices: z.object({
    llamaCPP: z.array(HomeAgentDeviceSchema),
    openVINO: z.array(HomeAgentDeviceSchema),
    cloud: z.array(HomeAgentDeviceSchema).optional(),
  }),
})
export type HomeAgentInferenceSnapshot = z.infer<typeof HomeAgentInferenceSnapshotSchema>

export const ChatTurnRequestSchema = z.object({
  conversationKey: z.string().min(1),
  trigger: z.enum(['submit-message', 'regenerate-message']),
  /** Regenerate: the message id to redo; submit: absent. */
  messageId: z.string().optional(),
  messages: z.array(ChatMessageSchema),
  /** Base system prompt. RAG augmentation happens in main when `rag` is set. */
  systemPrompt: z.string().nullable(),
  model: ChatModelConfigSchema,
  tools: z.array(ChatToolSpecSchema),
  /** Engine-owned transcript write (step 11). Absent in tests that do not persist. */
  persist: ChatTurnPersistSchema.optional(),
  /** Present when the preset has RAG on and documents are checked. */
  rag: ChatRagRequestSchema.optional(),
  repairData: z
    .object({
      comfyUI: WorkflowRepairDataSchema.optional(),
      comfyUiImageEdit: WorkflowRepairDataSchema.optional(),
    })
    .optional(),
  /** Home Agent preset: enable its temporary per-turn diagnostics logging. */
  homeAgentDiagnostics: z.boolean().optional(),
  /** MCP tools are exposed: append running servers' instructions to the prompt. */
  includeMcpInstructions: z.boolean().optional(),
  /**
   * Inner specialist catalog, shipped when the turn has the NL `media` tool.
   * Main runs that tool in-process; the renderer only resolves enabled workflows.
   */
  mediaAgent: MediaAgentCatalogSchema.optional(),
  /** Developer setting: skip the GPU swap around in-process media calls. */
  keepModelsLoaded: z.boolean().optional(),
  /** The window `captureScreenshot` is bound to; the tool takes no arguments. */
  screenshotWindow: z.object({ id: z.string(), name: z.string() }).optional(),
  /** Thread title for the TTS file name — the title lives in the renderer's thread list. */
  conversationLabel: z.string().optional(),
  /** Home Agent preset: what its own settings tools read and diff against. */
  homeAgentInference: HomeAgentInferenceSnapshotSchema.optional(),
})
export type ChatTurnRequest = z.infer<typeof ChatTurnRequestSchema>

export const ChatTurnSubmitResultSchema = z.object({
  turnId: z.string(),
})
export type ChatTurnSubmitResult = z.infer<typeof ChatTurnSubmitResultSchema>

/**
 * A running turn's coalesced chunk log at a bus sequence — the resume
 * handshake's replay data. Null when the conversation has no live turn.
 */
export const ChatTurnResumeSchema = z.object({
  turnId: z.string(),
  chunks: z.array(z.record(z.string(), z.unknown())),
  /** Bus sequence the chunks were captured at; apply only events above it. */
  sequence: z.number(),
})
// Chunks cross IPC as records (a full UIMessageChunk zod mirror would dwarf
// the contract); the engine produces them via toUIMessageStream, so the TS
// side states the real element type.
export type ChatTurnResume = Omit<z.infer<typeof ChatTurnResumeSchema>, 'chunks'> & {
  chunks: UIMessageChunk[]
}

/** `chat:resumeTurn` reply: the replay data when a turn is live, else a no-op. */
export const ChatTurnResumeResultSchema = z.object({
  success: z.literal(true),
  active: z.boolean(),
  turnId: z.string().optional(),
  chunks: z.array(z.record(z.string(), z.unknown())).optional(),
  sequence: z.number().optional(),
})
export type ChatTurnResumeResult = Omit<z.infer<typeof ChatTurnResumeResultSchema>, 'chunks'> & {
  chunks?: UIMessageChunk[]
}

export const ChatCancelTurnRequestSchema = z.object({
  conversationKey: z.string().min(1),
  turnId: z.string().min(1),
})
export type ChatCancelTurnRequest = z.infer<typeof ChatCancelTurnRequestSchema>

// ── Nested media specialist run (in-process) ─────────────────────────────────

export const MediaAgentRunRequestSchema = z.object({
  runKey: z.string().min(1),
  /** Nesting key for the GPU window: the parent chat conversation or agent session. */
  conversationKey: z.string().optional(),
  /** Who owns the resulting media — a chat turn's gallery, or the agent workspace. */
  origin: z.enum(['renderer', 'agent']).optional(),
  request: z.string(),
  /** Parent-provided source image, already a data URI. */
  sourceImage: z.string().optional(),
  ...MediaAgentCatalogSchema.shape,
  /** Developer setting: skip the GPU swap around in-process media calls. */
  keepModelsLoaded: z.boolean().optional(),
  model: ChatModelConfigSchema,
})
export type MediaAgentRunRequest = z.infer<typeof MediaAgentRunRequestSchema>

/** The raw tool-agent result; main condenses it into CondensedMediaAgentResult. */
export const MediaAgentRunResultSchema = z.object({
  text: z.string(),
  steps: z.array(
    z.object({
      toolName: z.string(),
      input: z.unknown(),
      output: z.unknown(),
    }),
  ),
})
export type MediaAgentRunResult = z.infer<typeof MediaAgentRunResultSchema>

// ── One-shot helpers ──────────────────────────────────────────────────────────

export const ChatSummarizeRequestSchema = z.object({
  messagesText: z.string(),
  model: ChatModelConfigSchema,
})
export type ChatSummarizeRequest = z.infer<typeof ChatSummarizeRequestSchema>
