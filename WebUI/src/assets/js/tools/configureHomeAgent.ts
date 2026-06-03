import { tool } from 'ai'
import { z } from 'zod'
import {
  useTextInference,
  backendToService,
  type LlmBackend,
  type LlmModel,
} from '../store/textInference'
import { useHomeAgent } from '../store/homeAgent'
import { useBackendServices } from '../store/backendServices'
import { useActivities } from '../store/activities'
import { HOME_AGENT_CHAT_PRESET_NAME, useConversations } from '../store/conversations'
import {
  computeConfigChanges,
  summarizeChanges,
  type HomeAgentConfigRequest,
} from './configureHomeAgentLogic'

// The conversation a tool call belongs to is surfaced via `experimental_context`
// (set in openAiCompatibleChat's streamText call). Used to scope activity/status
// and the inline confirmation card to the right chat turn.
function conversationKeyFor(experimentalContext: unknown): string {
  const ctx = experimentalContext as { conversationKey?: string } | undefined
  return ctx?.conversationKey ?? useConversations().activeKey
}

function chatScope(conversationKey: string): { kind: 'chat'; conversationKey: string } {
  return { kind: 'chat', conversationKey }
}

// ── Shared snapshot helpers ───────────────────────────────────────────────────
// These operate on plain data (not the Pinia store return types) to avoid a
// circular type reference through the store import graph.

function devicesForBackend(
  serviceInfo: ApiServiceInformation[],
  backend: LlmBackend,
): InferenceDevice[] {
  const service = backendToService[backend]
  return serviceInfo.find((s) => s.serviceName === service)?.devices ?? []
}

function mapLlmModels(models: LlmModel[], backend: LlmBackend) {
  return models
    .filter((m) => m.type === backend)
    .map((m) => ({
      name: m.name,
      downloaded: m.downloaded,
      maxContextSize: m.maxContextSize,
      supportsToolCalling: m.supportsToolCalling ?? false,
      supportsVision: m.supportsVision ?? false,
    }))
}

// ── Read tools ──────────────────────────────────────────────────────────────
// Output is returned as a JSON string rather than a deeply-nested zod schema:
// the AI SDK's `InferUITools` type inference (used to build `AipgUiMessage`)
// collapses to `any` when tool output schemas get too deep, which cascades
// across the whole store graph. A string keeps that inference shallow.

export const getHomeAgentSettings = tool({
  description:
    "Read the Home Agent's current inference settings (backend, model, embedding model, device, " +
    'temperature, max tokens, context size, system prompt, tool toggles, metrics, number of RAG ' +
    'documents). Returns a JSON string. Call this before configureHomeAgent so you know the current ' +
    'values and can describe changes accurately.',
  inputSchema: z.object({}),
  outputSchema: z.string(),
  execute: async (_args, options) => {
    const scope = chatScope(conversationKeyFor(options.experimental_context))
    return useActivities().track(
      { category: 'tools', label: 'Reading Home Agent settings…', scope },
      async () => {
        const textInference = useTextInference()
        const backendServices = useBackendServices()
        const currentBackend = textInference.backend
        const currentDevice = devicesForBackend(backendServices.info, currentBackend).find(
          (d) => d.selected,
        )
        const currentModel = textInference.llmModels
          .filter((m) => m.type === currentBackend)
          .find((m) => m.active)
        return JSON.stringify({
          backend: currentBackend,
          model: currentModel?.name ?? null,
          embeddingModel: textInference.llmEmbeddingModels.find((m) => m.active)?.name ?? null,
          deviceId: currentDevice?.id ?? null,
          deviceName: currentDevice?.name ?? null,
          temperature: textInference.temperature,
          maxTokens: textInference.maxTokens,
          contextSize: textInference.contextSize,
          modelMaxContextSize: currentModel?.maxContextSize ?? null,
          systemPrompt: textInference.systemPrompt,
          aipgToolsEnabled: textInference.aipgToolsEnabled,
          mcpToolsEnabled: textInference.mcpToolsEnabled,
          metricsEnabled: textInference.metricsEnabled,
          ragDocumentCount: textInference.ragList.length,
        })
      },
    )
  },
})

export const listHomeAgentModels = tool({
  description:
    'List the models and devices available to the Home Agent: LLM models per backend (with download ' +
    'status, max context size, and tool-calling / vision support), embedding models, and inference ' +
    'devices per backend. Returns a JSON string. Use the exact "name"/"id" values from this list ' +
    'when calling configureHomeAgent.',
  inputSchema: z.object({}),
  outputSchema: z.string(),
  execute: async (_args, options) => {
    const scope = chatScope(conversationKeyFor(options.experimental_context))
    return useActivities().track(
      { category: 'tools', label: 'Listing available models…', scope },
      async () => {
        const textInference = useTextInference()
        const backendServices = useBackendServices()
        const embeddingByName = new Map<string, boolean>()
        for (const m of textInference.llmEmbeddingModels) {
          embeddingByName.set(m.name, embeddingByName.get(m.name) || m.downloaded)
        }
        return JSON.stringify({
          currentBackend: textInference.backend,
          llmModels: {
            llamaCPP: mapLlmModels(textInference.llmModels, 'llamaCPP'),
            openVINO: mapLlmModels(textInference.llmModels, 'openVINO'),
          },
          embeddingModels: [...embeddingByName.entries()].map(([name, downloaded]) => ({
            name,
            downloaded,
          })),
          devices: {
            llamaCPP: devicesForBackend(backendServices.info, 'llamaCPP'),
            openVINO: devicesForBackend(backendServices.info, 'openVINO'),
          },
        })
      },
    )
  },
})

// ── Write tool: configure ──────────────────────────────────────────────────────

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

async function applyConfig(
  req: HomeAgentConfigRequest,
  ctx: { conversationKey: string; toolCallId?: string },
): Promise<z.infer<typeof ConfigureHomeAgentOutputSchema>> {
  const textInference = useTextInference()
  const homeAgent = useHomeAgent()
  const backendServices = useBackendServices()
  const activities = useActivities()

  // Surface what is happening for the whole validate -> confirm -> apply window,
  // which is otherwise silent (the inference activity is cleared on the tool-call
  // chunk and only re-armed once a tool-result comes back).
  const activityId = activities.begin({
    category: 'tools',
    label: 'Reviewing settings change…',
    scope: chatScope(ctx.conversationKey),
  })

  try {
    // The tool is only exposed when the Home Agent preset is active, but guard
    // anyway so a stray call can never mutate a different preset's settings.
    if (textInference.activePreset?.name !== HOME_AGENT_CHAT_PRESET_NAME) {
      return {
        status: 'error',
        message: 'Home Agent settings can only be changed while the Home Agent preset is active.',
      }
    }

    const currentBackend = textInference.backend
    const targetBackend = req.backend ?? currentBackend
    const targetService = backendToService[targetBackend]

    const currentDeviceId =
      devicesForBackend(backendServices.info, currentBackend).find((d) => d.selected)?.id ?? null

    const { changes, errors, notes } = computeConfigChanges(req, {
      currentBackend,
      current: {
        model: textInference.activeModel,
        embeddingModel: textInference.llmEmbeddingModels.find((m) => m.active)?.name,
        deviceId: currentDeviceId,
        temperature: textInference.temperature,
        maxTokens: textInference.maxTokens,
        contextSize: textInference.contextSize,
        systemPrompt: textInference.systemPrompt,
        aipgToolsEnabled: textInference.aipgToolsEnabled,
        mcpToolsEnabled: textInference.mcpToolsEnabled,
        metricsEnabled: textInference.metricsEnabled,
        ragDocumentCount: textInference.ragList.length,
      },
      modelsByBackend: {
        llamaCPP: mapLlmModels(textInference.llmModels, 'llamaCPP').map((m) => ({
          name: m.name,
          maxContextSize: m.maxContextSize,
        })),
        openVINO: mapLlmModels(textInference.llmModels, 'openVINO').map((m) => ({
          name: m.name,
          maxContextSize: m.maxContextSize,
        })),
      },
      embeddingModelNames: [...new Set(textInference.llmEmbeddingModels.map((m) => m.name))],
      deviceIds: devicesForBackend(backendServices.info, targetBackend).map((d) => d.id),
    })

    if (errors.length > 0) {
      return {
        status: 'error',
        message: `Could not apply the requested settings:\n${errors.map((e) => `- ${e}`).join('\n')}`,
      }
    }

    if (changes.length === 0) {
      return {
        status: 'no_changes',
        message:
          'The requested settings already match the current configuration; nothing to change.',
      }
    }

    activities.update(activityId, { label: 'Waiting for your confirmation…' })
    const approved = await homeAgent.requestSettingsConfirmation({
      conversationKey: ctx.conversationKey,
      toolCallId: ctx.toolCallId,
      summaryMarkdown: summarizeChanges(changes, notes),
    })
    if (!approved) {
      return {
        status: 'declined',
        message: 'The user declined the settings change. The configuration is unchanged.',
      }
    }

    activities.update(activityId, { label: 'Applying settings…' })
    let backendChanged = false
    for (const change of changes) {
      switch (change.field) {
        case 'backend':
          textInference.backend = change.value as LlmBackend
          backendChanged = true
          break
        case 'model':
          textInference.selectModel(targetBackend, change.value as string)
          backendChanged = true
          break
        case 'embeddingModel':
          textInference.selectEmbeddingModel(targetBackend, change.value as string)
          break
        case 'deviceId':
          await backendServices.selectDevice(targetService, change.value as string)
          backendChanged = true
          break
        case 'temperature':
          textInference.temperature = change.value as number
          break
        case 'maxTokens':
          textInference.maxTokens = change.value as number
          break
        case 'contextSize':
          textInference.contextSize = change.value as number
          backendChanged = true
          break
        case 'systemPrompt':
          textInference.systemPrompt = change.value as string
          break
        case 'aipgToolsEnabled':
          textInference.aipgToolsEnabled = change.value as boolean
          break
        case 'mcpToolsEnabled':
          textInference.mcpToolsEnabled = change.value as boolean
          break
        case 'metricsEnabled':
          textInference.metricsEnabled = change.value as boolean
          break
        case 'clearRagDocuments':
          textInference.deleteAllFiles()
          break
      }
    }

    const appliedChanges = changes.map((c) => `${c.label}: ${c.to}`)
    const reloadNote = backendChanged
      ? ' Model/backend/device changes take effect on your next message (the backend reloads automatically).'
      : ''
    return {
      status: 'applied',
      message: `Settings updated.${reloadNote}`,
      appliedChanges,
    }
  } finally {
    activities.end(activityId)
  }
}

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
  execute: async (args: HomeAgentConfigRequest, options) => {
    return await applyConfig(args, {
      conversationKey: conversationKeyFor(options.experimental_context),
      toolCallId: options.toolCallId,
    })
  },
})
