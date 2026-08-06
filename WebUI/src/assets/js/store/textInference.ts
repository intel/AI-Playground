import { acceptHMRUpdate, defineStore } from 'pinia'
import { z } from 'zod'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices, type BackendServiceName } from './backendServices'
import { useModels } from './models'
import { Document } from '@langchain/classic/document'
import { llmBackendTypes } from '@/types/shared'
import { useDialogStore } from '@/assets/js/store/dialogs.ts'
import { usePresets, type ChatPreset } from './presets'
import { useDeveloperSettings } from './developerSettings'
import { useHomeAgent } from './homeAgent'
import { useCloudMode, CLOUD_DEFAULT_MODEL } from './cloudMode'
import { useConversations, HOME_AGENT_CHAT_PRESET_NAME } from './conversations'
import * as toast from '@/assets/js/toast.ts'
import { useActivities } from './activities'
import { useI18N } from './i18n'

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

export type LlmModel = {
  name: string
  mmproj?: string
  type: LlmBackend
  active: boolean
  downloaded: boolean
  supportsToolCalling?: boolean
  supportsVision?: boolean
  supportsReasoning?: boolean
  supportsThinkingToggle?: boolean
  maxContextSize?: number
  npuSupport?: boolean
  largeMoe?: boolean
  isPredefined?: boolean
}

export type ValidFileExtension = 'txt' | 'doc' | 'docx' | 'md' | 'pdf'

export type IndexedDocument = {
  filename: string
  filepath: string
  type: ValidFileExtension
  splitDB: Document[]
  hash: string
  isChecked: boolean
}

export type EmbedInquiry = {
  prompt: string
  ragList: IndexedDocument[]
  backendBaseUrl: string
  embeddingModel: string
  maxResults?: number
}

// Thinking model markers for different models
export const thinkingModels: Record<string, string> = {
  'bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF/DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_S.gguf':
    '</think>\n\n',
  'bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF/DeepSeek-R1-Distill-Qwen-7B-Q4_K_S.gguf':
    '</think>\n\n',
  'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B': '</think>\n\n',
  'deepseek-ai/DeepSeek-R1-Distill-Qwen-14B': '</think>\n\n',
  'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B': '</think>\n\n',
  'OpenVINO/DeepSeek-R1-Distill-Qwen-1.5B-int4-ov': '</think>\n\n',
  'OpenVINO/DeepSeek-R1-Distill-Qwen-7B-int4-ov': '</think>\n\n',
  'OpenVINO/DeepSeek-R1-Distill-Qwen-14B-int4-ov': '</think>\n\n',
  'OpenVINO/DeepSeek-R1-Distill-Qwen-7B-int4-cw-ov': '</think>\n\n',
  'OpenVINO/DeepSeek-R1-Distill-Qwen-1.5B-int4-cw-ov': '</think>\n\n',
  'OpenVINO/DeepSeek-R1-Distill-Qwen-1.5B-int4-gq-ov': '</think>\n\n',
  'OpenVINO/DeepSeek-R1-Distill-Qwen-7B-nf4-ov': '</think>\n\n',
  'OpenVINO/Qwen3-8B-int4-cw-ov': '</think>\n\n',
  'OpenVINO/Qwen3-8B-int4-ov': '</think>\n\n',
  'unsloth/gpt-oss-20b-GGUF/gpt-oss-20b-Q8_0.gguf': '<|start|>assistant<|channel|>final<|message|>',
  'OpenVINO/gpt-oss-20b-int4-ov': '<|start|>assistant<|channel|>final<|message|>',
}

// A friendly display name for each backend
export const textInferenceBackendDisplayName: Record<LlmBackend, string> = {
  llamaCPP: 'llamaCPP - GGUF',
  openVINO: 'OpenVINO',
  cloud: 'Cloud Mode',
}

export const textInferenceBackendDescription: Record<LlmBackend, string> = {
  llamaCPP:
    'Utilizes Llama.cpp for lightweight and portable AI solutions. Ideal for low-resource environments.',
  openVINO:
    'Optimized for Intel hardware with OpenVINO framework. Provides efficient and fast AI processing.',
  cloud:
    'Connects to a remote OpenAI-compatible provider. Use a hosted or cloud model as if it were local.',
}

export const textInferenceBackendTags: Record<LlmBackend, string[]> = {
  llamaCPP: ['Lightweight', 'Portable'],
  openVINO: ['Intel', 'Optimized', 'Fast'],
  cloud: ['Remote', 'OpenAI-compatible'],
}

export const useTextInference = defineStore(
  'textInference',
  () => {
    const backendServices = useBackendServices()
    const dialogStore = useDialogStore()
    const models = useModels()
    const presetsStore = usePresets()
    const developerSettings = useDeveloperSettings()
    const homeAgent = useHomeAgent()
    const cloudMode = useCloudMode()
    const conversations = useConversations()
    const activities = useActivities()
    const i18nState = useI18N().state
    // Tracks the in-flight backend-preparation activity (begin/end are paired with
    // start/completeBackendPreparation).
    let backendPrepActivityId: string | null = null
    const backend = ref<LlmBackend>('llamaCPP')
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

      const newModels = llmTypeModels.map((m) => {
        const selectedModelForType = selectedModels.value[m.type as LlmBackend]
        const hasValidSelection = llmTypeModels.some((model) => model.name === selectedModelForType)
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
          supportsThinkingToggle: m.supportsThinkingToggle,
          maxContextSize: m.maxContextSize,
          npuSupport: m.npuSupport,
          largeMoe: m.largeMoe,
          isPredefined: m.isPredefined,
        }
      })

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
            supportsThinkingToggle: false,
            maxContextSize: undefined,
            npuSupport: undefined,
            largeMoe: undefined,
            isPredefined: false,
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

      const newEmbeddingModels = llmEmbeddingTypeModels.map((m) => {
        const selectedEmbeddingModelForType = selectedEmbeddingModels.value[m.backend as LlmBackend]
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
      })

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

    // Get the currently selected device ID for the active backend
    const getCurrentDeviceId = (): string | null => {
      const serviceName = backendToService[backend.value] as BackendServiceName
      const serviceInfo = backendServices.info.find((s) => s.serviceName === serviceName)
      return serviceInfo?.devices.find((d) => d.selected)?.id ?? null
    }

    // Stable UUID of the currently selected device, when the backend exposes one.
    // Persisted alongside the id so a preset re-binds to the same physical device
    // even if its backend-local id shifts (driver update / enumeration reorder).
    const getCurrentDeviceUuid = (): string | null => {
      const serviceName = backendToService[backend.value] as BackendServiceName
      const serviceInfo = backendServices.info.find((s) => s.serviceName === serviceName)
      return serviceInfo?.devices.find((d) => d.selected)?.uuid ?? null
    }

    const backendToAipgBackendName = {
      openVINO: 'openvino',
      llamaCPP: 'llama_cpp',
    } as const

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
    const mcpToolsEnabled = ref(true)
    // Whether the model should think before answering. Only meaningful for models
    // whose template honors `enable_thinking` (see modelSupportsThinkingToggle);
    // the value is injected as chat_template_kwargs.enable_thinking at inference.
    const thinkingEnabled = ref(true)

    // Per-built-in-tool enablement overrides (by tool name). Most built-in tools
    // default on; opt-in/privacy-sensitive tools (captureScreenshot) default off.
    const builtinToolEnablement = ref<Record<string, boolean>>({})
    // The single desktop window captureScreenshot is bound to. The screenshot
    // tool can only ever capture this user-selected window.
    const screenshotWindow = ref<ScreenshotWindow | null>(null)

    function isBuiltinToolEnabled(toolName: string): boolean {
      const override = builtinToolEnablement.value[toolName]
      if (override !== undefined) return override
      return toolName === 'captureScreenshot' ? false : true
    }

    function setBuiltinToolEnabled(toolName: string, enabled: boolean): void {
      builtinToolEnablement.value = { ...builtinToolEnablement.value, [toolName]: enabled }
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
    const contextSize = ref<number>(8192)
    const temperature = ref<number>(0.7)

    // Get max context size from current model
    const maxContextSizeFromModel = computed(() => {
      const currentModel = llmModels.value
        .filter((m) => m.type === backend.value)
        .find((m) => m.active)
      return currentModel?.maxContextSize
    })

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

    // Enforce maxContextSize as hard limit when contextSize changes
    watch(
      () => contextSize.value,
      (newValue) => {
        if (maxContextSizeFromModel.value && newValue > maxContextSizeFromModel.value) {
          contextSize.value = maxContextSizeFromModel.value
        }
      },
    )

    // Per-preset settings persistence
    const settingsPerPreset = ref<Record<string, Record<string, unknown>>>({})

    // Number of inference HTTP requests currently streaming from the chat
    // backend. Maintained by the chat transport's custom fetch (see
    // openAiCompatibleChat): incremented when a request starts, decremented when
    // its response body finishes (completes, is cancelled, or errors). Image
    // tools consult this via waitForInferenceIdle() so they never tear down the
    // chat backend while a stream to it is still open (which would reset the
    // socket mid-stream and surface as a "network error").
    const activeInferenceStreams = ref(0)
    function beginInferenceStream() {
      activeInferenceStreams.value++
    }
    function endInferenceStream() {
      if (activeInferenceStreams.value > 0) activeInferenceStreams.value--
    }
    // Resolve once no inference stream is open, or after `timeoutMs` as a
    // safety valve so a wedged/keep-alive socket can't block image generation
    // indefinitely. In the common case the stream is already drained (the SDK
    // finishes each step before running a tool), so this returns immediately.
    async function waitForInferenceIdle(timeoutMs = 3000): Promise<void> {
      const start = Date.now()
      while (activeInferenceStreams.value > 0) {
        if (Date.now() - start >= timeoutMs) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }

    const currentBackendUrl = computed(() => {
      // Cloud Mode talks to the main-process loopback proxy (see cloudProxy.ts),
      // which forwards to the selected remote provider. Networking + error logging
      // happen in Node, not the renderer.
      if (backend.value === 'cloud') {
        return cloudMode.proxyUrl || undefined
      }
      if (homeAgent.isHomeAgentActive && homeAgent.homeAgentBaseUrl) {
        return homeAgent.homeAgentBaseUrl
      }
      return backendServices.info.find(
        (item) => item.serviceName === backendToService[backend.value],
      )?.baseUrl
    })

    // When Home Agent is active, the real inference backend URL to proxy through
    const homeAgentUpstreamUrl = computed(() => {
      if (!homeAgent.isHomeAgentActive) return undefined
      return backendServices.info.find(
        (item) => item.serviceName === backendToService[backend.value],
      )?.baseUrl
    })

    async function getDownloadParamsForCurrentModelIfRequired(type: 'llm' | 'embedding') {
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
      if (type === 'llm' && modelMetaData?.mmproj) {
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
      const langchainDocument: IndexedDocument =
        await window.electronAPI.addDocumentToRAGList(document)
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
    }

    async function embedInputUsingRag(prompt: string) {
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
      if (!embeddingUrlResult.success || !embeddingUrlResult.url) {
        throw new Error(
          embeddingUrlResult.error ||
            'Embedding server not available. Please ensure the embedding model is loaded.',
        )
      }
      const backendBaseUrl = embeddingUrlResult.url

      const newEmbedInquiry: EmbedInquiry = {
        prompt: prompt,
        ragList: checkedRagList,
        backendBaseUrl: backendBaseUrl,
        embeddingModel: activeEmbeddingModel.value,
        maxResults: runningOnOpenvinoNpu.value ? 2 : 8,
      }
      console.log('trying to request rag for', { newEmbedInquiry, ragList: ragList.value })
      const response = await window.electronAPI.embedInputUsingRag(newEmbedInquiry)
      return response
    }

    // RAG state for UI display
    const ragRetrievalState = reactive({
      inProgress: false,
      lastResults: null as Document[] | null,
    })

    /**
     * Prepares RAG context for a prompt and returns enhanced system prompt
     * @param prompt The user's prompt/question
     * @returns Object containing enhanced system prompt and RAG results (if any)
     */
    async function prepareRagContext(prompt: string): Promise<{
      systemPrompt: string
      ragResults: Document[] | null
      ragSourceText: string | null
    }> {
      if (!willUseRag.value) {
        return {
          systemPrompt: systemPrompt.value,
          ragResults: null,
          ragSourceText: null,
        }
      }

      const ragActivityId = activities.begin({
        category: 'rag',
        label: i18nState.COM_ACTIVITY_SEARCHING_DOCS,
        scope: { kind: 'chat', conversationKey: conversations.activeKey },
      })
      try {
        ragRetrievalState.inProgress = true

        // Embeddings always run on a LOCAL embedding server (see embeddingBackend),
        // even in Cloud Mode. Ensure a model is selected and the server is up
        // before attempting retrieval, skipping RAG gracefully otherwise.
        {
          const serviceName = backendToService[embeddingBackend.value]
          if (!activeEmbeddingModel.value) {
            console.warn('No embedding model selected for RAG, skipping RAG retrieval')
            ragRetrievalState.inProgress = false
            activities.end(ragActivityId)
            return {
              systemPrompt: systemPrompt.value,
              ragResults: null,
              ragSourceText: null,
            }
          }

          // Verify embedding server is available
          const embeddingUrlResult = await window.electronAPI.getEmbeddingServerUrl(serviceName)
          if (!embeddingUrlResult.success || !embeddingUrlResult.url) {
            console.warn(
              'Embedding server not ready, skipping RAG retrieval:',
              embeddingUrlResult.error || 'Unknown error',
            )
            ragRetrievalState.inProgress = false
            activities.end(ragActivityId)
            return {
              systemPrompt: systemPrompt.value,
              ragResults: null,
              ragSourceText: null,
            }
          }
        }

        // Perform RAG retrieval
        const ragResults = await embedInputUsingRag(prompt)
        console.log('textInference.ts: prepareRagContext: ragResults', ragResults)
        ragRetrievalState.lastResults = ragResults

        ragRetrievalState.inProgress = false
        activities.end(ragActivityId)

        if (ragResults && ragResults.length > 0) {
          // Build RAG context from retrieved documents
          const ragContext = ragResults.map((doc) => doc.pageContent).join('\n\n')

          // Enhance system prompt with RAG context
          const enhancedSystemPrompt = `${systemPrompt.value}\n\nUse the following context from your knowledge base to answer the question:\n\n${ragContext}`

          // Format RAG sources for display
          const ragSourceText = formatRagSources(ragResults)

          return {
            systemPrompt: enhancedSystemPrompt,
            ragResults,
            ragSourceText: ragSourceText,
          }
        }

        return {
          systemPrompt: systemPrompt.value,
          ragResults: null,
          ragSourceText: null,
        }
      } catch (error) {
        console.error('Error retrieving RAG documents:', error)
        ragRetrievalState.inProgress = false
        activities.end(ragActivityId, 'failed')
        // Return base system prompt on error - generation can continue without RAG
        return {
          systemPrompt: systemPrompt.value,
          ragResults: null,
          ragSourceText: null,
        }
      }
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

    // Define a type for document location information
    type DocumentLocation = {
      pageNumber?: number
      lines?: {
        from?: number
        to?: number
      }
    }

    // Format RAG sources for display
    function formatRagSources(
      documents: Document[] | { metadata?: { source?: string; loc?: DocumentLocation } }[],
    ): string {
      // Group documents by source file
      const fileGroups = new Map<
        string,
        Array<{
          lines?: { from: number; to: number }
          page?: number
        }>
      >()
      const unknownSources: string[] = []

      // Process each document
      documents.forEach((doc) => {
        const source = doc.metadata?.source
        const location = doc.metadata?.loc

        // Handle unknown sources
        if (!source) {
          unknownSources.push('Unknown Source')
          return
        }

        // Get or create array for this file
        const entries = fileGroups.get(source) || []

        // Create entry with available location information
        const entry: { lines?: { from: number; to: number }; page?: number } = {}

        // Add line information if available
        if (location?.lines?.from && location?.lines?.to) {
          entry.lines = {
            from: location.lines.from,
            to: location.lines.to,
          }
        }

        // Add page information if available
        if (location?.pageNumber !== undefined) {
          entry.page = location.pageNumber
        }

        // Only add entry if it has some location information
        if (Object.keys(entry).length > 0) {
          entries.push(entry)
          fileGroups.set(source, entries)
        }
      })

      // Function to merge overlapping line ranges for the same page
      const mergeRanges = (
        entries: Array<{ lines?: { from: number; to: number }; page?: number }>,
      ): Array<{ lines?: { from: number; to: number }; page?: number }> => {
        if (entries.length <= 1) return entries

        // Group entries by page number
        const pageGroups = new Map<
          number | undefined,
          Array<{ lines?: { from: number; to: number }; page?: number }>
        >()

        entries.forEach((entry) => {
          const pageKey = entry.page
          const pageEntries = pageGroups.get(pageKey) || []
          pageEntries.push(entry)
          pageGroups.set(pageKey, pageEntries)
        })

        const result: Array<{ lines?: { from: number; to: number }; page?: number }> = []

        // Process each page group
        pageGroups.forEach((pageEntries, pageNumber) => {
          // For entries with line information, merge overlapping ranges
          const entriesWithLines = pageEntries.filter((e) => e.lines)

          if (entriesWithLines.length > 0) {
            // Sort by starting line
            const sortedEntries = [...entriesWithLines].sort(
              (a, b) => (a.lines?.from || 0) - (b.lines?.from || 0),
            )

            let current = sortedEntries[0]

            // Merge overlapping line ranges
            for (let i = 1; i < sortedEntries.length; i++) {
              const next = sortedEntries[i]

              // Check if ranges overlap or are adjacent
              if ((current.lines?.to || 0) >= (next.lines?.from || 0) - 1) {
                // Merge ranges
                current = {
                  lines: {
                    from: current.lines?.from || 0,
                    to: Math.max(current.lines?.to || 0, next.lines?.to || 0),
                  },
                  page: pageNumber,
                }
              } else {
                // No overlap, add current to result and move to next
                result.push(current)
                current = next
              }
            }

            // Add the last range
            result.push(current)
          }

          // For entries with only page information (no lines), add a single entry per page
          if (pageEntries.some((e) => !e.lines)) {
            // If we haven't already added an entry for this page from the line merging
            if (!result.some((r) => r.page === pageNumber && !r.lines)) {
              result.push({ page: pageNumber })
            }
          }
        })

        return result
      }

      // Format results
      const formattedResults: string[] = []

      // Process each file group
      fileGroups.forEach((entries, source) => {
        const filename = source.split(/[\/\\]/).pop() || source
        const mergedEntries = mergeRanges(entries)

        // Format each merged entry
        mergedEntries.forEach((entry) => {
          let locationInfo = ''

          // Format based on available information
          if (entry.page !== undefined && entry.lines) {
            // Both page and line information
            locationInfo = `Page ${entry.page}, Lines ${entry.lines.from}-${entry.lines.to}`
          } else if (entry.page !== undefined) {
            // Only page information
            locationInfo = `Page ${entry.page}`
          } else if (entry.lines) {
            // Only line information
            locationInfo = `Lines ${entry.lines.from}-${entry.lines.to}`
          }

          formattedResults.push(`${filename} (${locationInfo})`)
        })
      })

      // Add unknown sources
      formattedResults.push(...unknownSources)

      return formattedResults.join('\n')
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

    async function ensureBackendReadiness(): Promise<void> {
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

        // Stop OVMS image server to free GPU memory before loading LLM
        if (!developerSettings.keepModelsLoaded) {
          try {
            await window.electronAPI.stopOvmsImageServer()
          } catch (_e) {
            // Ignore — server may not be running
          }
        }

        try {
          await backendServices.ensureBackendReadiness(
            serviceName,
            llmModelName,
            embeddingModelToSend,
            contextSize.value,
          )
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

    async function checkModelAvailability() {
      // ToDo: the path for embedding downloads must be corrected and BAAI/bge-large-zh-v1.5 was accidentally downloaded to the wrong place
      return new Promise<void>(async (resolve, reject) => {
        const requiredModelDownloads = await getDownloadParamsForCurrentModelIfRequired('llm')
        if (willUseRag.value) {
          const requiredEmbeddingModelDownloads =
            await getDownloadParamsForCurrentModelIfRequired('embedding')
          requiredModelDownloads.push(...requiredEmbeddingModelDownloads)
        }

        // Deduplicate download list by repo_id to prevent the same model from appearing multiple times
        const uniqueDownloads = requiredModelDownloads.filter(
          (download, index, self) =>
            index === self.findIndex((d) => d.repo_id === download.repo_id),
        )

        if (uniqueDownloads.length > 0) {
          // On a remote Home Agent turn there is nobody at the desktop to act on
          // the download modal; route the approval + progress to the channel
          // (mirrored into the desktop window) instead of getting stuck.
          if (homeAgent.isRemoteTurnActive()) {
            homeAgent.handleRemoteModelDownload(uniqueDownloads).then(resolve).catch(reject)
          } else {
            dialogStore.showDownloadDialog(uniqueDownloads, resolve, reject)
          }
        } else {
          resolve()
        }
      })
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
          'RAG needs a local embedding model. Install one to use documents with Cloud Mode.',
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

    async function prepareBackendIfNeeded() {
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
          await ensureBackendReadiness()
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

    async function ensureReadyForInference() {
      // Cloud Mode has no local backend to prepare, but the loopback proxy URL
      // must be resolved before the first request (it backs currentBackendUrl).
      if (backend.value === 'cloud') {
        await cloudMode.ensureProxyUrl()
      }
      await checkModelAvailability()
      await prepareBackendIfNeeded()
    }

    // ========================================================================
    // Chat Preset Management
    // ========================================================================

    const activePreset = computed(() => {
      if (!presetsStore.activePresetName) return null
      const preset = presetsStore.presets.find((p) => p.name === presetsStore.activePresetName)
      if (preset && preset.type === 'chat') return preset as ChatPreset
      return null
    })

    // Get setting key for current preset (includes variant if present)
    function getSettingsKey(): string {
      if (!activePreset.value?.name) return ''
      const variantName = presetsStore.activeVariantName[activePreset.value.name]
      return variantName ? `${activePreset.value.name}:${variantName}` : activePreset.value.name
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

      // Load context size
      if (savedSettings.contextSize !== undefined) {
        contextSize.value = savedSettings.contextSize as number
      } else if (preset.contextSize !== undefined) {
        contextSize.value = preset.contextSize
      }

      // Load temperature
      if (savedSettings.temperature !== undefined) {
        temperature.value = savedSettings.temperature as number
      } else if (preset.temperature !== undefined) {
        temperature.value = preset.temperature
      }

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
        temperature,
        systemPrompt,
        metricsEnabled,
        aipgToolsEnabled,
        mcpToolsEnabled,
        builtinToolPresetEnablement,
        builtinToolDefaultPresets,
        thinkingEnabled,
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
          temperature: temperature.value,
          systemPrompt: systemPrompt.value,
          metricsEnabled: metricsEnabled.value,
          aipgToolsEnabled: aipgToolsEnabled.value,
          mcpToolsEnabled: mcpToolsEnabled.value,
          builtinToolPresetEnablement: { ...builtinToolPresetEnablement.value },
          builtinToolDefaultPresets: { ...builtinToolDefaultPresets.value },
          thinkingEnabled: thinkingEnabled.value,
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
    // The app always boots into chat mode (the `prompt` store isn't persisted),
    // so `activePresetName` must resolve to a *chat* preset here. It may not:
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
      () => presetsStore.chatPresets,
      (chatPresets) => {
        if (chatPresets.length > 0 && !initialSettingsLoaded) {
          const activeIsChatPreset =
            presetsStore.activePresetName != null &&
            chatPresets.some((p) => p.name === presetsStore.activePresetName)

          if (!activeIsChatPreset) {
            const lastUsed = presetsStore.getLastUsedPreset(['chat'])
            const fallback =
              (lastUsed ? chatPresets.find((p) => p.name === lastUsed) : undefined) ??
              [...chatPresets].sort(
                (a, b) => (b.displayPriority || 0) - (a.displayPriority || 0),
              )[0]
            presetsStore.activePresetName = fallback.name
          }

          // Load settings for the (now guaranteed chat) active preset
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
      llmModels,
      llmEmbeddingModels,
      currentBackendUrl,
      metricsEnabled,
      aipgToolsEnabled,
      mcpToolsEnabled,
      builtinToolEnablement,
      isBuiltinToolEnabled,
      setBuiltinToolEnabled,
      builtinToolPresetEnablement,
      isWorkflowPresetEnabled,
      setWorkflowPresetEnabled,
      builtinToolDefaultPresets,
      getDefaultWorkflow,
      setDefaultWorkflow,
      screenshotWindow,
      maxTokens,
      contextSize,
      maxContextSizeFromModel,
      temperature,
      fontSizeClass,
      nameSizeClass,
      iconSizeClass,
      isMaxSize,
      isMinSize,
      ragList,
      contextSizeSettingSupported,
      contextSizeIsDynamic,
      systemPrompt,
      selectModel,
      selectEmbeddingModel,
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
      prepareRagContext,

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

      // Tool calling support
      modelSupportsToolCalling,
      presetRequiresToolCalling,

      // Vision support
      modelSupportsVision,

      // Thinking toggle support
      thinkingEnabled,
      modelSupportsThinkingToggle,

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
      ragRetrievalInProgress: computed(() => ragRetrievalState.inProgress),
      lastRagResults: computed(() => ragRetrievalState.lastResults),

      // Home Agent
      homeAgentUpstreamUrl,

      // In-flight inference stream tracking (used by image tools to avoid
      // resetting an open chat-backend socket when freeing the GPU)
      beginInferenceStream,
      endInferenceStream,
      waitForInferenceIdle,
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
        'temperature',
        'ragList',
        'settingsPerPreset',
        'builtinToolEnablement',
        'screenshotWindow',
      ],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTextInference, import.meta.hot))
}
