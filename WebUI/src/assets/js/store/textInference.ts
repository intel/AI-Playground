import { acceptHMRUpdate, defineStore } from 'pinia'
import { z } from 'zod'
import { demoAwareStorage } from '../demoAwareStorage'
import {
  makeFileBackedPreference,
  type FileBackedPreferencesApi,
} from '@/lib/fileBackedPreferences'
import { useBackendServices, type BackendServiceName } from './backendServices'
import { useModels } from './models'
import type { EmbedInquiry, IndexedDocument } from '@/types/rag'
import {
  deriveGroupContent,
  type PhisonKmIngestConfig,
  type WarmupRequest,
} from '@/types/phisonKmRag'
import {
  llmBackendTypes,
  npuPromptLen,
  reasoningEfforts,
  type InferenceDefaults,
  type ReasoningEffort,
} from '@/types/shared'
import {
  isAdoptable,
  recommendedReasoningEffort,
  resolveSampling,
  toRequestBody,
} from '@/lib/samplingDefaults'
import { notify, requestDownload } from '@/assets/js/permissions/permissions'
import {
  claimOvmsMtpStaleNotice,
  normalizeNumAssistantTokens,
  OVMS_MTP_ASSISTANT_TOKENS,
  ovmsMtpRequestFields,
} from '@/lib/ovmsMtp'
import { usePresets, type ChatPreset } from './presets'
import { useDeveloperSettings } from './developerSettings'
import { useHomeAgent } from './homeAgent'
import { useCloudMode, CLOUD_DEFAULT_MODEL } from './cloudMode'
import { useConversations, HOME_AGENT_CHAT_PRESET_NAME } from './conversations'
import * as toast from '@/assets/js/toast.ts'
import { useActivities } from './activities'
import { useI18N } from './i18n'
import { useUIStore } from './ui'
import { renamePresetKeys } from '@/lib/presetRenames'
import { HYBRID_CLOUD_NAME } from '@/lib/cloudModeName'
import { boundMaxOutputTokens } from '@/lib/maxOutputTokens'
import { formatRagSources } from '@/lib/ragSources'
import {
  chatBackendSelectionLoad,
  skipGpuAdmissionFromKeepModelsLoaded,
} from '@/lib/chatBackendSelection'
import {
  isToolEnabled,
  readLegacyToolEnablement,
  seedToolEnablementPerPreset,
  toolEnablementForPreset,
  type ToolEnablement,
} from '@/lib/builtinToolEnablement'
import {
  createPhisonKmRag,
  PHISON_KM_CONTEXT_FLOOR,
  PHISON_KM_RAG_PREFIX,
} from '@/assets/js/phisonKmRag'
import { useModelPreferences } from './modelPreferences'
import { pathKeyForCatalogModel } from '../models/library'
import { withPreferenceFlags } from '../models/favorites'

const LlmBackendSchema = z.enum(llmBackendTypes)
export type LlmBackend = z.infer<typeof LlmBackendSchema>
type LlmBackendKV = { [key in LlmBackend]: string | null }

// `cloud` has no local Python service — inference is proxied to a remote
// provider URL — so it maps to null. Callers must tolerate the null lookup.
export const backendToService = {
  llamaCPP: 'llamacpp-backend',
  openVINO: 'openvino-backend',
  cloud: null,
} as const

export const backendToAipgBackendName = {
  openVINO: 'openvino',
  llamaCPP: 'llama_cpp',
} as const

export type LlmModel = {
  name: string
  mmproj?: string
  type: LlmBackend
  active: boolean
  downloaded: boolean
  supportsToolCalling?: boolean
  supportsVision?: boolean
  supportsReasoning?: boolean
  supportsCoding?: boolean
  supportsAgentic?: boolean
  supportsThinkingToggle?: boolean
  maxContextSize?: number
  inferenceDefaults?: InferenceDefaults
  llamaCppArgs?: string
  reasoningParser?: string
  enableMtp?: boolean
  npuSupport?: boolean
  largeMoe?: boolean
  requiresPhison?: boolean
  isPredefined?: boolean
  /** User preference from `store/modelPreferences.ts`; applied by pickers, not here. */
  favorite?: boolean
}

/**
 * Cloud model ids are remote and have no model directory, but favoriting one
 * should still work, so their preferences are keyed under this synthetic path key.
 */
export const CLOUD_MODEL_PATH_KEY = 'cloud'

// Thinking model markers for different models
export const thinkingModels: Record<string, string> = {
  'OpenVINO/Qwen3-8B-int4-cw-ov': '</think>\n\n',
  'unsloth/gpt-oss-20b-GGUF/gpt-oss-20b-Q8_0.gguf': '<|start|>assistant<|channel|>final<|message|>',
  'OpenVINO/gpt-oss-20b-int4-ov': '<|start|>assistant<|channel|>final<|message|>',
}

// A friendly display name for each backend
export const textInferenceBackendDisplayName: Record<LlmBackend, string> = {
  llamaCPP: 'llamaCPP - GGUF',
  openVINO: 'OpenVINO',
  cloud: HYBRID_CLOUD_NAME,
}

export const textInferenceBackendDescription: Record<LlmBackend, string> = {
  llamaCPP:
    'Utilizes Llama.cpp for lightweight and portable AI solutions. Ideal for low-resource environments.',
  openVINO:
    'Optimized for Intel hardware with OpenVINO framework. Provides efficient and fast AI processing.',
  cloud:
    'Adds remote OpenAI-compatible endpoints alongside the local engines — hosted, cloud or another machine on your LAN — and uses them as if they were local.',
}

export const textInferenceBackendTags: Record<LlmBackend, string[]> = {
  llamaCPP: ['Lightweight', 'Portable'],
  openVINO: ['Intel', 'Optimized', 'Fast'],
  cloud: ['Remote', 'LAN', 'OpenAI-compatible'],
}

export const useTextInference = defineStore(
  'textInference',
  () => {
    const backendServices = useBackendServices()
    const models = useModels()
    const presetsStore = usePresets()
    const developerSettings = useDeveloperSettings()
    const homeAgent = useHomeAgent()
    const cloudMode = useCloudMode()
    const conversations = useConversations()
    const activities = useActivities()
    const modelPreferences = useModelPreferences()
    const activePreset = computed(() => {
      if (!presetsStore.activePresetName) return null
      const preset = presetsStore.presets.find((p) => p.name === presetsStore.activePresetName)
      if (preset && preset.type === 'chat') return preset as ChatPreset
      return null
    })
    const i18nState = useI18N().state
    const uiStore = useUIStore()
    // Tracks the in-flight backend-preparation activity (begin/end are paired with
    // start/completeBackendPreparation).
    let backendPrepActivityId: string | null = null
    const backend = ref<LlmBackend>('llamaCPP')
    const selectionMemoryPaused = ref(0)
    function pauseChatBackendSelectionMemory(): () => void {
      selectionMemoryPaused.value += 1
      let released = false
      return () => {
        if (released) return
        released = true
        selectionMemoryPaused.value = Math.max(0, selectionMemoryPaused.value - 1)
      }
    }
    watch(
      backend,
      (next) => {
        if (typeof window === 'undefined') return
        const arm = window.electronAPI?.setLastChatBackendLoadActive
        if (!arm) return
        void arm(next !== 'cloud').catch((error: unknown) => {
          console.warn('Could not update last-chat-load arming:', error)
        })
      },
      { immediate: true },
    )
    const ragList = ref<IndexedDocument[]>([])
    const defaultSystemPrompt = `You are a helpful AI assistant embedded in an application called AI Playground, developed by Intel.
      You assist users by answering questions and providing information based on your training data and any additional context provided.`
    const systemPrompt = ref<string>(defaultSystemPrompt)

    const selectedModels = ref<LlmBackendKV>({
      llamaCPP: null,
      openVINO: null,
      cloud: null,
    })

    const selectedEmbeddingModels = ref<LlmBackendKV>({
      llamaCPP: null,
      openVINO: null,
      cloud: null,
    })

    /** Live loaded local model (kernel memory, step 14) — not the dropdown. */
    const loadedInferenceProfile = ref<
      import('@/types/kernelEvents').KernelInferenceProfile | null
    >(null)

    function applyInferenceProfile(
      profile: import('@/types/kernelEvents').KernelInferenceProfile | null,
    ): void {
      loadedInferenceProfile.value = profile
    }

    // Backend readiness state tracking
    const backendReadinessState = reactive({
      lastUsedModel: {
        llamaCPP: null,
        openVINO: null,
        cloud: null,
      } as LlmBackendKV,
      lastUsedContextSize: {
        llamaCPP: null,
        openVINO: null,
        cloud: null,
      } as Record<LlmBackend, number | null>,
      isPreparingBackend: false,
    })

    // Track if we're currently switching presets (for UI feedback)

    /**
     * A model's `favorite` flag, resolved from `modelPreferences` at the
     * point a list is derived. It deliberately does not live on the
     * `models.models` snapshot: that snapshot is only rebuilt by
     * `refreshModels()`, so a flag stored in it stays stale until the next catalog
     * refresh, while the computeds below re-run on the preference write itself.
     */
    const flagsForCatalogModel = (type: string, backend: string | undefined, name: string) => {
      const placement = pathKeyForCatalogModel(type, backend)
      return placement ? modelPreferences.flagsFor(placement.pathKey, name) : { favorite: false }
    }

    const llmModels: Ref<LlmModel[]> = computed(() => {
      const llmTypeModels = models.models.filter((m) =>
        (llmBackendTypes as readonly string[]).includes(m.type),
      )

      // Find first model for each type (already in priority order from models.json)
      const firstModelByType = new Map<string, string>()
      for (const m of llmTypeModels) {
        if (!firstModelByType.has(m.type)) {
          firstModelByType.set(m.type, m.name)
        }
      }

      // `favorite` is only a sort key for the pickers: this list also resolves
      // `activeModel`, the capability computeds and the download params, so
      // nothing here may filter models out on a presentation preference.
      const newModels: LlmModel[] = withPreferenceFlags(
        llmTypeModels.map((m) => {
          const selectedModelForType = selectedModels.value[m.type as LlmBackend]
          const hasValidSelection = llmTypeModels.some(
            (model) => model.name === selectedModelForType,
          )
          const isFirstForType = m.name === firstModelByType.get(m.type)

          return {
            name: m.name,
            mmproj: m.mmproj,
            type: m.type as LlmBackend,
            downloaded: m.downloaded ?? false,
            active: m.name === selectedModelForType || (!hasValidSelection && isFirstForType),
            supportsToolCalling: m.supportsToolCalling,
            supportsVision: m.supportsVision,
            supportsReasoning: m.supportsReasoning,
            supportsCoding: m.supportsCoding,
            supportsAgentic: m.supportsAgentic,
            supportsThinkingToggle: m.supportsThinkingToggle,
            maxContextSize: m.maxContextSize,
            inferenceDefaults: m.inferenceDefaults,
            llamaCppArgs: m.llamaCppArgs,
            reasoningParser: m.reasoningParser,
            enableMtp: m.enableMtp,
            npuSupport: m.npuSupport,
            largeMoe: m.largeMoe,
            requiresPhison: m.requiresPhison,
            isPredefined: m.isPredefined,
          }
        }),
        (m) => flagsForCatalogModel(m.type, undefined, m.name),
      )

      // Cloud Mode models are not downloaded locally — they come from the
      // selected provider's fetched /v1/models list. Surface them as type
      // 'cloud' models so the existing model dropdown (filtered by backend)
      // picks them up.
      if (cloudMode.isFeatureEnabled && cloudMode.selectedProvider) {
        // Fall back to a synthetic "default" model when the provider exposes
        // none, so the backend stays selectable and chattable (many providers
        // accept a placeholder model id — see CLOUD_DEFAULT_MODEL).
        const providerModels = cloudMode.selectedProvider.models.length
          ? cloudMode.selectedProvider.models
          : [CLOUD_DEFAULT_MODEL]
        const selectedCloud = selectedModels.value.cloud
        const hasValidCloudSelection = providerModels.includes(selectedCloud ?? '')
        providerModels.forEach((name, index) => {
          // Capabilities are parsed from the provider's /v1/models response;
          // models with no advertised capabilities are assumed fully capable so
          // capability-gated presets (e.g. Vision) can use them. `enable_thinking`
          // is a local-template kwarg remote providers may reject, so we never
          // claim the thinking toggle for cloud models (reasoning still surfaces
          // via the <think> extraction middleware in the chat store).
          const caps = cloudMode.capabilitiesFor(name)
          newModels.push({
            name,
            mmproj: undefined,
            type: 'cloud',
            downloaded: true, // remote — nothing to download
            active: name === selectedCloud || (!hasValidCloudSelection && index === 0),
            supportsToolCalling: caps.supportsToolCalling,
            supportsVision: caps.supportsVision,
            supportsReasoning: caps.supportsReasoning,
            // Remote providers say nothing about coding fitness; the picker does
            // not filter cloud models on capability anyway.
            supportsCoding: undefined,
            supportsAgentic: undefined,
            supportsThinkingToggle: false,
            // From the provider's `context_length`; undefined when it stays
            // silent, in which case consumers fall back to their own defaults.
            maxContextSize: caps.contextLength,
            // Sampling recommendations come from our own catalog, which only
            // describes local models.
            inferenceDefaults: undefined,
            llamaCppArgs: undefined,
            reasoningParser: undefined,
            enableMtp: undefined,
            npuSupport: undefined,
            largeMoe: undefined,
            requiresPhison: undefined,
            isPredefined: false,
            // Cloud model ids have no on-disk path of their own, so their flags
            // are keyed under the dedicated CLOUD_MODEL_PATH_KEY — which is what
            // lets a cloud model be favorited like any other.
            ...modelPreferences.flagsFor(CLOUD_MODEL_PATH_KEY, name),
          })
        })
      }

      console.log('llmModels changed', newModels)
      return newModels
    })

    const llmEmbeddingModels: Ref<LlmModel[]> = computed(() => {
      const llmEmbeddingTypeModels = models.models.filter((m) => m.type === 'embedding')
      console.log('llmEmbeddingTypeModels', llmEmbeddingTypeModels)

      // Find first embedding model for each backend (already in priority order from models.json)
      const firstEmbeddingByBackend = new Map<string, string>()
      for (const m of llmEmbeddingTypeModels) {
        const backendKey = m.backend as string
        if (backendKey && !firstEmbeddingByBackend.has(backendKey)) {
          firstEmbeddingByBackend.set(backendKey, m.name)
        }
      }

      const newEmbeddingModels: LlmModel[] = withPreferenceFlags(
        llmEmbeddingTypeModels.map((m) => {
          const selectedEmbeddingModelForType =
            selectedEmbeddingModels.value[m.backend as LlmBackend]
          const hasValidSelection = llmEmbeddingTypeModels.some(
            (model) => model.name === selectedEmbeddingModelForType,
          )
          const isFirstForBackend = m.name === firstEmbeddingByBackend.get(m.backend as string)

          return {
            name: m.name,
            type: m.backend as LlmBackend,
            downloaded: m.downloaded ?? false,
            active:
              m.name === selectedEmbeddingModelForType || (!hasValidSelection && isFirstForBackend),
          }
        }),
        // An embedding model's path key depends on its backend, which the mapped
        // shape carries as `type`.
        (m) => flagsForCatalogModel('embedding', m.type, m.name),
      )

      console.log('llmEmbeddingModels changed', newEmbeddingModels)
      return newEmbeddingModels
    })

    const runningOnOpenvinoNpu = computed(
      () =>
        !!backendServices.info
          .find((s) => s.serviceName === backendToService[backend.value])
          ?.devices.find((d) => d.selected)
          ?.id.includes('NPU'),
    )

    const selectModel = (backend: LlmBackend, modelName: string) => {
      selectedModels.value[backend] = modelName
    }

    const selectEmbeddingModel = (backend: LlmBackend, modelName: string) => {
      selectedEmbeddingModels.value[backend] = modelName
    }

    /**
     * Forget a model that no longer exists, e.g. after its files were deleted in
     * Model Management. Leaving it selected would make the next chat turn try to
     * load weights that are gone; clearing it lets the usual "first available
     * model" fallback take over.
     */
    const clearSelectionOfModel = (modelName: string) => {
      for (const key of Object.keys(selectedModels.value) as LlmBackend[]) {
        if (selectedModels.value[key] === modelName) selectedModels.value[key] = null
      }
      for (const key of Object.keys(selectedEmbeddingModels.value) as LlmBackend[]) {
        if (selectedEmbeddingModels.value[key] === modelName) {
          selectedEmbeddingModels.value[key] = null
        }
      }
    }

    // Get the selected device for a backend, defaulting to the active one. The
    // vRAM estimator asks about `llamaCPP` whatever is active, because it only
    // ever judges GGUF models.
    const selectedDeviceFor = (which: LlmBackend = backend.value): InferenceDevice | undefined => {
      const serviceName = backendToService[which] as BackendServiceName
      const serviceInfo = backendServices.info.find((s) => s.serviceName === serviceName)
      return serviceInfo?.devices.find((d) => d.selected)
    }

    const selectedDevice = (): InferenceDevice | undefined => selectedDeviceFor()

    const getCurrentDeviceId = (): string | null => selectedDevice()?.id ?? null

    const getCurrentDeviceName = (): string | null => selectedDevice()?.name ?? null

    const getDeviceNameForBackend = (which: LlmBackend): string | null =>
      selectedDeviceFor(which)?.name ?? null

    // Stable UUID of the currently selected device, when the backend exposes one.
    // Persisted alongside the id so a preset re-binds to the same physical device
    // even if its backend-local id shifts (driver update / enumeration reorder).
    const getCurrentDeviceUuid = (): string | null => {
      const serviceName = backendToService[backend.value] as BackendServiceName
      const serviceInfo = backendServices.info.find((s) => s.serviceName === serviceName)
      return serviceInfo?.devices.find((d) => d.selected)?.uuid ?? null
    }

    const backendToAipgModelType = {
      openVINO: 'openvinoLLM',
      llamaCPP: 'ggufLLM',
    } as const

    const activeModel: Ref<string | undefined> = computed(() => {
      const newActiveModel = llmModels.value
        .filter((m) => m.type === backend.value)
        .find((m) => m.active)?.name
      console.log('activeModel changed', newActiveModel)
      return newActiveModel
    })
    // The local backend used to compute RAG embeddings. For a local chat backend
    // this is the chat backend itself. In Cloud Mode the chat LLM is remote and
    // cannot embed, so fall back to a local backend that has an embedding model —
    // preferring one whose service is already set up. This lets documents be
    // embedded/retrieved locally while chatting with a remote model.
    const localEmbeddingBackends = ['llamaCPP', 'openVINO'] as const
    const embeddingBackend = computed<Exclude<LlmBackend, 'cloud'>>(() => {
      if (backend.value !== 'cloud') return backend.value
      const hasEmbeddingModel = (b: Exclude<LlmBackend, 'cloud'>) =>
        llmEmbeddingModels.value.some((m) => m.type === b)
      const isSetUp = (b: Exclude<LlmBackend, 'cloud'>) =>
        backendServices.info.find((s) => s.serviceName === backendToService[b])?.isSetUp === true
      return (
        localEmbeddingBackends.find((b) => isSetUp(b) && hasEmbeddingModel(b)) ??
        localEmbeddingBackends.find((b) => hasEmbeddingModel(b)) ??
        localEmbeddingBackends.find((b) => isSetUp(b)) ??
        'llamaCPP'
      )
    })

    const activeEmbeddingModel: Ref<string | undefined> = computed(() => {
      const newActiveEmbeddingModel = llmEmbeddingModels.value
        .filter((m) => m.type === embeddingBackend.value)
        .find((m) => m.active)?.name
      console.log('activeEmbeddingModel changed', newActiveEmbeddingModel)
      return newActiveEmbeddingModel
    })

    const contextSizeSettingSupported = computed(
      () =>
        backend.value === 'llamaCPP' ||
        (backend.value === 'openVINO' && runningOnOpenvinoNpu.value),
    )

    // OpenVINO on GPU uses a dynamic KV cache: the effective context size is
    // determined at runtime based on available VRAM rather than a fixed setting.
    const contextSizeIsDynamic = computed(
      () => backend.value === 'openVINO' && !runningOnOpenvinoNpu.value,
    )

    // Backend preparation computed properties
    const needsBackendPreparation = computed(() => {
      const currentModel = activeModel.value
      const currentContext = contextSize.value
      const currentBackend = backend.value

      const lastModel = backendReadinessState.lastUsedModel[currentBackend]
      const lastContext = backendReadinessState.lastUsedContextSize[currentBackend]

      return (
        currentModel !== lastModel ||
        (contextSizeSettingSupported.value && currentContext !== lastContext)
      )
    })

    const preparationReason = computed(
      (): 'model-change' | 'context-change' | 'backend-switch' | null => {
        if (!backendReadinessState.isPreparingBackend) return null

        const currentModel = activeModel.value
        const currentContext = contextSize.value
        const currentBackend = backend.value

        const lastModel = backendReadinessState.lastUsedModel[currentBackend]
        const lastContext = backendReadinessState.lastUsedContextSize[currentBackend]

        if (currentModel !== lastModel) return 'model-change'
        if (contextSizeSettingSupported.value && currentContext !== lastContext)
          return 'context-change'
        return 'backend-switch'
      },
    )

    const preparationMessage = computed(() => {
      const reason = preparationReason.value
      const currentBackend = backend.value

      switch (reason) {
        case 'model-change':
          return `Loading ${activeModel.value} model...`
        case 'context-change':
          return `Adjusting context size to ${contextSize.value}...`
        case 'backend-switch':
          return `Preparing ${textInferenceBackendDisplayName[currentBackend]} backend...`
        default:
          // Fallback for when needsBackendPreparation is false but we still show loading
          return `Preparing ${textInferenceBackendDisplayName[currentBackend]} backend...`
      }
    })

    const metricsEnabled = ref(true)
    const aipgToolsEnabled = ref(true)
    // "Speak replies": read a reply aloud when the user's input was speech. Edited on
    // the Text To Speech tool row (SettingsBuiltinTools) and stored per chat preset
    // like the other tool settings, so it applies to whichever preset is active —
    // the assistant auto-plays in the app, the Home Agent answers a voice message
    // with a voice message. Initialized per preset on load; see
    // `defaultSpeakReplies` / `speakRepliesAllowed`.
    const speakReplies = ref(false)
    const mcpToolsEnabled = ref(true)
    // Route the heavy media tools (comfyUI + comfyUiImageEdit) through the
    // nested media specialist agent: the parent model sees one thin `media`
    // tool instead of the full workflow catalog/schemas. In Agent Mode,
    // flipping this changes the Pi tool set and therefore starts a new Pi
    // session on the next turn.
    const toolDelegationEnabled = ref(true)
    // Whether the model should think before answering. Only meaningful for models
    // whose template honors `enable_thinking` (see modelSupportsThinkingToggle);
    // the value is injected as chat_template_kwargs.enable_thinking at inference.
    const thinkingEnabled = ref(true)
    // MTP draft length (`num_assistant_tokens`) for OpenVINO models that ship the graph.
    const numAssistantTokens = ref(OVMS_MTP_ASSISTANT_TOKENS)

    // Per-built-in-tool enablement overrides (by tool name). Most built-in tools
    // default on; opt-in/privacy-sensitive tools (captureScreenshot) default off.
    // Persisted per chat preset via settingsPerPreset, like the per-workflow map
    // below: Chat and Agent Mode share these refs, so a global would let one
    // surface's tool choice disarm the other's.
    const builtinToolEnablement = ref<Record<string, boolean>>({})
    // The global map an older build persisted, kept in memory as the fallback for
    // presets whose settings were never saved and so could not be seeded on
    // hydration (see migrateGlobalToolEnablement).
    const legacyToolEnablement = ref<ToolEnablement | null>(null)
    // The single desktop window captureScreenshot is bound to. The screenshot
    // tool can only ever capture this user-selected window.
    const screenshotWindow = ref<ScreenshotWindow | null>(null)

    function isBuiltinToolEnabled(toolName: string): boolean {
      return isToolEnabled(builtinToolEnablement.value, toolName)
    }

    function setBuiltinToolEnabled(toolName: string, enabled: boolean): void {
      builtinToolEnablement.value = { ...builtinToolEnablement.value, [toolName]: enabled }
    }

    /**
     * Carry a pre-per-preset global tool enablement into each preset's settings,
     * so an upgrade keeps the tools the user had turned off. Run once on
     * hydration, with the raw persisted state the plugin read.
     */
    function migrateGlobalToolEnablement(rawPersistedState: string | null): void {
      const legacy = readLegacyToolEnablement(rawPersistedState)
      if (!legacy) return
      legacyToolEnablement.value = legacy
      settingsPerPreset.value = seedToolEnablementPerPreset(settingsPerPreset.value, legacy)
    }

    /**
     * Default for "Speak replies": on for the Home Agent, where a voice message
     * asks for a voice answer, and off elsewhere so the desktop app never starts
     * talking without the user having asked for it.
     */
    function defaultSpeakReplies(presetName?: string): boolean {
      return presetName === HOME_AGENT_CHAT_PRESET_NAME
    }

    /**
     * Whether replies may be spoken for a preset: its "Speak replies" toggle and
     * tools must be on, and the Text To Speech tool (which supplies the voice) must
     * be enabled — that is what the toggle rides on in the UI.
     *
     * Pass `presetName` to read the *stored* value for a preset instead of the live
     * refs. The Home Agent needs that: it answers on its own preset, while the live
     * refs may already hold the desktop user's preset again. A preset with nothing
     * saved yet falls back to that preset's default.
     */
    function speakRepliesAllowed(presetName?: string): boolean {
      if (!isBuiltinToolEnabled('synthesizeTextToSpeech')) return false
      if (!presetName) return aipgToolsEnabled.value && speakReplies.value
      const saved = findSettingsForPreset(presetName)
      const toolsOn = (saved?.aipgToolsEnabled as boolean | undefined) ?? aipgToolsEnabled.value
      const speakOn =
        (saved?.speakReplies as boolean | undefined) ?? defaultSpeakReplies(presetName)
      return toolsOn && speakOn
    }

    /** Stored settings for a preset, by exact key or the first of its variants. */
    function findSettingsForPreset(presetName: string): Record<string, unknown> | undefined {
      const exact = settingsPerPreset.value[presetName]
      if (exact) return exact
      const variantKey = Object.keys(settingsPerPreset.value).find((key) =>
        key.startsWith(`${presetName}:`),
      )
      return variantKey ? settingsPerPreset.value[variantKey] : undefined
    }

    // Per-workflow (ComfyUI preset) enablement for preset-backed built-in tools
    // (Generate media, Edit images), keyed by preset name. Default true so all
    // workflows stay exposed to the model unless explicitly disabled. Persisted
    // per chat preset via settingsPerPreset (see the save watcher / loader).
    const builtinToolPresetEnablement = ref<Record<string, boolean>>({})

    function isWorkflowPresetEnabled(presetName: string): boolean {
      return builtinToolPresetEnablement.value[presetName] ?? true
    }

    function setWorkflowPresetEnabled(presetName: string, enabled: boolean): void {
      builtinToolPresetEnablement.value = {
        ...builtinToolPresetEnablement.value,
        [presetName]: enabled,
      }
    }

    // Default preset per built-in-tool slot, keyed by "<toolName>:<mediaType>"
    // (e.g. "comfyUI:image", "comfyUiImageEdit:video"). Lets the user pick which
    // workflow the assistant reaches for by default per use case. Persisted per
    // chat preset via settingsPerPreset (mirrors builtinToolPresetEnablement).
    const builtinToolDefaultPresets = ref<Record<string, string>>({})

    // Initial per-slot defaults, preserving the workflows that used to be
    // hard-coded in the tool descriptions. Used when the user hasn't explicitly
    // picked a default yet, so behavior is unchanged out of the box. Slots not
    // listed here fall back to the first available preset.
    const INITIAL_DEFAULT_WORKFLOWS: Record<string, string> = {
      'comfyUI:image': 'Draft Image',
      'comfyUiImageEdit:image': 'Edit By Prompt',
    }

    // Resolve the effective default for a slot: the stored choice if it is among
    // the currently-available (enabled) presets, else the previous hard-coded
    // default, else the first available. Callers pass the candidate list so this
    // stays free of preset-grouping logic and can never return a disabled preset.
    function getDefaultWorkflow(key: string, availableNames: string[]): string | null {
      const stored = builtinToolDefaultPresets.value[key]
      if (stored && availableNames.includes(stored)) return stored
      const initial = INITIAL_DEFAULT_WORKFLOWS[key]
      if (initial && availableNames.includes(initial)) return initial
      return availableNames[0] ?? null
    }

    function setDefaultWorkflow(key: string, presetName: string): void {
      builtinToolDefaultPresets.value = {
        ...builtinToolDefaultPresets.value,
        [key]: presetName,
      }
    }

    const maxTokens = ref<number>(1024)
    // The size actually allocated: `requestedContextSize` bounded by the active model's
    // ceiling (and the KM floor, where that applies).
    const contextSize = ref<number>(8192)
    // The size asked for, kept unbounded so the bounds can be re-applied from scratch
    // whenever they move. See PhisonKmRagDeps.requestedContextSize for why the bounded
    // value alone is not enough to hold on to.
    const requestedContextSize = ref<number>(8192)
    // True once the context box has been committed by hand. Until then a Phison
    // preset stuck on the KM floor (the box used to reject keystrokes) adopts the
    // preset's context size instead of keeping that floor.
    const contextSizeEdited = ref(false)
    function markContextSizeEdited() {
      contextSizeEdited.value = true
    }
    const DEFAULT_TEMPERATURE = 0.7
    const temperature = ref<number>(DEFAULT_TEMPERATURE)
    // The recommendation we last wrote into `temperature` / `reasoningEffort`.
    // A setting still equal to what we wrote counts as untouched and may be
    // replaced when the model or the thinking mode changes; anything else is the
    // user's choice. Persisted per preset alongside the settings themselves.
    const temperatureFromModel = ref<number | undefined>(undefined)
    // Depth of the reasoning trace for templates that read `reasoning_effort`
    // (Qwen3.8). Undefined until a model that supports it is active.
    const reasoningEffort = ref<ReasoningEffort | undefined>(undefined)
    const reasoningEffortFromModel = ref<ReasoningEffort | undefined>(undefined)

    const knownReasoningEffort = (value: unknown): ReasoningEffort | undefined =>
      reasoningEfforts.includes(value as ReasoningEffort) ? (value as ReasoningEffort) : undefined

    // Get max context size from current model
    const maxContextSizeFromModel = computed(() => {
      const currentModel = llmModels.value
        .filter((m) => m.type === backend.value)
        .find((m) => m.active)
      return currentModel?.maxContextSize
    })

    // The window the current turn actually gets, i.e. the denominator of the
    // context gauge. `contextSize` is what we ask a local backend to allocate, so
    // it only speaks for the window when the backend is ours: OpenVINO on GPU
    // sizes it at runtime, and a cloud provider's window comes from its
    // /v1/models `context_length`.
    const effectiveContextWindow = computed(() => {
      if (contextSizeIsDynamic.value) return maxContextSizeFromModel.value ?? 0
      if (backend.value === 'cloud') return maxContextSizeFromModel.value ?? contextSize.value
      // OVMS is started with a capped --max_prompt_len on NPU, so a larger
      // setting is not what the turn gets there.
      if (runningOnOpenvinoNpu.value) return npuPromptLen(contextSize.value)
      return contextSize.value
    })

    /**
     * `maxTokens` bounded by what the window can actually hold — the value to send as
     * `max_output_tokens`, in place of the raw setting. See `boundMaxOutputTokens`.
     */
    const effectiveMaxTokens = computed(() =>
      boundMaxOutputTokens(maxTokens.value, effectiveContextWindow.value),
    )

    // Check if the active model supports tool calling
    const modelSupportsToolCalling = computed(() => {
      const currentModel = llmModels.value
        .filter((m) => m.type === backend.value)
        .find((m) => m.active)
      return currentModel?.supportsToolCalling === true
    })

    // Check if the active model supports vision
    const modelSupportsVision = computed(() => {
      const currentModel = llmModels.value
        .filter((m) => m.type === backend.value)
        .find((m) => m.active)
      return currentModel?.supportsVision === true
    })

    // Check if the active model supports toggling thinking on/off (Qwen3 family, gemma4)
    const modelSupportsThinkingToggle = computed(() => {
      const currentModel = llmModels.value
        .filter((m) => m.type === backend.value)
        .find((m) => m.active)
      return currentModel?.supportsThinkingToggle === true
    })

    // ── Per-model recommended inference settings ────────────────────────────
    //
    // A catalog entry may carry the sampling the model's publisher recommends
    // (models.json `inferenceDefaults`). Hybrid-thinking models want different
    // numbers per mode, so the profile is resolved against the thinking state
    // and re-resolved whenever either side changes.

    const activeLlmModel = computed(() =>
      llmModels.value.filter((m) => m.type === backend.value).find((m) => m.active),
    )

    const modelSupportsMtp = computed(
      () =>
        backend.value === 'openVINO' &&
        !runningOnOpenvinoNpu.value &&
        activeLlmModel.value?.enableMtp === true,
    )

    // Whether the next turn reasons. The toggle only speaks for models whose
    // template honors it; for the rest the model's own nature decides.
    const thinkingActive = computed(() =>
      modelSupportsThinkingToggle.value
        ? thinkingEnabled.value
        : activeLlmModel.value?.supportsReasoning === true,
    )

    const recommendedSampling = computed(() =>
      resolveSampling(activeLlmModel.value?.inferenceDefaults, thinkingActive.value),
    )

    // The sampling fields to put on the request body. Cloud providers reject
    // parameters they do not model, and only local backends run the very model
    // the recommendation was written for, so remote turns get nothing.
    const samplingRequestBody = computed<Record<string, number>>(() => {
      if (backend.value === 'cloud') return {}
      const body = toRequestBody(recommendedSampling.value, backend.value)
      if (backend.value !== 'openVINO') return body
      // Main drops this when the launch did not arm MTP, so the first turn after
      // a model load still carries the user's value.
      return { ...body, ...ovmsMtpRequestFields(modelSupportsMtp.value, numAssistantTokens.value) }
    })

    // A model that recommends an effort is one whose template reads it.
    const modelReasoningEffort = computed(() =>
      recommendedReasoningEffort(activeLlmModel.value?.inferenceDefaults),
    )
    const modelSupportsReasoningEffort = computed(() => modelReasoningEffort.value !== undefined)
    const effectiveReasoningEffort = computed(() =>
      modelSupportsReasoningEffort.value
        ? (reasoningEffort.value ?? modelReasoningEffort.value)
        : undefined,
    )

    /**
     * Adopt what the active model recommends. Only settings still holding the
     * value we last wrote are replaced, so a temperature the preset declares or
     * the user dialled in survives a model switch or a flip of the thinking
     * toggle. Presets that predate this mechanism have no recorded default;
     * their temperature is adoptable only while it is the app's own default.
     */
    function applyModelInferenceDefaults(): void {
      const recommendedTemperature = recommendedSampling.value.temperature
      if (
        recommendedTemperature !== undefined &&
        activePreset.value?.temperature === undefined &&
        isAdoptable(temperature.value, temperatureFromModel.value, DEFAULT_TEMPERATURE)
      ) {
        temperature.value = recommendedTemperature
        temperatureFromModel.value = recommendedTemperature
      }

      if (
        modelReasoningEffort.value !== undefined &&
        isAdoptable(reasoningEffort.value, reasoningEffortFromModel.value)
      ) {
        reasoningEffort.value = modelReasoningEffort.value
        reasoningEffortFromModel.value = modelReasoningEffort.value
      }
    }

    watch([() => activeLlmModel.value?.name, thinkingActive], applyModelInferenceDefaults)

    // Check if the active preset requires tool calling
    const presetRequiresToolCalling = computed(() => {
      return activePreset.value?.requiresToolCalling === true
    })

    // Determine if RAG will be used - single source of truth
    const willUseRag = computed(() => {
      const hasCheckedDocuments = ragList.value.some((item) => item.isChecked)
      const presetEnablesRag = activePreset.value?.enableRAG === true
      return hasCheckedDocuments && presetEnablesRag
    })

    watch(
      [
        selectionMemoryPaused,
        backend,
        activeModel,
        activeEmbeddingModel,
        willUseRag,
        contextSize,
        () => activeLlmModel.value?.llamaCppArgs,
      ],
      () => {
        if (typeof window === 'undefined' || selectionMemoryPaused.value > 0) return
        const selection = chatBackendSelectionLoad({
          backend: backend.value,
          llmModelName: activeModel.value,
          embeddingModelName: activeEmbeddingModel.value,
          willUseRag: willUseRag.value,
          contextSize: contextSize.value,
          llamaCppArgs: activeLlmModel.value?.llamaCppArgs,
        })
        if (selection.kind !== 'local') return
        const remember = window.electronAPI?.rememberChatBackendLoad
        if (!remember) return
        void remember(selection.load).catch((error: unknown) => {
          console.warn('Could not remember chat backend selection:', error)
        })
      },
    )

    // Phison KM RAG state (retrieval-mode toggle, availability gating, context-size
    // floor/stash) lives in its own module — see aidaptiv-km-rag-review-scope.md §W1.
    // getActivePreset/isLoadingSettings are passed as thunks rather than direct
    // values because this call sits above where `isLoadingSettings` (a `let`
    // near the persistence watchers) is declared in this same setup() function —
    // reading it eagerly here would throw ("used before initialization"). The
    // thunks are only invoked lazily, inside computed/watch callbacks that run
    // well after setup() has finished. `activePreset` is declared at the top of
    // setup so the `willUseRag` watch can evaluate it during store creation.
    const {
      ragMode,
      stashedStandardContextSize,
      phisonSsdPresent,
      kmContextFloorReachable,
      phisonKmAvailable,
      isPhisonKmRag,
      enforceKmContextFloor,
      contextSizeAdjust,
    } = createPhisonKmRag({
      contextSize,
      requestedContextSize,
      maxContextSizeFromModel,
      getActivePreset: () => activePreset.value,
      backend,
      backendServices,
      isLoadingSettings: () => isLoadingSettings,
    })

    // Per-preset settings persistence
    const settingsPerPreset = ref<Record<string, Record<string, unknown>>>({})

    // Step 8 (§6.1): the per-preset settings are kernel-owned preferences
    // (preferences.json). The Pinia key still persists the rest of the pick,
    // so the one-shot upload only slims this field out of it.
    const settingsPrefs = makeFileBackedPreference({
      section: 'textInference',
      refs: { settingsPerPreset },
      legacyKey: 'textInference',
      legacySlim: true,
    })
    if (import.meta.hot) import.meta.hot.dispose(() => settingsPrefs.dispose())

    // Step 8 (§6.1): the RAG document list is app data — the full split text
    // of everything the user indexed — so it lives in its own kernel-owned
    // file (rag/documents.json), not the preferences file. The pinia key
    // keeps the non-RAG fields, so this half also only slims its field out.
    // No payload transform: mergedGroups has been boundary-only for a while,
    // so persisting splitDB alongside it is safe (the old serializer note).
    const ragApi: FileBackedPreferencesApi = {
      read: async () => {
        const r = await window.electronAPI.ragDocuments.read()
        if (!r.success) return { success: false as const, error: r.error }
        // An absent file is the "never migrated" state; a failed read
        // (success false) never is.
        return r.section === null
          ? { success: true as const, sections: {} }
          : { success: true as const, sections: { textInference: r.section } }
      },
      migrate: (_section, payload) => window.electronAPI.ragDocuments.migrate(payload),
      write: (_section, value) => window.electronAPI.ragDocuments.write(value),
    }
    const ragPrefs = makeFileBackedPreference({
      section: 'textInference',
      refs: { ragList },
      legacyKey: 'textInference',
      legacySlim: true,
      api: ragApi,
      errorScope: 'rag-documents',
    })
    if (import.meta.hot) import.meta.hot.dispose(() => ragPrefs.dispose())

    async function init(): Promise<void> {
      await settingsPrefs.init()
      // Settings are stored per preset name, which a renamed preset no longer
      // has — the same fix that used to live in pinia afterHydrate.
      migrateRenamedPresetSettings()
      // The old global tool map is not a section field; seed it into the
      // hydrated per-preset settings from the leftover captured at setup.
      migrateGlobalToolEnablement(settingsPrefs.legacyRaw)
      // The catalog-ready watch can fire before this hydrate (preset files
      // load during conversations/media init) and would otherwise apply
      // defaults from an empty map, then never reload.
      loadSettingsForActivePreset()
      // The rag half of the same shared legacy key runs strictly after the
      // settings half: interleaved read-modify-write slims can resurrect what
      // the other removed (§8.2).
      await ragPrefs.init()
      // The activeKey→selection watch below ran immediate at store setup,
      // against the pre-hydration list; re-apply it so the resumed thread's
      // selection wins over whatever isChecked the file carried.
      syncRagSelectionForActiveKey()
    }

    // Raw URL of the selected local inference backend. When Home Agent is
    // active, `currentBackendUrl` is that agent's loopback proxy instead
    // (X-AIPG-Auth / X-Upstream-Url); callers that cannot attach those headers
    // dial the backend through this.
    const localBackendUrl = computed(
      () =>
        backendServices.info.find((item) => item.serviceName === backendToService[backend.value])
          ?.baseUrl,
    )

    const currentBackendUrl = computed(() => {
      if (backend.value === 'cloud') {
        return cloudMode.activeProviderBaseUrl
      }
      if (homeAgent.isHomeAgentActive && homeAgent.homeAgentBaseUrl) {
        return homeAgent.homeAgentBaseUrl
      }
      return localBackendUrl.value
    })

    // When Home Agent is active, the real inference backend URL to proxy through
    const homeAgentUpstreamUrl = computed(() =>
      homeAgent.isHomeAgentActive ? localBackendUrl.value : undefined,
    )

    async function getDownloadParamsForCurrentModelIfRequired(
      type: 'llm' | 'embedding',
      options: { needsVision?: boolean } = {},
    ) {
      // Cloud Mode chat LLMs are served remotely — nothing to download. Embedding
      // models, however, run on a LOCAL backend even in Cloud Mode (see
      // embeddingBackend), so an embedding download can still be required.
      if (backend.value === 'cloud' && type === 'llm') return []
      // For embeddings, resolve against the (possibly local-fallback) embedding
      // backend; for the LLM, use the chat backend (never 'cloud' here).
      const localBackend =
        type === 'embedding'
          ? embeddingBackend.value
          : (backend.value as Exclude<LlmBackend, 'cloud'>)
      let model: string | undefined
      if (type === 'llm') {
        model = activeModel.value
      } else {
        model = activeEmbeddingModel.value
      }
      if (!model) return []

      const modelMetaData = llmModels.value
        .filter((m) => m.type === localBackend)
        .find((m) => m.active)
      const modelType = type === 'embedding' ? 'embedding' : backendToAipgModelType[localBackend]
      const backendName = backendToAipgBackendName[localBackend]

      const checkList = [
        {
          repo_id: model,
          type: modelType,
          backend: backendName,
        },
      ]
      // The multimodal projector only applies to a vision LLM — never pull it for
      // an embedding-only download (its "active model" lookup is incidental here).
      // A text turn runs without it (llama.cpp only passes --mmproj when the file
      // is beside the model), so asking for it would be a gigabyte the turn does
      // not use — and on a remote Home Agent turn, a download question nobody
      // expected.
      if (type === 'llm' && options.needsVision && modelMetaData?.mmproj) {
        checkList.push({
          repo_id: modelMetaData.mmproj,
          type: backendToAipgModelType[localBackend],
          backend: backendName,
        })
      }
      const checkedModels = await models.checkModelAlreadyLoaded(checkList)
      const notYetDownloaded = checkedModels.filter((m) => !m.already_loaded)
      return notYetDownloaded
    }

    function toggleMetrics() {
      metricsEnabled.value = !metricsEnabled.value
    }

    const fontSizeIndex = ref<number>(1)
    const fontSizes = [
      'text-xs',
      'text-sm',
      'text-base',
      'text-lg',
      'text-xl',
      'text-2xl',
      'text-3xl',
      'text-4xl',
      'text-5xl',
      'text-6xl',
      'text-7xl',
      'text-8xl',
      'text-9xl',
    ]
    const iconSizes = [
      'size-[40px]',
      'size-[42px]',
      'size-[44px]',
      'size-[46px]',
      'size-[48px]',
      'size-[50px]',
      'size-[52px]',
      'size-[54px]',
      'size-[56px]',
      'size-[58px]',
      'size-[60px]',
      'size-[62px]',
      'size-[64px]',
    ]

    const fontSizeClass = computed(() => fontSizes[fontSizeIndex.value])
    const nameSizeClass = computed(() => fontSizes[Math.max(fontSizeIndex.value - 2, 0)])
    const iconSizeClass = computed(() => iconSizes[fontSizeIndex.value])
    const isMaxSize = computed(() => fontSizeIndex.value >= fontSizes.length - 1)
    const isMinSize = computed(() => fontSizeIndex.value <= 0)

    function increaseFontSize() {
      if (!isMaxSize.value) {
        fontSizeIndex.value++
      }
    }

    function decreaseFontSize() {
      if (!isMinSize.value) {
        fontSizeIndex.value--
      }
    }

    async function addDocumentToRagList(document: IndexedDocument) {
      // Phison KM: if active, pass the embedding server URL for token-accurate grouping.
      let phisonKmConfig: PhisonKmIngestConfig | undefined
      if (isPhisonKmRag.value) {
        const embeddingUrlResult = await window.electronAPI.getEmbeddingServerUrl(
          backendToService['llamaCPP'],
        )
        if (embeddingUrlResult.success && embeddingUrlResult.url) {
          phisonKmConfig = { embeddingServerUrl: embeddingUrlResult.url }
        }
      }

      const langchainDocument: IndexedDocument = await window.electronAPI.addDocumentToRAGList(
        document,
        phisonKmConfig,
      )

      // mergedGroups is now boundary-only ({groupId, startChunkIdx, endChunkIdx}, ~50
      // bytes/group) — it no longer duplicates the document text, so it's safe to
      // persist directly alongside splitDB. No stripping, no custom serializer needed.
      const existing = ragList.value.find((item) => item.hash === langchainDocument.hash)
      if (existing) {
        // Same content (by hash) is already indexed. Don't duplicate, but honor
        // an explicit request to enable it (e.g. a Home Agent document upload
        // stub arrives with isChecked: true) so re-sending a file the user
        // already has makes it usable instead of silently no-op'ing.
        if (langchainDocument.isChecked) {
          existing.isChecked = true
          persistActiveRagSelection()
        }
        return
      }
      ragList.value.push(langchainDocument)
      if (langchainDocument.isChecked) {
        persistActiveRagSelection()
      }

      // Phison KM: pre-warm the KV cache for each merged group (fire-and-forget).
      // Pass ragSystemPrefix so warmup uses the identical prefix as the actual query.
      // Content is derived here from splitDB + the boundary-only mergedGroups — this
      // WarmupRequest payload is transient (never persisted), so carrying full text
      // in it is fine.
      // Prefer the direct llama.cpp upstream URL when Home Agent is active —
      // currentBackendUrl points at the Home Agent proxy, which does not own the KV cache.
      const warmupBackendUrl = homeAgentUpstreamUrl.value ?? currentBackendUrl.value
      if (
        isPhisonKmRag.value &&
        langchainDocument.mergedGroups?.length &&
        warmupBackendUrl &&
        activeModel.value
      ) {
        const warmupReq: WarmupRequest = {
          llmBackendUrl: warmupBackendUrl,
          mergedGroups: langchainDocument.mergedGroups.map((group) => ({
            groupId: group.groupId,
            content: deriveGroupContent(langchainDocument.splitDB, group),
          })),
          modelName: activeModel.value,
          ragSystemPrefix: PHISON_KM_RAG_PREFIX,
        }
        window.electronAPI.warmupKVCacheForDocument(warmupReq).catch((err) => {
          console.warn('Phison KV cache warmup failed (non-critical):', err)
        })
      }
    }

    async function embedInputUsingRag(prompt: string, useGroupRetrieval: boolean = false) {
      const checkedRagList = ragList.value
        .filter((item) => item.isChecked)
        .map((doc) => JSON.parse(JSON.stringify(doc)))
      if (checkedRagList.length === 0) {
        throw new Error('No documents selected')
      }
      if (!activeEmbeddingModel.value) {
        throw new Error('No embedding model selected')
      }

      // Embeddings always run on a LOCAL backend's embedding server (its own
      // port), even in Cloud Mode where the chat LLM is remote. Resolve that
      // server's URL from the embedding backend rather than the chat backend.
      const serviceName = backendToService[embeddingBackend.value]
      const embeddingUrlResult = await window.electronAPI.getEmbeddingServerUrl(serviceName)
      if (!embeddingUrlResult.success) {
        throw new Error(embeddingUrlResult.error)
      }
      const backendBaseUrl = embeddingUrlResult.url

      const newEmbedInquiry: EmbedInquiry = {
        prompt: prompt,
        ragList: checkedRagList,
        backendBaseUrl: backendBaseUrl,
        embeddingModel: activeEmbeddingModel.value,
        maxResults: runningOnOpenvinoNpu.value ? 2 : 8,
        useGroupRetrieval,
        // Per-document retrieval: each document contributes its top chunks independently.
        perDocResults: runningOnOpenvinoNpu.value ? 1 : 5,
      }
      console.log('trying to request rag for', { newEmbedInquiry, ragList: ragList.value })
      const response = await window.electronAPI.embedInputUsingRag(newEmbedInquiry)
      return response
    }

    /**
     * Mirror the active conversation's RAG selection into the shared library's
     * live `isChecked` flags. Called whenever the active conversation changes so
     * the UI + inference path (which all read `isChecked`) reflect the thread's
     * own selection. A conversation with no stored selection (e.g. a brand-new
     * one) ends up with everything unchecked.
     */
    function syncRagSelectionForActiveKey() {
      const enabled = new Set(conversations.getThreadRagHashes(conversations.activeKey))
      ragList.value.forEach((item) => (item.isChecked = enabled.has(item.hash)))
    }

    /** Persist the current live selection back onto the active conversation. */
    function persistActiveRagSelection() {
      if (!conversations.activeKey) return
      conversations.setThreadRagHashes(
        conversations.activeKey,
        ragList.value.filter((item) => item.isChecked).map((item) => item.hash),
      )
    }

    function updateFileCheckStatus(hash: string, isChecked: boolean) {
      const index = ragList.value.findIndex((item) => item.hash === hash)
      if (index !== -1) {
        ragList.value[index].isChecked = isChecked
      }
      persistActiveRagSelection()
    }

    function deleteFile(hash: string) {
      const index = ragList.value.findIndex((item) => item.hash === hash)
      if (index !== -1) {
        ragList.value.splice(index, 1)
      }
      persistActiveRagSelection()
    }

    function checkAllFiles() {
      ragList.value.forEach((item) => (item.isChecked = true))
      persistActiveRagSelection()
    }

    function uncheckAllFiles() {
      ragList.value.forEach((item) => (item.isChecked = false))
      persistActiveRagSelection()
    }

    function deleteAllFiles() {
      ragList.value.length = 0
      persistActiveRagSelection()
    }

    // Backend preparation methods
    function startBackendPreparation() {
      backendReadinessState.isPreparingBackend = true
      // Surface backend/model start as an activity on the active chat turn so the
      // user sees "Loading <model>…" / "Preparing <backend> backend…" instead of
      // a silent wait. (preparationMessage reflects the current reason.)
      if (backendPrepActivityId) activities.end(backendPrepActivityId)
      backendPrepActivityId = activities.begin({
        category: 'backend',
        label: preparationMessage.value,
        scope: { kind: 'chat', conversationKey: conversations.activeKey },
      })
    }

    function completeBackendPreparation() {
      backendReadinessState.isPreparingBackend = false
      if (backendPrepActivityId) {
        activities.end(backendPrepActivityId)
        backendPrepActivityId = null
      }
      updateLastUsedConfig()
    }

    function updateLastUsedConfig() {
      const currentBackend = backend.value
      backendReadinessState.lastUsedModel[currentBackend] = activeModel.value ?? null
      backendReadinessState.lastUsedContextSize[currentBackend] = contextSize.value
    }

    function notifyOvmsMtpStale(): void {
      const modelRepoId = backendServices.info.find(
        (service) => service.serviceName === 'openvino-backend',
      )?.ovmsMtpStaleModel
      if (!claimOvmsMtpStaleNotice(modelRepoId, localStorage)) return
      const message = (i18nState.OVMS_MTP_STALE_MODEL ?? '').replace('{model}', modelRepoId ?? '')
      notify(message, () => {
        uiStore.openModelManager()
      })
    }

    async function ensureBackendReadiness(options?: { remember?: boolean }): Promise<void> {
      // Cloud Mode has no local subprocess and no model to (re)load — the
      // remote provider is always "ready".
      if (backend.value === 'cloud') return
      if (backend.value === 'llamaCPP' || backend.value === 'openVINO') {
        const serviceName = backendToService[backend.value]
        const llmModelName = activeModel.value
        const embeddingModelName = activeEmbeddingModel.value

        if (!llmModelName) {
          throw new Error('No active LLM model selected')
        }

        const embeddingModelToSend = willUseRag.value ? embeddingModelName : undefined

        if (willUseRag.value && !embeddingModelName) {
          throw new Error('No embedding model selected but RAG documents are enabled')
        }

        try {
          // The GPU-window admission is the orchestrator's (step 7). Keep
          // Models Loaded skips that wait — the 6th IPC arg is skipGpuAdmission,
          // not an inverted stopImageServer.
          await backendServices.ensureBackendReadiness(
            serviceName,
            llmModelName,
            embeddingModelToSend,
            contextSize.value,
            // Only llama.cpp reads these; OVMS MTP is `--draft_model_path`, decided
            // in the main process from the catalog's `enableMtp` flag.
            backend.value === 'llamaCPP' ? activeLlmModel.value?.llamaCppArgs : undefined,
            skipGpuAdmissionFromKeepModelsLoaded(developerSettings.keepModelsLoaded),
            options,
          )
          if (backend.value === 'openVINO') notifyOvmsMtpStale()
        } catch (error) {
          // Surface model-load failures (e.g. out of memory for the chosen
          // context size) to the user. This is the single chokepoint for both
          // the chat-send path and direct backend restarts, so the toast fires
          // regardless of what triggered the (re)load.
          toast.error(error instanceof Error ? error.message : String(error))
          throw error
        }
      }

      // If Home Agent is active, also ensure it is running
      if (homeAgent.isHomeAgentActive) {
        const homeAgentInfo = backendServices.info.find(
          (s) => s.serviceName === 'home-agent-backend',
        )
        if (homeAgentInfo && homeAgentInfo.isSetUp && homeAgentInfo.status !== 'running') {
          await backendServices.startService('home-agent-backend')
        }
      }
    }

    async function checkModelAvailability(options: { needsVision?: boolean } = {}) {
      // ToDo: the path for embedding downloads must be corrected and BAAI/bge-large-zh-v1.5 was accidentally downloaded to the wrong place
      const requiredModelDownloads = await getDownloadParamsForCurrentModelIfRequired(
        'llm',
        options,
      )
      if (willUseRag.value) {
        const requiredEmbeddingModelDownloads =
          await getDownloadParamsForCurrentModelIfRequired('embedding')
        requiredModelDownloads.push(...requiredEmbeddingModelDownloads)
      }

      // Deduplicate download list by repo_id to prevent the same model from appearing multiple times
      const uniqueDownloads = requiredModelDownloads.filter(
        (download, index, self) => index === self.findIndex((d) => d.repo_id === download.repo_id),
      )

      if (uniqueDownloads.length === 0) return
      // The permissions layer owns the prompt: the download modal, or the
      // channel when a remote Home Agent turn is active.
      await requestDownload(uniqueDownloads)
    }

    // Cloud Mode RAG: the chat LLM is remote and cannot embed, so bring up a
    // LOCAL embedding server (embeddingBackend) to embed documents + the query
    // before sending retrieved snippets to the remote model. No local LLM is
    // started. Missing/undownloaded models are handled by checkModelAvailability
    // (which prompts a download) ahead of this call; a truly absent local
    // embedding model surfaces a toast and RAG is skipped downstream.
    async function ensureCloudRagEmbeddingServer() {
      const embeddingModelName = activeEmbeddingModel.value
      if (!embeddingModelName) {
        toast.error(
          `RAG needs a local embedding model. Install one to use documents with ${HYBRID_CLOUD_NAME}.`,
        )
        return
      }
      const serviceName = backendToService[embeddingBackend.value]
      startBackendPreparation()
      try {
        await backendServices.ensureEmbeddingServerReady(serviceName, embeddingModelName)
        completeBackendPreparation()
      } catch (error) {
        completeBackendPreparation()
        toast.error(error instanceof Error ? error.message : String(error))
        throw error
      }
    }

    async function prepareBackendIfNeeded(options?: { remember?: boolean }) {
      console.log('in prepareBackendIfNeeded')

      // Cloud Mode: the chat LLM is remote — nothing to start, load, or
      // device-select for chat. But when RAG is active we still need a LOCAL
      // embedding server running to embed docs + query (see embeddingBackend).
      if (backend.value === 'cloud') {
        if (willUseRag.value) await ensureCloudRagEmbeddingServer()
        return
      }

      // Always show loading bar for llamaCPP/openVINO when ensuring backend readiness
      // This ensures consistent UX even when switching back to a previously-used backend
      if (backend.value === 'llamaCPP' || backend.value === 'openVINO') {
        startBackendPreparation()
        try {
          await ensureBackendReadiness(options)
          completeBackendPreparation()
        } catch (error) {
          completeBackendPreparation() // Reset state on error
          throw error
        }
      }

      // cloud returned early above, so this only runs for local backends.
      const inferenceBackendService = backendToService[backend.value]
      if (inferenceBackendService) {
        await backendServices.resetLastUsedInferenceBackend(inferenceBackendService)
        backendServices.updateLastUsedBackend(inferenceBackendService)
      }
    }

    async function ensureReadyForInference(options?: { remember?: boolean }) {
      await checkModelAvailability()
      await prepareBackendIfNeeded(options)
    }

    // ========================================================================
    // Chat Preset Management
    // ========================================================================

    // Get setting key for current preset (includes variant if present)
    function getSettingsKey(): string {
      if (!activePreset.value?.name) return ''
      const variantName = presetsStore.activeVariantName[activePreset.value.name]
      return variantName ? `${activePreset.value.name}:${variantName}` : activePreset.value.name
    }

    /**
     * Follow a renamed preset's settings to its current name, so a rename does not
     * silently reset the model, context size and thinking state the user chose for
     * it (the settings key is the preset's name, plus its variant).
     */
    function migrateRenamedPresetSettings(): void {
      settingsPerPreset.value = renamePresetKeys(settingsPerPreset.value)
    }

    const isSystemPromptVisible = computed(() => activePreset.value?.advancedMode === true)
    // Currently unused inside the store; kept (with the convention `_` prefix) as a
    // ready-to-expose computed for UI components that want to mirror the preset's
    // tools-toggle visibility without re-deriving the rule.
    const _isToolsToggleVisible = computed(
      () => activePreset.value?.showTools === true && modelSupportsToolCalling.value,
    )

    function getDefaultToolsEnabled(preset: ChatPreset): boolean {
      if (!modelSupportsToolCalling.value) return false
      return preset.toolsEnabledByDefault ?? preset.requiresToolCalling === true
    }

    // Load saved settings for the active preset
    function loadSettingsForActivePreset() {
      console.log('Loading settings for active preset', activePreset.value)
      if (!activePreset.value) return

      const settingsKey = getSettingsKey()
      if (!settingsKey) return

      // Set flag to prevent watcher from interfering
      isLoadingSettings = true

      const savedSettings = settingsPerPreset.value[settingsKey] || {}
      console.log('Loading settings for preset', settingsKey, savedSettings)
      const preset = activePreset.value

      // Load backend - smart selection based on what's running
      if (savedSettings.backend !== undefined) {
        const savedBackend = savedSettings.backend as LlmBackend
        // Cloud Mode is a global, feature-flagged backend that SettingsChat offers
        // for any chat preset (see availableBackends), so a preset rarely lists it
        // in `backends`. Honor a saved 'cloud' choice whenever the feature is on —
        // otherwise a temporary preset switch (e.g. an image-gen tool call in an
        // agentic chat) would restore to llamaCPP instead of Cloud Mode.
        const cloudAllowed = savedBackend === 'cloud' && cloudMode.isFeatureEnabled
        // Only apply saved backend if it's in the preset's allowed backends
        if (preset.backends?.includes(savedBackend) || cloudAllowed) {
          backend.value = savedBackend
        } else {
          // Fall through to smart selection below
          selectBestBackend(preset)
        }
      } else {
        selectBestBackend(preset)
      }

      // Helper to select the best available backend from preset's allowed list.
      //
      // We intentionally do NOT carry over `backend.value` when the new preset
      // has no persisted choice: that branch caused per-preset settings to
      // silently inherit whichever preset was active just before. Concretely,
      // editing the Home Agent backend would change the Basic Chat backend on
      // the next switch, because Basic Chat had no saved entry yet and
      // "if current backend is allowed, keep it" pulled in the Home Agent
      // value from the global ref. Deterministic per-preset defaults make the
      // user's explicit choices the only thing that crosses presets.
      function selectBestBackend(preset: ChatPreset) {
        if (!preset.backends || preset.backends.length === 0) return

        if (preset.backends.length === 1) {
          backend.value = preset.backends[0]
          return
        }

        const runningBackend = preset.backends.find((b) => {
          const serviceName = backendToService[b] as BackendServiceName
          const backendInfo = backendServices.info.find((s) => s.serviceName === serviceName)
          return backendInfo && backendInfo.status === 'running'
        })

        backend.value = runningBackend ?? preset.backends[0]
      }

      const serviceName = backendToService[backend.value] as BackendServiceName
      const serviceInfo = backendServices.info.find((s) => s.serviceName === serviceName)

      if (savedSettings.selectedDeviceId !== undefined) {
        // Restore saved device preference. Prefer the saved UUID so the preset
        // re-binds to the same physical device even if its id shifted (driver
        // update / enumeration reorder); fall back to the saved id.
        const savedDeviceId = savedSettings.selectedDeviceId as string
        const savedDeviceUuid =
          typeof savedSettings.selectedDeviceUuid === 'string'
            ? savedSettings.selectedDeviceUuid
            : null
        const byUuid = savedDeviceUuid
          ? serviceInfo?.devices.find((d) => d.uuid != null && d.uuid === savedDeviceUuid)
          : undefined
        const targetId =
          byUuid?.id ??
          (serviceInfo?.devices.some((d) => d.id === savedDeviceId) ? savedDeviceId : undefined)
        if (targetId !== undefined) {
          backendServices.selectDevice(serviceName, targetId)
        }
      } else {
        // Default to GPU if no preference saved
        const gpuDevice = serviceInfo?.devices.find((d) => d.id.includes('GPU'))
        if (gpuDevice && !gpuDevice.selected) {
          backendServices.selectDevice(serviceName, gpuDevice.id)
        }
      }

      // Load selected models (per backend)
      if (savedSettings.selectedModels !== undefined) {
        selectedModels.value = {
          ...selectedModels.value,
          ...(savedSettings.selectedModels as LlmBackendKV),
        }
      } else {
        // Check for preferredModels (per-backend defaults)
        const preferredModel = preset.preferredModels?.[backend.value]
        if (preferredModel) {
          // Only select if model exists in available models
          const modelExists = llmModels.value.some(
            (m) => m.name === preferredModel && m.type === backend.value,
          )
          if (modelExists) {
            selectModel(backend.value, preferredModel)
          }
        }
      }

      // Load selected embedding models (per backend)
      if (savedSettings.selectedEmbeddingModels !== undefined) {
        const savedEmbeddingModels = savedSettings.selectedEmbeddingModels as LlmBackendKV
        // Update the embedding model for the current backend if it was saved
        if (savedEmbeddingModels[backend.value] !== undefined) {
          selectEmbeddingModel(backend.value, savedEmbeddingModels[backend.value]!)
        } else {
          // Merge all saved embedding models
          selectedEmbeddingModels.value = {
            ...selectedEmbeddingModels.value,
            ...savedEmbeddingModels,
          }
        }
      } else {
        const embeddingModelToUse = preset.embeddingModel || preset.rag?.embeddingModel
        if (embeddingModelToUse) {
          selectEmbeddingModel(backend.value, embeddingModelToUse)
        }
      }

      // Load max tokens
      if (savedSettings.maxTokens !== undefined) {
        maxTokens.value = savedSettings.maxTokens as number
      } else if (preset.maxNewTokens !== undefined) {
        maxTokens.value = preset.maxNewTokens
      }

      // Load context size. `requestedContextSize` is the one that survives a model
      // ceiling, so prefer it when restoring; settings saved before it existed only
      // carry the bounded `contextSize`, which is the best intent they can offer.
      if (savedSettings.requestedContextSize !== undefined) {
        requestedContextSize.value = savedSettings.requestedContextSize as number
        contextSize.value = (savedSettings.contextSize as number) ?? requestedContextSize.value
      } else if (savedSettings.contextSize !== undefined) {
        contextSize.value = savedSettings.contextSize as number
        requestedContextSize.value = contextSize.value
      } else if (preset.contextSize !== undefined) {
        contextSize.value = preset.contextSize
        requestedContextSize.value = preset.contextSize
      }

      // A saved size at or under the KM floor on the aiDAPTIV preset is the floor
      // the box was locked to (the preset used to ship 8192). Take the preset's
      // window unless the box has been committed since.
      contextSizeEdited.value = savedSettings.contextSizeEdited === true
      if (
        !contextSizeEdited.value &&
        preset.requiresPhison === true &&
        preset.contextSize !== undefined &&
        requestedContextSize.value <= PHISON_KM_CONTEXT_FLOOR &&
        preset.contextSize > requestedContextSize.value
      ) {
        requestedContextSize.value = preset.contextSize
        contextSize.value = preset.contextSize
      }

      // Load temperature, plus the model recommendation it came from (if any) so
      // applyModelInferenceDefaults can still tell an adopted value from a
      // deliberate one after a restart.
      if (savedSettings.temperature !== undefined) {
        temperature.value = savedSettings.temperature as number
      } else if (preset.temperature !== undefined) {
        temperature.value = preset.temperature
      }
      temperatureFromModel.value = savedSettings.temperatureFromModel as number | undefined

      // Load reasoning effort (only meaningful for models that recommend one).
      // A level we no longer offer is dropped rather than restored: a template
      // that does not know it aborts the whole turn, so a stale saved value
      // would otherwise poison the preset for good.
      reasoningEffort.value = knownReasoningEffort(savedSettings.reasoningEffort)
      reasoningEffortFromModel.value = knownReasoningEffort(savedSettings.reasoningEffortFromModel)

      // Load system prompt (only when user can modify it)
      if (isSystemPromptVisible.value && savedSettings.systemPrompt !== undefined) {
        console.log('Loading system prompt from saved settings', savedSettings.systemPrompt)
        systemPrompt.value = savedSettings.systemPrompt as string
      } else if (preset.systemPrompt) {
        console.log('Loading system prompt from preset', preset.systemPrompt)
        systemPrompt.value = preset.systemPrompt
      } else {
        console.log('Loading system prompt from default', defaultSystemPrompt)
        systemPrompt.value = defaultSystemPrompt
      }

      // Load metrics enabled
      if (savedSettings.metricsEnabled !== undefined) {
        metricsEnabled.value = savedSettings.metricsEnabled as boolean
      } else {
        // Set default value when no saved value exists
        metricsEnabled.value = false
      }

      // Load tools enabled — always honour savedSettings when present and fall
      // back to the preset default. The toggle's *visibility* is a UI concern
      // (preset opt-in + model capability) and must not clobber the persisted
      // value, particularly during the brief startup window where
      // `modelSupportsToolCalling` reports false until models hydrate.
      const defaultToolsEnabled = getDefaultToolsEnabled(preset)
      aipgToolsEnabled.value =
        (savedSettings.aipgToolsEnabled as boolean | undefined) ?? defaultToolsEnabled
      mcpToolsEnabled.value =
        (savedSettings.mcpToolsEnabled as boolean | undefined) ?? defaultToolsEnabled
      toolDelegationEnabled.value =
        (savedSettings.toolDelegationEnabled as boolean | undefined) ?? true

      // Which built-in tools this preset may use (empty when unsaved, so
      // isBuiltinToolEnabled falls back to its per-tool defaults).
      builtinToolEnablement.value = toolEnablementForPreset(
        savedSettings.builtinToolEnablement,
        legacyToolEnablement.value,
      )

      speakReplies.value =
        (savedSettings.speakReplies as boolean | undefined) ?? defaultSpeakReplies(preset.name)

      // Per-workflow enablement for preset-backed tools (defaults to all-enabled
      // when unsaved, matching isWorkflowPresetEnabled's default).
      builtinToolPresetEnablement.value =
        (savedSettings.builtinToolPresetEnablement as Record<string, boolean> | undefined) ?? {}

      // Per-slot default preset choices (empty when unsaved; getDefaultWorkflow
      // then falls back to the first available preset for each slot).
      builtinToolDefaultPresets.value =
        (savedSettings.builtinToolDefaultPresets as Record<string, string> | undefined) ?? {}

      // Load thinking-enabled (defaults to true when unsaved; only takes effect for
      // models that support the toggle via modelSupportsThinkingToggle).
      thinkingEnabled.value = (savedSettings.thinkingEnabled as boolean | undefined) ?? true

      numAssistantTokens.value = normalizeNumAssistantTokens(savedSettings.numAssistantTokens)

      // Load retrieval mode. Persisted choice wins, else the preset's declared
      // default (aiDAPTIV™ ships `phisonKm`), else standard. Clamp to standard
      // when the preset doesn't advertise KM support — the toggle is what
      // changes the mode, including on the Phison preset.
      const savedRagMode = savedSettings.ragMode as 'standard' | 'phisonKm' | undefined
      const resolvedRagMode = savedRagMode ?? preset.defaultRagMode ?? 'standard'
      ragMode.value = preset.supportsPhisonKmRag === true ? resolvedRagMode : 'standard'
      console.log(
        `[textInference] loadSettingsForActivePreset: preset="${preset.name}" ` +
          `requiresPhison=${preset.requiresPhison} supportsPhisonKmRag=${preset.supportsPhisonKmRag} ` +
          `savedRagMode=${savedRagMode} resolvedRagMode=${resolvedRagMode} ` +
          `ragMode=${ragMode.value}`,
      )
      // Restore whatever stash was persisted for this preset (may be null — e.g. this
      // preset was never switched into KM mode, or was last saved in standard mode).
      stashedStandardContextSize.value =
        (savedSettings.stashedStandardContextSize as number | null | undefined) ?? null

      // Apply both contextSize bounds explicitly here, rather than relying on the clamp
      // watcher in phisonKmRag.ts: that watcher deliberately sits out preset loads
      // (it would otherwise evaluate the incoming value against the *outgoing* preset's
      // ragMode, since contextSize is written above but ragMode only just now), and it
      // only fires on a change anyway — so a persisted/preset value already outside the
      // bounds would survive the load untouched. By this point ragMode and the stash are
      // resolved, so enforceKmContextFloor reflects the INCOMING preset.
      const contextCeiling = maxContextSizeFromModel.value
      const contextFloor = enforceKmContextFloor.value ? PHISON_KM_CONTEXT_FLOOR : undefined

      if (contextFloor !== undefined && contextSize.value < contextFloor) {
        // Needs a fresh bump this load. Don't overwrite a stash we just restored from a
        // previous session (that one is the "true" pre-KM value) — only stash the
        // current value if there wasn't already one to preserve.
        if (stashedStandardContextSize.value === null) {
          stashedStandardContextSize.value = contextSize.value
        }
      } else if (contextFloor === undefined) {
        // The floor doesn't apply this load (standard mode, or KM unavailable for this
        // preset/model) — any restored stash has nothing to pair with, so drop it
        // rather than risk restoring a stale value on some future mode switch.
        stashedStandardContextSize.value = null
      }
      // Otherwise: the floor applies and contextSize already satisfies it (>= 16 384) —
      // keep the restored stash (or null) exactly as loaded; nothing to reconcile.

      // kmContextFloorReachable gates enforceKmContextFloor, so floor <= ceiling
      // whenever both bounds are present. Cloud Mode is exempt: contextSize is the
      // size we ask a local backend to allocate and is never sent to a provider.
      // From the requested size, not the bounded one already in `contextSize`: this
      // load may be arriving at a model with a *larger* ceiling than the one that last
      // bounded it, and re-clamping the previous result would never let it grow back.
      let boundedContextSize = requestedContextSize.value
      if (backend.value !== 'cloud') {
        if (contextCeiling !== undefined) {
          boundedContextSize = Math.min(boundedContextSize, contextCeiling)
        }
        if (contextFloor !== undefined) {
          boundedContextSize = Math.max(boundedContextSize, contextFloor)
        }
        if (boundedContextSize !== contextSize.value) {
          contextSizeAdjust(boundedContextSize)
        }
      }

      // The preset may have arrived without a temperature (or without one the
      // user chose), so fill in what the active model recommends. The model
      // itself did not change here, so the watcher would not fire.
      applyModelInferenceDefaults()

      // Defer clearing the flag so the persistence watcher (default flush:
      // 'pre') sees `isLoadingSettings === true` when it runs for the writes
      // above. Otherwise it would re-save the freshly-loaded values and
      // potentially clobber persisted state with bootstrapping defaults.
      nextTick(() => {
        isLoadingSettings = false
      })
    }

    // Reset settings for active preset to defaults
    function resetActivePresetSettings() {
      if (!activePreset.value) return

      const settingsKey = getSettingsKey()
      if (settingsKey) {
        settingsPerPreset.value[settingsKey] = {}
      }

      // Reload settings (which will use preset defaults)
      loadSettingsForActivePreset()
    }

    // ========================================================================
    // Per-thread preset stamping & reactivation
    // ========================================================================

    /**
     * Resolve the chat preset (+ variant) that should drive inference for a
     * given conversation. Home Agent threads are always pinned to the bundled
     * Home Agent preset; main threads mirror the live sidebar selection.
     */
    function resolvePresetForConversation(
      conversationKey: string,
    ): { presetName: string; variant: string | null } | null {
      const kind = conversations.getThreadKind(conversationKey)
      if (kind === 'homeAgent') {
        const meta = conversations.getThreadMeta(conversationKey)
        return {
          presetName: HOME_AGENT_CHAT_PRESET_NAME,
          variant: meta?.variant ?? null,
        }
      }
      const presetName = presetsStore.activePresetName
      if (!presetName) return null
      return {
        presetName,
        variant: presetsStore.activeVariantName[presetName] ?? null,
      }
    }

    /**
     * Direct-apply preset reactivation: switch globals (active preset, variant,
     * settings) without going through `presetSwitching` so simple history
     * clicks don't trigger memory-alert dialogs.
     *
     * No-op when target already matches current globals.
     */
    function applyPresetToGlobals(presetName: string, variant: string | null): void {
      const target = presetsStore.presets.find((p) => p.name === presetName)
      if (!target) {
        console.warn(`applyPresetToGlobals: preset "${presetName}" not found, ignoring`)
        return
      }

      const currentName = presetsStore.activePresetName
      const currentVariant = currentName
        ? (presetsStore.activeVariantName[currentName] ?? null)
        : null

      const sameName = currentName === presetName
      const sameVariant = (currentVariant ?? null) === (variant ?? null)
      if (sameName && sameVariant) return

      presetsStore.activePresetName = presetName
      if (variant !== undefined) {
        presetsStore.setActiveVariant(presetName, variant)
      }
      loadSettingsForActivePreset()
    }

    /**
     * Stamp `conversationThreadMeta[conversationKey]` so the thread keeps a
     * record of which preset (+ variant) drove its most recent inference.
     * Called from generate/regenerate before running inference.
     *
     * For Home Agent threads this also enforces routing to the bundled preset
     * regardless of what the desktop sidebar happened to show.
     */
    function stampMetaForConversation(conversationKey: string): void {
      const resolved = resolvePresetForConversation(conversationKey)
      if (!resolved) return
      const existingKind = conversations.getThreadMeta(conversationKey)?.kind
      conversations.setThreadMeta(conversationKey, {
        presetName: resolved.presetName,
        variant: resolved.variant,
        kind: existingKind ?? 'main',
      })
    }

    /**
     * Ensure the live sidebar/`textInference` refs match the meta (or kind)
     * of the target conversation, then return what was applied. Used by
     * `generate`/`regenerate` so the in-flight stream uses the thread's
     * preset, not whatever was last selected for an unrelated chat.
     */
    function ensureGlobalsMatchConversation(
      conversationKey: string,
    ): { presetName: string; variant: string | null } | null {
      const resolved = resolvePresetForConversation(conversationKey)
      if (!resolved) return null
      applyPresetToGlobals(resolved.presetName, resolved.variant)
      return resolved
    }

    // Track if we're currently loading settings to prevent watcher from saving during load
    let isLoadingSettings = false

    // Watch for setting changes and save them to settingsPerPreset
    // Note: Preset/variant changes are now handled by the orchestrator, not by watchers
    watch(
      [
        backend,
        selectedModels,
        selectedEmbeddingModels,
        maxTokens,
        contextSize,
        requestedContextSize,
        contextSizeEdited,
        temperature,
        reasoningEffort,
        systemPrompt,
        metricsEnabled,
        aipgToolsEnabled,
        mcpToolsEnabled,
        toolDelegationEnabled,
        builtinToolEnablement,
        speakReplies,
        builtinToolPresetEnablement,
        builtinToolDefaultPresets,
        thinkingEnabled,
        numAssistantTokens,
        ragMode,
        stashedStandardContextSize,
      ],
      () => {
        // Don't save if we're loading settings (prevents overwriting during preset switch)
        if (isLoadingSettings) return

        const settingsKey = getSettingsKey()
        // Allow saving when settingsKey exists (preset name is available)
        if (!settingsKey) return

        // Save settings to per-preset storage
        settingsPerPreset.value[settingsKey] = {
          ...settingsPerPreset.value[settingsKey],
          backend: backend.value,
          selectedModels: { ...selectedModels.value },
          selectedEmbeddingModels: { ...selectedEmbeddingModels.value },
          selectedDeviceId: getCurrentDeviceId(),
          selectedDeviceUuid: getCurrentDeviceUuid(),
          maxTokens: maxTokens.value,
          contextSize: contextSize.value,
          requestedContextSize: requestedContextSize.value,
          contextSizeEdited: contextSizeEdited.value,
          temperature: temperature.value,
          temperatureFromModel: temperatureFromModel.value,
          reasoningEffort: reasoningEffort.value,
          reasoningEffortFromModel: reasoningEffortFromModel.value,
          systemPrompt: systemPrompt.value,
          metricsEnabled: metricsEnabled.value,
          aipgToolsEnabled: aipgToolsEnabled.value,
          mcpToolsEnabled: mcpToolsEnabled.value,
          toolDelegationEnabled: toolDelegationEnabled.value,
          builtinToolEnablement: { ...builtinToolEnablement.value },
          speakReplies: speakReplies.value,
          builtinToolPresetEnablement: { ...builtinToolPresetEnablement.value },
          builtinToolDefaultPresets: { ...builtinToolDefaultPresets.value },
          thinkingEnabled: thinkingEnabled.value,
          numAssistantTokens: numAssistantTokens.value,
          ragMode: ragMode.value,
          // Persisted so switching back to standard RAG still restores the pre-KM
          // value after an app restart (see stashedStandardContextSize declaration).
          stashedStandardContextSize: stashedStandardContextSize.value,
        }
      },
      { deep: true },
    )

    // Watch for device changes to save per-preset
    watch(
      () => backendServices.info,
      () => {
        // Don't save if we're loading settings (prevents overwriting during preset switch)
        if (isLoadingSettings) return

        const settingsKey = getSettingsKey()
        if (!settingsKey) return

        const currentDeviceId = getCurrentDeviceId()
        if (currentDeviceId) {
          settingsPerPreset.value[settingsKey] = {
            ...settingsPerPreset.value[settingsKey],
            selectedDeviceId: currentDeviceId,
            selectedDeviceUuid: getCurrentDeviceUuid(),
          }
        }
      },
      { deep: true },
    )

    // ========================================================================
    // Revisit-a-thread → reactivate that thread's last stamped preset
    // ========================================================================
    //
    // When the user opens an existing conversation in the desktop UI, restore
    // the preset (+ variant) it was last used with so editing/sending keeps
    // matching that thread's profile until the user changes the picker again.
    // Empty/unstamped threads do NOT clobber the picker.
    //
    // Direct-apply path — does not go through the memory-alert dialog logic in
    // `presetSwitching` because reading old chat history shouldn't produce
    // blocking modals.
    watch(
      () => conversations.activeKey,
      (newKey) => {
        if (!newKey) return
        const meta = conversations.getThreadMeta(newKey)
        // Home Agent threads are always pinned to the bundled Home Agent preset,
        // even before they've been stamped, so opening one switches the picker.
        if (conversations.getThreadKind(newKey) === 'homeAgent') {
          applyPresetToGlobals(HOME_AGENT_CHAT_PRESET_NAME, meta?.variant ?? null)
          return
        }
        if (!meta?.presetName) return
        const exists = presetsStore.presets.some((p) => p.name === meta.presetName)
        if (!exists) {
          // Preset removed since last use — leave the sidebar untouched and let
          // the next outbound generate stamp meta from current globals.
          return
        }
        applyPresetToGlobals(meta.presetName, meta.variant ?? null)
      },
      // `immediate: true` ensures the restored thread (set during conversations
      // store setup) gets its preset applied on startup — otherwise the very
      // first turn after launching the app uses whatever picker state was
      // persisted regardless of which thread the user resumes.
      { flush: 'post', immediate: true },
    )

    // Mirror the active conversation's RAG selection into the shared library's
    // live `isChecked` flags whenever the active conversation changes. A new /
    // empty conversation has no stored selection, so it starts with no enabled
    // RAG documents; switching back to a thread restores its selection. Home
    // Agent turns set `activeKey` to the remote thread before generating, so
    // this works uniformly for remote threads too. `immediate: true` restores
    // the resumed thread's selection on startup.
    watch(() => conversations.activeKey, syncRagSelectionForActiveKey, {
      flush: 'post',
      immediate: true,
    })

    // Initialize with first chat preset if available and no preset is selected
    // Note: We call loadSettingsForActivePreset() directly here instead of using
    // presetSwitching.switchPreset() because the watcher is synchronous.

    let initialSettingsLoaded = false

    // Initialize chat preset settings on startup.
    // `activePresetName` must resolve to a *chat-type* preset here — either a Chat
    // one or an Audio one (TTS / STT), whose mode `alignModeToActivePreset` then
    // follows. It may not:
    //   1. First launch: activePresetName is null.
    //   2. Subsequent launches: the persisted activePresetName can point at a
    //      non-chat preset (e.g. an image preset left active after the last
    //      image-gen session, or a picker-excluded one like Home Agent).
    // In both cases, reconcile it to the last-used chat preset (falling back to
    // the highest-priority one). Without this, Chat Settings' PresetSelector —
    // which filters to chat presets — can't find the active preset and renders
    // blank, even though the status bar shows the right preset via its own
    // last-used fallback. Keeping the two in sync is the whole point here.
    // Note: We set activePresetName / call loadSettingsForActivePreset() directly
    // instead of presetSwitching.switchPreset() because the watcher is synchronous.
    watch(
      () => presetsStore.selectableChatTypePresets,
      (chatTypePresets) => {
        if (chatTypePresets.length > 0 && !initialSettingsLoaded) {
          const activeIsChatTypePreset =
            presetsStore.activePresetName != null &&
            chatTypePresets.some((p) => p.name === presetsStore.activePresetName)

          if (!activeIsChatTypePreset) {
            // Only the Chat mode's own presets are candidates for the fallback: a
            // launch with nothing usable persisted belongs in Chat, not in Audio.
            const chatPresets = presetsStore.chatPresets
            const lastUsed = presetsStore.getLastUsedPreset(['chat'])
            const fallback =
              (lastUsed ? chatPresets.find((p) => p.name === lastUsed) : undefined) ??
              [...chatPresets].sort(
                (a, b) => (b.displayPriority || 0) - (a.displayPriority || 0),
              )[0]
            if (!fallback) return
            presetsStore.activePresetName = fallback.name
          }

          // Load settings for the (now guaranteed chat-type) active preset
          loadSettingsForActivePreset()
          initialSettingsLoaded = true
        }
      },
      { immediate: true },
    )

    return {
      backend,
      activeModel,
      selectedModels,
      loadedInferenceProfile,
      applyInferenceProfile,
      llmModels,
      llmEmbeddingModels,
      embeddingBackend,
      activeEmbeddingModel,
      currentBackendUrl,
      localBackendUrl,
      metricsEnabled,
      aipgToolsEnabled,
      mcpToolsEnabled,
      toolDelegationEnabled,
      builtinToolEnablement,
      isBuiltinToolEnabled,
      setBuiltinToolEnabled,
      speakReplies,
      speakRepliesAllowed,
      builtinToolPresetEnablement,
      isWorkflowPresetEnabled,
      setWorkflowPresetEnabled,
      builtinToolDefaultPresets,
      getDefaultWorkflow,
      setDefaultWorkflow,
      screenshotWindow,
      maxTokens,
      contextSize,
      // Returned so the persist `pick` list can see it — Pinia only persists what setup() returns.
      requestedContextSize,
      markContextSizeEdited,
      maxContextSizeFromModel,
      effectiveContextWindow,
      effectiveMaxTokens,
      temperature,
      fontSizeClass,
      nameSizeClass,
      iconSizeClass,
      isMaxSize,
      isMinSize,
      ragList,
      ragMode,
      phisonSsdPresent,
      kmContextFloorReachable,
      phisonKmAvailable,
      isPhisonKmRag,
      enforceKmContextFloor,
      contextSizeSettingSupported,
      contextSizeIsDynamic,
      systemPrompt,
      selectModel,
      selectEmbeddingModel,
      clearSelectionOfModel,
      getDownloadParamsForCurrentModelIfRequired,
      toggleMetrics,
      increaseFontSize,
      decreaseFontSize,
      addDocumentToRagList,
      embedInputUsingRag,
      updateFileCheckStatus,
      deleteFile,
      checkAllFiles,
      uncheckAllFiles,
      deleteAllFiles,
      formatRagSources,
      ensureBackendReadiness,
      checkModelAvailability,

      // NPU support
      runningOnOpenvinoNpu,

      // Preset management
      activePreset,
      resetActivePresetSettings,
      settingsPerPreset,
      loadSettingsForActivePreset,
      // Per-thread stamping & reactivation
      resolvePresetForConversation,
      stampMetaForConversation,
      ensureGlobalsMatchConversation,
      applyPresetToGlobals,
      pauseChatBackendSelectionMemory,

      // Tool calling support
      modelSupportsToolCalling,
      presetRequiresToolCalling,

      // Vision support
      modelSupportsVision,

      // Device the active backend is set to
      getCurrentDeviceId,
      getCurrentDeviceName,
      getDeviceNameForBackend,

      // Thinking toggle support
      thinkingEnabled,
      modelSupportsThinkingToggle,

      // MTP draft length (OpenVINO speculative decoding)
      numAssistantTokens,
      modelSupportsMtp,

      // Per-model recommended inference settings (models.json inferenceDefaults)
      thinkingActive,
      recommendedSampling,
      samplingRequestBody,
      reasoningEffort,
      modelSupportsReasoningEffort,
      effectiveReasoningEffort,

      // Backend preparation state and methods
      isPreparingBackend: computed(() => backendReadinessState.isPreparingBackend),
      needsBackendPreparation,
      preparationReason,
      preparationMessage,
      startBackendPreparation,
      completeBackendPreparation,
      updateLastUsedConfig,
      prepareBackendIfNeeded,
      ensureReadyForInference,

      // RAG state
      willUseRag,

      // Home Agent
      homeAgentUpstreamUrl,

      // In-flight inference stream tracking (used by image tools to avoid
      // resetting an open chat-backend socket when freeing the GPU)
      migrateRenamedPresetSettings,
      migrateGlobalToolEnablement,
      init,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: [
        'backend',
        'selectedModels',
        'maxTokens',
        'contextSize',
        'requestedContextSize',
        'temperature',
        // `settingsPerPreset` and `ragList` are NOT persisted here anymore:
        // per-preset settings live in the kernel-owned preferences.json and
        // the RAG document list in rag/documents.json (step 8 §6.1), both
        // hydrated by init().
        'screenshotWindow',
      ],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTextInference, import.meta.hot))
}
