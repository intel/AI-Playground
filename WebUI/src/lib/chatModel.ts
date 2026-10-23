import { useTextInference, backendToService } from '@/assets/js/store/textInference'
import { useCloudMode, CLOUD_DEFAULT_MODEL } from '@/assets/js/store/cloudMode'
import { usePresets } from '@/assets/js/store/presets'
import { chatTemplateKwargs } from '@/lib/samplingDefaults'
/** What the AI SDK's telemetry has no field for, because only this app knows it. */
export type ChatTraceContext = {
  /** Chat preset the turn was held with, so both surfaces label a trace the same way. */
  preset?: string
  backend?: 'llamaCPP' | 'openVINO' | 'cloud'
  device?: string
  deviceName?: string
  cloudProvider?: string
  thinking?: boolean
  reasoningEffort?: string
  sampling?: { temperature?: number; topP?: number; maxTokens?: number }
  /**
   * A nested run inside a tool call of the parent turn (the media specialist),
   * whose spans belong in the parent's trace rather than in one of their own.
   */
  delegated?: boolean
}
import type { ChatModelConfig } from '@/types/chatIpc'

// ── Shared chat model config (step 6) ─────────────────────────────────────────
//
// The renderer's AI-SDK model factory lived here until chat inference moved
// into main; what remains is the renderer-resolved DATA half — buildChatModel
// config and the trace context — which every main-side AI SDK caller (chat
// turns, the nested media specialist, one-shot summarize) receives on its
// request, plus the Laminar trace facts both processes share.

/**
 * The setup of a turn run against this model, for its trace: which backend on
 * which device, whether the model was told to think and how deeply, and the
 * sampling that rides the request. `chatTemplateKwargs` is the same call
 * `createChatModel` makes to build the body, so a trace reports what was sent
 * and not what the settings happen to say.
 *
 * Lives here rather than in the chat store because every surface that runs on
 * this model needs it — chat turns and the nested tool agents, which are AI SDK
 * calls of their own (see assets/js/agents/mediaAgent.ts).
 */
export function chatTraceContext(): ChatTraceContext {
  const textInference = useTextInference()
  const cloudMode = useCloudMode()
  const presets = usePresets()
  const kwargs = chatTemplateKwargs({
    supportsThinkingToggle: textInference.modelSupportsThinkingToggle,
    thinkingEnabled: textInference.thinkingEnabled,
    thinkingActive: textInference.thinkingActive,
    reasoningEffort: textInference.effectiveReasoningEffort,
  })
  const cloud = textInference.backend === 'cloud'
  return {
    preset: presets.activePresetName ?? undefined,
    backend: textInference.backend,
    ...(cloud
      ? { cloudProvider: cloudMode.selectedProviderId }
      : {
          device: textInference.getCurrentDeviceId() ?? undefined,
          deviceName: textInference.getCurrentDeviceName() ?? undefined,
        }),
    ...(typeof kwargs.enable_thinking === 'boolean' ? { thinking: kwargs.enable_thinking } : {}),
    ...(typeof kwargs.reasoning_effort === 'string'
      ? { reasoningEffort: kwargs.reasoning_effort }
      : {}),
    sampling: {
      temperature: textInference.temperature,
      topP: textInference.samplingRequestBody.top_p,
      maxTokens: textInference.maxTokens,
    },
  }
}

// ── Turn-request model config (step 6: chat inference in main) ────────────────

/**
 * The renderer-resolved half of a chat turn: everything the main-side model
 * factory (`electron/chat/chatModelMain.ts`) needs, captured at submit time
 * from the same store reads `createChatModel` performs — backend selection,
 * the encoded model id, cloud/Home-Agent proxy routing, recommended sampling,
 * thinking kwargs, and the local-backend readiness facts so main can load
 * (and relaunch) without another Pinia read. Chat turns ship this over
 * `chat:submitTurn`; the media specialist (electron/chat/mediaAgentRunner.ts)
 * — every main-side caller receives this on its request.
 */
export function buildChatModelConfig(): ChatModelConfig {
  const textInference = useTextInference()
  const cloudMode = useCloudMode()

  const backend = textInference.backend
  const activeModel = textInference.activeModel ?? ''
  const isLocal = backend === 'llamaCPP' || backend === 'openVINO'

  const activeLlmModel = textInference.llmModels
    .filter((m) => m.type === backend)
    .find((m) => m.active)
  const activeEmbeddingModel = textInference.llmEmbeddingModels
    .filter((m) => m.type === backend)
    .find((m) => m.active)

  return {
    backend,
    // Local backends encode model paths with '---' (a '/' in the repo path
    // would break the URL); remote providers expect the id verbatim.
    modelId: backend === 'cloud' ? activeModel : activeModel.split('/').join('---'),
    baseUrl: textInference.currentBackendUrl || undefined,
    omitModelInBody: backend === 'cloud' && activeModel === CLOUD_DEFAULT_MODEL,
    ...(backend === 'cloud'
      ? {
          cloud: {
            providerId: cloudMode.selectedProviderId,
            upstreamBaseUrl: cloudMode.activeProviderBaseUrl || undefined,
            authStyle: cloudMode.activeProviderAuthStyle,
          },
        }
      : {}),
    homeAgentUpstreamUrl: textInference.homeAgentUpstreamUrl || undefined,
    ...(isLocal
      ? {
          readiness: {
            serviceName: backendToService[backend],
            llmModelName: activeModel,
            embeddingModelName: textInference.willUseRag ? activeEmbeddingModel?.name : undefined,
            contextSize: textInference.contextSize,
            modelArgs: backend === 'llamaCPP' ? activeLlmModel?.llamaCppArgs : undefined,
          },
        }
      : {}),
    samplingRequestBody: textInference.samplingRequestBody || undefined,
    chatTemplateKwargs:
      chatTemplateKwargs({
        supportsThinkingToggle: textInference.modelSupportsThinkingToggle,
        thinkingEnabled: textInference.thinkingEnabled,
        thinkingActive: textInference.thinkingActive,
        reasoningEffort: textInference.effectiveReasoningEffort,
      }) || undefined,
    temperature: textInference.temperature,
    maxOutputTokens: textInference.effectiveMaxTokens,
    supportsVision: textInference.modelSupportsVision,
    extractReasoning: backend === 'cloud',
    trace: chatTraceContext(),
    timingsPerToken: true,
  }
}
