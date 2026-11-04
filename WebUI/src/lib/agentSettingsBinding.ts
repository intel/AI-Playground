import type { LlmBackend, LlmModel } from '@/assets/js/store/textInference'
import type { MediaToolSettings } from '@/lib/mediaToolSettings'
import type { SessionSettingsProblem } from '@/lib/sessionSettingsProblems'

export type AgentSettingsChoice = { label: string; value: string; active: boolean }

/** What the Agent Preset settings tabs read and write. */
export type AgentSettingsBinding = {
  backend: LlmBackend
  backendItems: AgentSettingsChoice[]
  setBackend: (backend: string) => void
  currentModel: LlmModel | undefined
  contextSizeSupported: boolean
  contextSize: number
  setContextSize: (contextSize: number) => void
  thinkingToggleSupported: boolean
  thinkingEnabled: boolean
  setThinkingEnabled: (enabled: boolean) => void
  /** Only a session with a capability that ends a planning phase can drop thinking after it. */
  planningPhaseSupported: boolean
  planningThinkingOnly: boolean
  setPlanningThinkingOnly: (enabled: boolean) => void
  capabilities: string[]
  setCapabilities: (ids: string[]) => void
  capabilityCatalog: AgentCapabilityInfo[]
  embeddingModelName: string
  embeddingModelItems: AgentSettingsChoice[]
  setEmbeddingModel: (modelName: string) => void
  mediaTools: MediaToolSettings
  problems: readonly SessionSettingsProblem[]
  /** Game Agent and Quick Coder keep their model settings in Chat's, so a change there shows here. */
  sharedWithChat: boolean
}
