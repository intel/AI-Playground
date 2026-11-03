import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import { MCP_CAPABILITY_PREFIX } from '@/types/agentCapabilities'

type LocalBackend = 'llamaCPP' | 'openVINO'

export type SessionSettingsProblemField =
  'backend' | 'model' | 'device' | 'cloudProvider' | 'mcpServer' | 'embeddingModel' | 'variant'

export type SessionSettingsProblem = { field: SessionSettingsProblemField; value: string }

/** The i18n key naming each field in the prompt-bar message and the settings panel. */
export const PROBLEM_FIELD_LABEL_KEYS: Record<SessionSettingsProblemField, string> = {
  backend: 'AGENT_SETTING_BACKEND',
  model: 'AGENT_SETTING_MODEL',
  device: 'AGENT_SETTING_DEVICE',
  cloudProvider: 'AGENT_SETTING_PROVIDER',
  mcpServer: 'AGENT_SETTING_MCP_SERVER',
  embeddingModel: 'AGENT_SETTING_EMBEDDING_MODEL',
  variant: 'AGENT_SETTING_VARIANT',
}

/** One problem as the user reads it, e.g. Model “Qwen3-9B” is no longer available. */
export function describeSettingsProblem(
  problem: SessionSettingsProblem,
  labels: Record<string, string | undefined>,
): string {
  const template =
    labels.AGENT_SETTINGS_UNUSABLE_DETAIL ?? '{setting} “{value}” is no longer available.'
  return template
    .replace('{setting}', labels[PROBLEM_FIELD_LABEL_KEYS[problem.field]] ?? problem.field)
    .replace('{value}', problem.value)
}

/** Several problems as one sentence per problem. */
export function describeSettingsProblems(
  problems: readonly SessionSettingsProblem[],
  labels: Record<string, string | undefined>,
): string {
  return problems.map((problem) => describeSettingsProblem(problem, labels)).join(' ')
}

/** What the app can serve right now. An empty list (or null) means "not loaded yet". */
export type SessionSettingsAvailability = {
  models: readonly { name: string; type: string }[]
  embeddingModels: readonly { name: string; type: string }[]
  services: readonly {
    backend: LocalBackend
    isSetUp: boolean
    devices: readonly { id: string; uuid?: string | null }[]
  }[]
  cloudEnabled: boolean
  cloudProviderIds: readonly string[]
  mcpServerIds: readonly string[] | null
  embeddingBackend: LocalBackend
}

/** The stored settings of a sent Agent Session that can no longer be used, one per field. */
export function sessionSettingsProblems(
  settings: AgentSessionSettings,
  available: SessionSettingsAvailability,
): SessionSettingsProblem[] {
  const problems: SessionSettingsProblem[] = []
  const { backend } = settings

  if (backend === 'cloud') {
    if (!available.cloudEnabled) problems.push({ field: 'backend', value: backend })
    else if (
      settings.cloudProviderId !== undefined &&
      !available.cloudProviderIds.includes(settings.cloudProviderId)
    ) {
      problems.push({ field: 'cloudProvider', value: settings.cloudProviderId })
    }
  } else if (backend) {
    const service = available.services.find((s) => s.backend === backend)
    if (service && !service.isSetUp) problems.push({ field: 'backend', value: backend })
    const catalog = available.models.filter((m) => m.type === backend)
    if (settings.model && catalog.length > 0 && !catalog.some((m) => m.name === settings.model)) {
      problems.push({ field: 'model', value: settings.model })
    }
    const device = settings.device
    const devices = service?.devices ?? []
    if (device && devices.length > 0) {
      const found = devices.some(
        (d) => d.id === device.id || (device.uuid != null && d.uuid === device.uuid),
      )
      if (!found) problems.push({ field: 'device', value: device.id })
    }
  }

  const capabilities = settings.capabilities ?? []
  if (available.mcpServerIds) {
    for (const id of capabilities) {
      if (!id.startsWith(MCP_CAPABILITY_PREFIX)) continue
      const serverId = id.slice(MCP_CAPABILITY_PREFIX.length)
      if (!available.mcpServerIds.includes(serverId)) {
        problems.push({ field: 'mcpServer', value: serverId })
      }
    }
  }

  const embeddings = available.embeddingModels.filter((m) => m.type === available.embeddingBackend)
  if (
    capabilities.includes('rag') &&
    settings.embeddingModel &&
    embeddings.length > 0 &&
    !embeddings.some((m) => m.name === settings.embeddingModel)
  ) {
    problems.push({ field: 'embeddingModel', value: settings.embeddingModel })
  }
  return problems
}
