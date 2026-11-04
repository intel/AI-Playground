import { computed, onMounted, reactive } from 'vue'
import { type LlmBackend, useTextInference } from '@/assets/js/store/textInference'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { useAgentBackendItems } from '@/assets/js/agentBackendItems'
import { useCapabilityCatalog } from '@/assets/js/capabilityCatalog'
import { useEmbeddingModelPicker } from '@/assets/js/embeddingModelPicker'
import type { AgentSettingsBinding } from '@/lib/agentSettingsBinding'
import { storeMediaToolSettings } from '@/lib/mediaToolSettings'

/** The active Agent Preset's settings as both settings tabs read and write them. */
export function useAgentSettingsPanel() {
  const agentMode = useAgentMode()
  const agentTasks = useAgentTasks()
  const textInference = useTextInference()
  const cloudMode = useCloudMode()

  const readOnly = computed(() => agentMode.sessionScoped && agentTasks.openSessionSettingsReadOnly)

  // The catalog is the main process's: it is what the Pi session is actually built from.
  const mediaTools = storeMediaToolSettings(textInference)
  const { catalog: capabilityCatalog, refresh: refreshCapabilityCatalog } = useCapabilityCatalog(
    () => ({
      workspaceDir: agentMode.workspaceDir,
      embeddingModel: textInference.activeEmbeddingModel,
      mediaTools,
    }),
  )
  onMounted(() => void refreshCapabilityCatalog())

  const { activeName: embeddingModelName, items: embeddingModelItems } = useEmbeddingModelPicker(
    () => textInference.llmEmbeddingModels,
    () => textInference.embeddingBackend,
  )

  const { items: backendItems } = useAgentBackendItems(() => agentMode.activeAgentPreset?.backends)

  function setBackend(newBackend: string) {
    textInference.backend = newBackend as LlmBackend
    if (newBackend === 'cloud') cloudMode.refreshSelectedProviderModels()
  }

  // Model settings are textInference's, as in Chat; the agent-only ones are agentMode's.
  const binding: AgentSettingsBinding = reactive({
    backend: computed(() => textInference.backend),
    backendItems,
    setBackend,
    currentModel: computed(() =>
      textInference.llmModels.find((m) => m.active && m.type === textInference.backend),
    ),
    contextSizeSupported: computed(() => textInference.contextSizeSettingSupported),
    contextSize: computed(() => textInference.contextSize),
    setContextSize: (contextSize: number) => {
      textInference.contextSize = contextSize
      textInference.markContextSizeEdited()
    },
    thinkingToggleSupported: computed(() => textInference.modelSupportsThinkingToggle),
    thinkingEnabled: computed(() => textInference.thinkingEnabled),
    setThinkingEnabled: (enabled: boolean) => {
      textInference.thinkingEnabled = enabled
    },
    planningPhaseSupported: computed(() => agentMode.planningPhaseSupported),
    planningThinkingOnly: computed(() => agentMode.effectivePlanningThinkingOnly),
    setPlanningThinkingOnly: agentMode.setPlanningThinkingOnly,
    capabilities: computed(() => agentMode.capabilities),
    setCapabilities: agentMode.setCapabilities,
    capabilityCatalog,
    embeddingModelName,
    embeddingModelItems,
    setEmbeddingModel: (modelName: string) =>
      textInference.selectEmbeddingModel(textInference.embeddingBackend, modelName),
    mediaTools,
    problems: computed(() => agentMode.settingsProblems),
    sharedWithChat: computed(() => !agentMode.sessionScoped),
  })

  return { binding, capabilityCatalog, refreshCapabilityCatalog, readOnly }
}
