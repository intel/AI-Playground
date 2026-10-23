import { tool } from 'ai'
import { z } from 'zod'
import { ToolConversationContextSchema } from './toolContext'

// Schema + description only: the bodies run in main
// (`chat/chatHomeAgentTools.ts`), reading the inference snapshot the turn
// ships. `configureHomeAgent` computes its diff there and pauses for the
// confirmation card, which is the one part that is genuinely the window's.

// Read output is returned as a JSON string rather than a deeply-nested zod
// schema: the AI SDK's `InferUITools` type inference (used to build
// `AipgUiMessage`) collapses to `any` when tool output schemas get too deep,
// which cascades across the whole store graph. A string keeps that inference
// shallow.

export const getHomeAgentSettings = tool({
  description:
    "Read the Home Agent's current inference settings (backend, model, embedding model, device, " +
    'temperature, max tokens, context size, system prompt, tool toggles, metrics, number of RAG ' +
    'documents). Returns a JSON string. Call this before configureHomeAgent so you know the current ' +
    'values and can describe changes accurately.',
  inputSchema: z.object({}),
  outputSchema: z.string(),
  contextSchema: ToolConversationContextSchema,
})

export const listHomeAgentModels = tool({
  description:
    'List the models and devices available to the Home Agent: LLM models per backend (with download ' +
    'status, max context size, and tool-calling / vision support), embedding models, and inference ' +
    'devices per backend. Returns a JSON string. Use the exact "name"/"id" values from this list ' +
    'when calling configureHomeAgent.',
  inputSchema: z.object({}),
  outputSchema: z.string(),
  contextSchema: ToolConversationContextSchema,
})

const ConfigureHomeAgentInputSchema = z.object({
  backend: z
    .enum(['llamaCPP', 'openVINO'])
    .optional()
    .describe('LLM backend to use. Only change if the user explicitly asks.'),
  model: z
    .string()
    .optional()
    .describe('Exact LLM model name/id to use (must be one of the downloaded models).'),
  embeddingModel: z
    .string()
    .optional()
    .describe('Exact embedding model name used for RAG document retrieval.'),
  deviceId: z
    .string()
    .optional()
    .describe('Inference device id (e.g. a GPU/NPU id). Advanced; rarely needed.'),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe('Sampling temperature, 0 (deterministic) to 2 (very random).'),
  maxTokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum number of tokens to generate per reply.'),
  contextSize: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Context window size in tokens (clamped to the model maximum).'),
  systemPrompt: z
    .string()
    .optional()
    .describe('Replacement system prompt that defines the assistant behaviour.'),
  aipgToolsEnabled: z
    .boolean()
    .optional()
    .describe('Enable/disable the built-in AI Playground tools.'),
  mcpToolsEnabled: z.boolean().optional().describe('Enable/disable MCP server tools.'),
  metricsEnabled: z.boolean().optional().describe('Enable/disable performance metrics in replies.'),
  clearRagDocuments: z
    .boolean()
    .optional()
    .describe('Remove all uploaded RAG documents from the knowledge base. Cannot add documents.'),
})

const ConfigureHomeAgentOutputSchema = z.object({
  status: z.enum(['applied', 'declined', 'no_changes', 'error']),
  message: z.string(),
  appliedChanges: z.array(z.string()).optional(),
})

export const configureHomeAgent = tool({
  description:
    "Change the Home Agent's own inference settings (model, backend, temperature, max tokens, " +
    'context size, system prompt, tool toggles, embedding model, performance metrics) or clear the ' +
    'RAG knowledge base. Only set the fields you want to change. First call getHomeAgentSettings to ' +
    'see current values and listHomeAgentModels to get exact model/device names — use those exact ' +
    'values here. The app automatically asks the user to confirm (a Confirm/Cancel card in the app, ' +
    'or a yes/no message in the channel) before applying — do NOT ask for confirmation yourself or ' +
    'describe the change and wait; just call this tool and report the result it returns. Only call ' +
    'this when the user explicitly asks to change a setting. You cannot add RAG documents with this ' +
    'tool (the user uploads those directly). Changes apply to all Home Agent conversations.',
  inputSchema: ConfigureHomeAgentInputSchema,
  outputSchema: ConfigureHomeAgentOutputSchema,
  contextSchema: ToolConversationContextSchema,
})
