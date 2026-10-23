import type { AgentModeModelConfig } from '@/types/agentIpc'
import type { ChatModelConfig } from '@/types/chatIpc'
import { openAiApiBase } from '@/lib/inferenceApiBase'

/** Agent turn model config → the nested specialist's ChatModelConfig. */
export function chatModelFromAgentConfig(config: AgentModeModelConfig): ChatModelConfig {
  if (config.source === 'cloud') {
    return {
      backend: 'cloud',
      modelId: config.model,
      baseUrl: openAiApiBase(config.upstreamBaseUrl),
      cloud: {
        providerId: config.providerId,
        upstreamBaseUrl: config.upstreamBaseUrl,
        authStyle: config.authStyle,
      },
      supportsVision: config.supportsVision,
    }
  }
  return {
    backend: config.backend ?? 'llamaCPP',
    modelId: config.model,
    baseUrl: config.baseUrl,
    samplingRequestBody: config.samplingParams,
    supportsVision: config.supportsVision,
  }
}
