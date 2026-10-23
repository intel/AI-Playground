import {
  computeConfigChanges,
  summarizeChanges,
  type HomeAgentConfigRequest,
} from '@/assets/js/tools/configureHomeAgentLogic'
import type { HomeAgentInferenceSnapshot } from '@/types/chatIpc'
import type { HomeAgentApplyResult } from '@/types/chatRequests'
import { askRenderer } from './chatAsk'
import { trackChatToolActivity, updateChatToolActivity } from './chatToolActivity'

/**
 * Main-side bodies for the Home Agent's own settings tools.
 *
 * The turn ships the inference snapshot these read (`homeAgentInference`), so
 * `getHomeAgentSettings` / `listHomeAgentModels` answer without touching the
 * window at all. `configureHomeAgent` validates and diffs here — the diff logic
 * is pure — then pauses twice: once for the confirmation card, once to write the
 * approved change into the live stores. Both are the window's to do; deciding
 * what the change *is*, and what the model is told, are not.
 */

export const CHAT_HOME_AGENT_TOOLS = new Set([
  'getHomeAgentSettings',
  'listHomeAgentModels',
  'configureHomeAgent',
])

export type ConfigureHomeAgentOutput = {
  status: 'applied' | 'declined' | 'no_changes' | 'error'
  message: string
  appliedChanges?: string[]
}

const MISSING_SNAPSHOT =
  'Home Agent settings are unavailable for this turn (the Home Agent preset is not active).'

function readSettings(snapshot: HomeAgentInferenceSnapshot): string {
  return JSON.stringify({
    backend: snapshot.backend,
    model: snapshot.current.model ?? null,
    embeddingModel: snapshot.current.embeddingModel ?? null,
    deviceId: snapshot.current.deviceId,
    deviceName: snapshot.currentDeviceName ?? null,
    temperature: snapshot.current.temperature,
    maxTokens: snapshot.current.maxTokens,
    contextSize: snapshot.current.contextSize,
    modelMaxContextSize: snapshot.modelMaxContextSize ?? null,
    systemPrompt: snapshot.current.systemPrompt,
    aipgToolsEnabled: snapshot.current.aipgToolsEnabled,
    mcpToolsEnabled: snapshot.current.mcpToolsEnabled,
    metricsEnabled: snapshot.current.metricsEnabled,
    ragDocumentCount: snapshot.current.ragDocumentCount,
  })
}

function listModels(snapshot: HomeAgentInferenceSnapshot): string {
  return JSON.stringify({
    currentBackend: snapshot.backend,
    llmModels: snapshot.llmModels,
    embeddingModels: snapshot.embeddingModels,
    devices: snapshot.devices,
  })
}

async function configure(options: {
  input: unknown
  conversationKey: string
  toolCallId: string
  snapshot: HomeAgentInferenceSnapshot
  abortSignal?: AbortSignal
}): Promise<ConfigureHomeAgentOutput> {
  const request = (options.input ?? {}) as HomeAgentConfigRequest
  const snapshot = options.snapshot
  const targetBackend = request.backend ?? snapshot.backend

  // Surface what is happening for the whole validate → confirm → apply window,
  // which is otherwise silent (the inference activity is cleared on the
  // tool-call chunk and only re-armed once a tool-result comes back).
  return await trackChatToolActivity(
    {
      category: 'tools',
      label: 'Reviewing settings change…',
      conversationKey: options.conversationKey,
    },
    async (activityId) => {
      const { changes, errors, notes } = computeConfigChanges(request, {
        currentBackend: snapshot.backend,
        current: {
          ...snapshot.current,
          model: snapshot.current.model ?? undefined,
          embeddingModel: snapshot.current.embeddingModel ?? undefined,
        },
        modelsByBackend: {
          llamaCPP: snapshot.llmModels.llamaCPP,
          openVINO: snapshot.llmModels.openVINO,
          cloud: snapshot.llmModels.cloud,
        },
        embeddingModelNames: snapshot.embeddingModels.map((m) => m.name),
        deviceIds: (snapshot.devices[targetBackend] ?? []).map((d) => d.id),
      })

      if (errors.length > 0) {
        return {
          status: 'error' as const,
          message: `Could not apply the requested settings:\n${errors.map((e) => `- ${e}`).join('\n')}`,
        }
      }
      if (changes.length === 0) {
        return {
          status: 'no_changes' as const,
          message:
            'The requested settings already match the current configuration; nothing to change.',
        }
      }

      updateChatToolActivity(activityId, { label: 'Waiting for your confirmation…' })
      const approved = await askRenderer<boolean>(
        {
          kind: 'home-agent-confirm',
          conversationKey: options.conversationKey,
          toolCallId: options.toolCallId,
          summaryMarkdown: summarizeChanges(changes, notes),
        },
        { abortSignal: options.abortSignal },
      )
      if (!approved) {
        return {
          status: 'declined' as const,
          message: 'The user declined the settings change. The configuration is unchanged.',
        }
      }

      updateChatToolActivity(activityId, { label: 'Applying settings…' })
      const { backendChanged } = await askRenderer<HomeAgentApplyResult>({
        kind: 'home-agent-apply',
        targetBackend,
        changes,
      })
      const reloadNote = backendChanged
        ? ' Model/backend/device changes take effect on your next message (the backend reloads automatically).'
        : ''
      return {
        status: 'applied' as const,
        message: `Settings updated.${reloadNote}`,
        appliedChanges: changes.map((c) => `${c.label}: ${c.to}`),
      }
    },
  )
}

export async function executeChatHomeAgentTool(options: {
  toolName: string
  input: unknown
  conversationKey: string
  toolCallId: string
  snapshot?: HomeAgentInferenceSnapshot
  abortSignal?: AbortSignal
}): Promise<string | ConfigureHomeAgentOutput> {
  // The tools are only offered while the Home Agent preset is active, and the
  // snapshot rides the same turn — so a missing one means a stray call that
  // must not read or mutate another preset's settings.
  const snapshot = options.snapshot
  if (options.toolName === 'configureHomeAgent') {
    if (!snapshot) {
      return {
        status: 'error' as const,
        message: 'Home Agent settings can only be changed while the Home Agent preset is active.',
      }
    }
    return await configure({
      input: options.input,
      conversationKey: options.conversationKey,
      toolCallId: options.toolCallId,
      snapshot,
      abortSignal: options.abortSignal,
    })
  }
  if (!snapshot) throw new Error(MISSING_SNAPSHOT)
  const label =
    options.toolName === 'getHomeAgentSettings'
      ? 'Reading Home Agent settings…'
      : 'Listing available models…'
  return await trackChatToolActivity(
    { category: 'tools', label, conversationKey: options.conversationKey },
    async () =>
      options.toolName === 'getHomeAgentSettings' ? readSettings(snapshot) : listModels(snapshot),
  )
}
