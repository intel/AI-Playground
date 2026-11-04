import type { SettingsBag } from '@/lib/agentSessionSettings'
import {
  isAdoptable,
  recommendedReasoningEffort,
  resolveSampling,
  toRequestBody,
} from '@/lib/samplingDefaults'
import { ovmsMtpRequestFields } from '@/lib/ovmsMtp'
import {
  llmBackendTypes,
  npuPromptLen,
  reasoningEfforts,
  type InferenceDefaults,
  type ReasoningEffort,
} from '@/types/shared'

type Backend = (typeof llmBackendTypes)[number]
type LocalBackend = Exclude<Backend, 'cloud'>

/** The inference inputs an agent turn config is built from. */
export type InferenceForTurn = {
  samplingRequestBody: Record<string, unknown>
  temperature: number
  modelSupportsThinkingToggle: boolean
  thinkingEnabled: boolean
  thinkingActive: boolean
  effectiveReasoningEffort?: string
  backend: string
  activeModel?: string | null
  localBackendUrl?: string | null
  modelSupportsVision: boolean
  effectiveContextWindow: number
  maxContextSizeFromModel?: unknown
  getCurrentDeviceId: () => string | null | undefined
  getCurrentDeviceName: () => string | null | undefined
  contextSize?: number
  activeLlmModel?: { llamaCppArgs?: string } | null
  /** Downloaded embedding model + the local backend that serves it (rag capability). */
  embeddingBackend: 'llamaCPP' | 'openVINO'
  activeEmbeddingModel?: string | null
  llmEmbeddingModels?: readonly { name: string; type: string; downloaded: boolean }[]
}

/** The cloud provider an agent turn config is built against. */
export type CloudForTurn = {
  activeProviderBaseUrl?: string | null
  selectedProviderId: string
  activeProviderAuthStyle: string
  capabilitiesFor: (name: string) => { reasoningAdvertised: boolean }
}

/** The tool toggles that shape an agent turn's tool catalog. */
export type ToolsForTurn = {
  toolDelegationEnabled: boolean
  builtinToolEnablement: Record<string, boolean>
}

type CatalogLlm = {
  name: string
  type: string
  supportsVision?: boolean
  supportsThinkingToggle?: boolean
  supportsReasoning?: boolean
  maxContextSize?: number
  inferenceDefaults?: InferenceDefaults
  llamaCppArgs?: string
}

type CatalogDevice = { id: string; name?: string; uuid?: string | null; selected?: boolean }

export type StoredCloudProvider = {
  id: string
  baseUrl: string
  authStyle?: string
  models: readonly string[]
  capabilitiesFor: (name: string) => {
    supportsVision: boolean
    reasoningAdvertised: boolean
    contextLength?: number
  }
}

/** Everything the stored settings are resolved against. */
export type StoredInferenceCatalog = {
  models: readonly CatalogLlm[]
  embeddingModels: readonly { name: string; type: string; downloaded: boolean }[]
  services: readonly {
    backend: LocalBackend
    baseUrl?: string
    devices: readonly CatalogDevice[]
    ovmsMtpArmed?: boolean
  }[]
  cloudProviders: readonly StoredCloudProvider[]
  selectedCloudProviderId: string
  /** The local backend document search runs on while the chat backend is cloud. */
  cloudEmbeddingBackend: LocalBackend
  presetTemperature?: number
  presetContextSize?: number
}

export type StoredSessionInference = {
  inference: InferenceForTurn
  cloud: CloudForTurn
  tools: ToolsForTurn
}

const DEFAULT_TEMPERATURE = 0.7
const DEFAULT_CONTEXT_SIZE = 8192

const asRecord = <T>(value: unknown): Record<string, T> =>
  value && typeof value === 'object' ? { ...(value as Record<string, T>) } : {}

const numberOr = (value: unknown, fallback: number | undefined): number | undefined =>
  typeof value === 'number' ? value : fallback

const knownEffort = (value: unknown): ReasoningEffort | undefined =>
  reasoningEfforts.includes(value as ReasoningEffort) ? (value as ReasoningEffort) : undefined

/** The selected entry if it is still offered, else the first — how the live pickers resolve. */
function pick<T extends { name: string }>(entries: readonly T[], selected: unknown): T | undefined {
  return entries.find((entry) => entry.name === selected) ?? entries[0]
}

/**
 * A chat-preset settings bag (Default Settings with a session's settings laid over it)
 * resolved into turn inputs, without touching the live controls.
 */
export function storedSessionInference(
  bag: SettingsBag,
  catalog: StoredInferenceCatalog,
): StoredSessionInference {
  const backend: Backend = (llmBackendTypes as readonly unknown[]).includes(bag.backend)
    ? (bag.backend as Backend)
    : 'llamaCPP'
  const selectedModels = asRecord<string | null>(bag.selectedModels)

  const providerId =
    typeof bag.cloudProviderId === 'string' ? bag.cloudProviderId : catalog.selectedCloudProviderId
  const provider = catalog.cloudProviders.find((entry) => entry.id === providerId)

  const local = backend === 'cloud' ? undefined : backend
  const service = local ? catalog.services.find((entry) => entry.backend === local) : undefined
  const model =
    backend === 'cloud'
      ? undefined
      : pick(
          catalog.models.filter((entry) => entry.type === backend),
          selectedModels[backend],
        )
  const cloudModel =
    backend === 'cloud' && provider
      ? pick(
          provider.models.map((name) => ({ name })),
          selectedModels.cloud,
        )?.name
      : undefined
  const cloudCaps = cloudModel && provider ? provider.capabilitiesFor(cloudModel) : undefined

  const device = service?.devices.find((entry) => entry.selected)
  const onNpu = backend === 'openVINO' && !!device?.id.includes('NPU')

  const maxContextSize = backend === 'cloud' ? cloudCaps?.contextLength : model?.maxContextSize
  const requested =
    numberOr(bag.requestedContextSize, numberOr(bag.contextSize, catalog.presetContextSize)) ??
    DEFAULT_CONTEXT_SIZE
  const contextSize =
    backend !== 'cloud' && maxContextSize !== undefined
      ? Math.min(requested, maxContextSize)
      : requested
  const effectiveContextWindow =
    backend === 'openVINO' && !onNpu
      ? (maxContextSize ?? 0)
      : backend === 'cloud'
        ? (maxContextSize ?? contextSize)
        : onNpu
          ? npuPromptLen(contextSize)
          : contextSize

  const thinkingEnabled = typeof bag.thinkingEnabled === 'boolean' ? bag.thinkingEnabled : true
  const supportsThinkingToggle = model?.supportsThinkingToggle === true
  const thinkingActive = supportsThinkingToggle
    ? thinkingEnabled
    : model?.supportsReasoning === true
  const sampling = resolveSampling(model?.inferenceDefaults, thinkingActive)

  let temperature = numberOr(bag.temperature, catalog.presetTemperature) ?? DEFAULT_TEMPERATURE
  if (
    sampling.temperature !== undefined &&
    catalog.presetTemperature === undefined &&
    isAdoptable(temperature, numberOr(bag.temperatureFromModel, undefined), DEFAULT_TEMPERATURE)
  ) {
    temperature = sampling.temperature
  }

  const modelEffort = recommendedReasoningEffort(model?.inferenceDefaults)
  let effort = knownEffort(bag.reasoningEffort)
  if (modelEffort !== undefined && isAdoptable(effort, knownEffort(bag.reasoningEffortFromModel))) {
    effort = modelEffort
  }

  const samplingRequestBody: Record<string, unknown> =
    backend === 'cloud'
      ? {}
      : {
          ...toRequestBody(sampling, backend),
          ...(backend === 'openVINO' ? ovmsMtpRequestFields(service?.ovmsMtpArmed === true) : {}),
        }

  const embeddingBackend = local ?? catalog.cloudEmbeddingBackend
  const embeddingModel = pick(
    catalog.embeddingModels.filter((entry) => entry.type === embeddingBackend),
    asRecord<string | null>(bag.selectedEmbeddingModels)[embeddingBackend],
  )

  const inference: InferenceForTurn = {
    samplingRequestBody,
    temperature,
    modelSupportsThinkingToggle: supportsThinkingToggle,
    thinkingEnabled,
    thinkingActive,
    effectiveReasoningEffort: modelEffort !== undefined ? (effort ?? modelEffort) : undefined,
    backend,
    activeModel: backend === 'cloud' ? cloudModel : model?.name,
    localBackendUrl: service?.baseUrl,
    modelSupportsVision:
      backend === 'cloud' ? cloudCaps?.supportsVision === true : model?.supportsVision === true,
    effectiveContextWindow,
    maxContextSizeFromModel: maxContextSize,
    getCurrentDeviceId: () => device?.id ?? null,
    getCurrentDeviceName: () => device?.name ?? null,
    contextSize,
    activeLlmModel: model ?? null,
    embeddingBackend,
    activeEmbeddingModel: embeddingModel?.name,
    llmEmbeddingModels: catalog.embeddingModels,
  }

  return {
    inference,
    cloud: {
      selectedProviderId: providerId,
      activeProviderBaseUrl:
        provider?.baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '') || undefined,
      activeProviderAuthStyle: provider?.authStyle ?? 'bearer',
      capabilitiesFor: (name) => provider?.capabilitiesFor(name) ?? { reasoningAdvertised: false },
    },
    tools: {
      toolDelegationEnabled:
        typeof bag.toolDelegationEnabled === 'boolean' ? bag.toolDelegationEnabled : true,
      builtinToolEnablement: asRecord<boolean>(bag.builtinToolEnablement),
    },
  }
}
