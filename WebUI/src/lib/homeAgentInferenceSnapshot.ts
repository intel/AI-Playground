import {
  backendToService,
  useTextInference,
  type LlmBackend,
  type LlmModel,
} from '@/assets/js/store/textInference'
import { useBackendServices } from '@/assets/js/store/backendServices'
import type { HomeAgentInferenceSnapshot } from '@/types/chatIpc'

/**
 * The resolved picture the Home Agent's own settings tools read. Built once at
 * submit time and shipped with the turn: the tools execute in main, and this is
 * the state only the stores can resolve (active preset's settings, the model
 * list, device selection, the RAG document count).
 */

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

export function buildHomeAgentInferenceSnapshot(): HomeAgentInferenceSnapshot {
  const textInference = useTextInference()
  const backendServices = useBackendServices()
  const backend = textInference.backend
  const currentDevice = devicesForBackend(backendServices.info, backend).find((d) => d.selected)
  const currentModel = textInference.llmModels
    .filter((m) => m.type === backend)
    .find((m) => m.active)
  const embeddingByName = new Map<string, boolean>()
  for (const m of textInference.llmEmbeddingModels) {
    embeddingByName.set(m.name, embeddingByName.get(m.name) || m.downloaded)
  }
  return {
    backend,
    current: {
      model: currentModel?.name ?? null,
      embeddingModel: textInference.llmEmbeddingModels.find((m) => m.active)?.name ?? null,
      deviceId: currentDevice?.id ?? null,
      temperature: textInference.temperature,
      maxTokens: textInference.maxTokens,
      contextSize: textInference.contextSize,
      systemPrompt: textInference.systemPrompt,
      aipgToolsEnabled: textInference.aipgToolsEnabled,
      mcpToolsEnabled: textInference.mcpToolsEnabled,
      metricsEnabled: textInference.metricsEnabled,
      ragDocumentCount: textInference.ragList.length,
    },
    currentDeviceName: currentDevice?.name ?? null,
    modelMaxContextSize: currentModel?.maxContextSize ?? null,
    llmModels: {
      llamaCPP: mapLlmModels(textInference.llmModels, 'llamaCPP'),
      openVINO: mapLlmModels(textInference.llmModels, 'openVINO'),
      cloud: mapLlmModels(textInference.llmModels, 'cloud'),
    },
    embeddingModels: [...embeddingByName.entries()].map(([name, downloaded]) => ({
      name,
      downloaded,
    })),
    devices: {
      llamaCPP: devicesForBackend(backendServices.info, 'llamaCPP'),
      openVINO: devicesForBackend(backendServices.info, 'openVINO'),
    },
  }
}
