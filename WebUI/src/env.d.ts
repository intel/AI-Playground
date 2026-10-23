declare interface Window {
  __AIPG_DEMO_MODE__?: boolean
  chrome: Chrome
  electronAPI: electronAPI
  envVars: {
    platformTitle: string
    productVersion: string
    debugToolsEnabled: boolean
    /** Short commit this build came from; '' when it could not be determined. */
    gitCommit: string
    /** Release tag on that commit; '' when the build is not from a tag. */
    gitTag: string
  }
}

interface ImportMetaEnv {
  readonly VITE_PLATFORM_TITLE: string
  readonly VITE_DEBUG_TOOLS: 'true' | undefined
  readonly VITE_GIT_COMMIT: string | undefined
  readonly VITE_GIT_TAG: string | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

type ServiceSettings = {
  serviceName: BackendServiceName
  version?: string
  releaseTag?: string
  comfyUiParameters?: string
  llamaCppParameters?: string
  llamaCppBuildVariant?: 'standard' | 'ssd-offload'
  // OVMS --kv_cache_precision value ('u8' | 'u4' | 'f16' | 'fp32'); '' = OVMS default.
  ovmsKvCachePrecision?: string
}

type SamplePrompt = {
  title: string
  description: string
  prompt: string
  mode: ModeType
  presetName?: string
}

// A desktop window the screenshot tool can be bound to. Stored as id + name so
// capture can fall back to title matching when the (unstable) id is gone.
type ScreenshotWindow = {
  id: string
  name: string
}

type ScreenshotWindowSource = ScreenshotWindow & {
  thumbnailDataUrl: string | null
}

type DemoProfile = {
  defaults: {
    chatPreset: string
    chatModel: string
    imageGenPreset?: string
    imageEditPreset?: string
  }
  inputImage: string | null
  samplePrompts: SamplePrompt[]
  enabledModes: ModeType[]
  notificationDotButtons: string[]
}

type ProductMode = 'studio' | 'essentials' | 'nvidia'

/** Mirrors electron/main LocalSettingsSchema (renderer copy for IPC typing). */
type LocalSettings = {
  productMode?: ProductMode
  isDemoModeEnabled: boolean
  demoModeResetInSeconds: number | null
  demoModePasscode?: string
  isAgentPresetEnabled?: boolean
  /** Shows the machine-level debug controls in Settings → Developer. */
  showDebugSettingsInUI?: boolean
  oemVendorOverride?: string | null
  /** Components switched off in the setup wizard; not auto-started at launch. */
  disabledBackends?: string[]
  languageOverride: string | null
  remoteRepository: string
  huggingfaceEndpoint: string
  mcpAutoDetectionDismissed: string[]
  openvinoImageGenDevices: string[]
  preferredDevice: PreferredDevice | null
  /** Backend launch configuration (settings.json, step 8): version pins and
   * launch flags, formerly renderer-persisted Pinia state. null = default. */
  versionOverrides?: Record<string, { releaseTag?: string; version: string }>
  comfyUiParameters?: string | null
  llamaCppParameters?: string | null
  llamaCppBuildVariant?: 'standard' | 'ssd-offload'
  llamaCppOffloadDrive?: string | null
  openvinoKvCacheU4?: boolean
  /** Dev unpackaged: set via settings-dev.json / userData overlay. */
  PhisonSSDdetected?: boolean
  /** Linux: user accepted obfuscated-on-disk secrets when no OS keyring is available. */
  allowPlaintextSecretStorage?: boolean
}

/** Mirrors electron/observability/laminar LaminarConfigSchema (renderer copy for IPC typing). */
type LaminarConfig = {
  projectApiKey: string
  /** Scheme and host only — the SDK takes the ports separately. */
  baseUrl: string
  httpPort: number
  grpcPort: number
}

type DeviceCategory = 'dgpu' | 'igpu' | 'npu' | 'cpu' | 'unknown'

type GpuHardwareDevice = {
  device: string
  name: string
  gpuDeviceId: string | null
  /** Stable vendor UUID when the probe can supply one (NVIDIA via nvidia-smi,
   *  Intel via xpu-smi). null on the PowerShell/lspci fallbacks. Preferred over
   *  name for identifying a device across driver/enumeration changes. */
  uuid?: string | null
  category?: DeviceCategory
}

/** User's preferred inference device, chosen in the setup wizard. `uuid` is the
 *  stable identity (when known); `gpuDeviceId` is the weaker PCI model id. */
type PreferredDevice = {
  name: string
  gpuDeviceId: string | null
  uuid?: string | null
  /** Per-instance id from the hardware probe (`GpuHardwareDevice.device`).
   *  Disambiguates two identically-named GPUs in the wizard when no UUID is
   *  available (PowerShell/lspci fallback). */
  instanceId?: string
}

type ProductModeCatalogFeatureI18n = {
  labelKey: string
  detailKey: string
}

type ProductModeCatalogUiI18n = {
  titleOne: string
  titleTwo: string
  subtitle?: string
  description: string
  supportedHardware: string
  features?: ProductModeCatalogFeatureI18n[]
}

type ProductModeCatalogEntry = {
  mode: ProductMode
  experimental: boolean
  ui: { i18n: ProductModeCatalogUiI18n }
}

type HardwareRecommendationResult = {
  success: boolean
  recommendedMode: ProductMode
  detectedDevices: GpuHardwareDevice[]
  hasNvidiaGpu: boolean
  modeCatalog: ProductModeCatalogEntry[]
  error?: string
}

type DemoModeSettings = {
  isDemoModeEnabled: boolean
  demoModeResetInSeconds: null | number
  demoModePasscode?: string
  profile?: DemoProfile | null
}

type WebPageLink = {
  index: number
  text: string
  href: string
}

type WebPageSnapshot = {
  title: string
  url: string
  text: string
  links: WebPageLink[]
}

type WebBrowserState = {
  isOpen: boolean
  isVisible: boolean
  currentUrl: string
  title: string
}

type WebBrowserInteraction =
  | { action: 'click'; linkIndex?: number; selector?: string }
  | { action: 'scroll'; selector?: string }
  | { action: 'back' }

type WebSearchResult = {
  title: string
  url: string
  snippet: string
}

type WebSearchResults = {
  query: string
  results: WebSearchResult[]
}

type DemoModePage = 'chat' | 'imageGen' | 'imageEdit' | 'video'
type WorkflowModeType = 'imageGen' | 'imageEdit' | 'video'
// 'audio' hosts the speech presets (Text to Speech / Speech to Text). Like 'chat'
// it runs on chat-type presets and renders its turns in the Chat view, but it has
// its own preset category, picker and settings panel.
type ChatLikeModeType = 'chat' | 'audio'
type ModeType = ChatLikeModeType | 'agent' | WorkflowModeType

// Agent Mode (Pi coding agent) — see src/types/agentIpc.ts.
type AgentModeModelConfig = import('./types/agentIpc').AgentModeModelConfig
type AgentToolSpec = import('./types/agentIpc').AgentToolSpec
type AgentCapabilityInfo = import('./types/agentIpc').AgentCapabilityInfo
type AgentModeTurnConfig = import('./types/agentIpc').AgentModeTurnConfig

/** Streaming output of a running tool, keyed by the tool call it belongs to. */
type AgentToolProgress = {
  turnId: string
  toolCallId: string
  toolName: string
  text: string
}

/** An image a tool produced, shown to the user under that tool's card. */
type AgentToolImage = {
  toolCallId: string
  /** The image itself, inlined — it never enters the model's context. */
  dataUri: string
  /** What the image is, e.g. the workspace path it was saved to. */
  label: string
}

type AgentToolExecuteRequest = import('./types/agentIpc').AgentToolExecuteRequest

type electronAPI = import('./types/ipcChannels').ElectronApi

type SetupProgress = {
  serviceName: BackendServiceName
  step: string
  status: 'executing' | 'failed' | 'success'
  debugMessage: string
  errorDetails?: ErrorDetails
}

type Chrome = {
  webview: WebView
}

type LangchainDocument = {
  pageContent: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: Record<string, any>
  id?: string
}

type WebView = {
  hostObjects: HostProxyObjects
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener: (event: 'message', callback: (args: any) => void) => void
  removeEventListener: (
    event: 'message',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callback: (args: any) => void,
  ) => void
}

type HostProxyObjects = {
  clientAPI: AsyncClientAPI
  sync: SyncProxyObjects
}

type AsyncClientAPI = {
  WebViewInvoke: (methodName: string, param?: number | boolean | string | null) => Promise<string>
}

type SyncProxyObjects = {
  clientAPI: SyncClientAPI
}

type SyncClientAPI = {
  WebViewInvoke: (methodName: string, param?: number | boolean | string | null) => string
}

type ApiResponse = {
  code: number
  message: string
}

type KVObject = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

type StringKV = {
  [key: string]: string
}

type LLMOutCallback =
  | LoadModelCallback
  | LoadModelAllComplete
  | LLMOutTextCallback
  | DownloadModelProgressCallback
  | DownloadModelCompleted
  | ErrorOutCallback
  | NotEnoughDiskSpaceExceptionCallback
  | GatherMetrics

type LLMOutTextCallback = {
  type: 'text_out'
  value: string
  dtype: 1
  2
}

type LoadModelAllComplete = {
  type: 'allComplete'
}

type GatherMetrics = {
  type: 'metrics'
  num_tokens: number
  total_time: number
  overall_tokens_per_second: number
  second_plus_tokens_per_second: number
  first_token_latency: number
}

type LoadModelCallback = {
  type: 'load_model'
  event: 'start' | 'finish'
}

type NotEnoughDiskSpaceExceptionCallback = {
  type: 'error'
  err_type: 'not_enough_disk_space'
  requires_space: string
  free_space: string
}

type ErrorOutCallback = {
  type: 'error'
  err_type: 'runtime_error' | 'download_exception' | 'unknown_exception' | 'repositories_not_found'
}

type DownloadModelProgressCallback = {
  type: 'download_model_progress'
  repo_id: string
  download_size: string
  total_size: string
  percent: number
  speed: string
}

type DownloadModelCompleted = {
  type: 'download_model_completed'
  repo_id: string
}

type CheckModelAlreadyLoadedParameters = {
  repo_id: string
  type: string
  backend: 'comfyui' | 'llama_cpp' | 'openvino'
  model_path: string
  additionalLicenseLink?: string
}

type DownloadModelParam = CheckModelAlreadyLoadedParameters

type DownloadModelRender = {
  size: string
  gated?: boolean
  accessGranted?: boolean
} & DownloadModelParam

type ComfyUICustomNodesRequestParameters = {
  username: string
  repoName: string
  gitRef?: string
}

type CheckModelAlreadyLoadedResult = {
  already_loaded: boolean
} & CheckModelAlreadyLoadedParameters

type BackendServiceName =
  | 'ai-backend'
  | 'comfyui-backend'
  | 'llamacpp-backend'
  | 'openvino-backend'
  | 'home-agent-backend'
  | 'qwen3-tts-backend'
  | 'whisper-backend'

type InferenceDevice = {
  id: string
  name: string
  selected: boolean
  /** Stable vendor UUID when the backend can supply one; used to re-identify a
   *  device across driver/enumeration changes. undefined/null when unavailable. */
  uuid?: string | null
}

type ErrorDetails = {
  command?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  timestamp?: string
  duration?: number
  pipFreezeOutput?: string
  hint?: string
}

type ApiServiceInformation = {
  serviceName: BackendServiceName
  status: BackendStatus
  baseUrl: string
  port: number
  isSetUp: boolean
  isRequired: boolean
  devices: InferenceDevice[]
  llamaCppSsdOffloadConfigPath?: string
  sttDevices?: InferenceDevice[]
  errorDetails: ErrorDetails | null
  installedVersion?: { version: string; releaseTag?: string }
  llamaCppStandardArtifactReady?: boolean
  llamaCppPhisonArtifactReady?: boolean
  llamaCppStandardInstalledVersion?: { version: string; releaseTag?: string }
  llamaCppPhisonInstalledVersion?: { version: string; releaseTag?: string }
  /** OpenVINO LLM was launched with `--draft_model_path`. Absent means not armed. */
  ovmsMtpArmed?: boolean
  /** OpenVINO repo whose snapshot is missing `openvino_mtp_model.xml`. */
  ovmsMtpStaleModel?: string
}

// The catalog entry `loadModels` returns. Mirrors `ModelSchema` in
// src/types/shared.ts, which is what the main process parses models.json with.
type Model = {
  name: string
  mmproj?: string
  type: 'undefined' | 'embedding' | 'openVINO' | 'llamaCPP' | 'cloud'
  default?: boolean
  downloaded?: boolean | undefined
  backend?: 'openVINO' | 'llamaCPP' | 'cloud' | undefined
  supportsToolCalling?: boolean
  toolParser?: string
  reasoningParser?: string
  enableMtp?: boolean
  supportsVision?: boolean
  supportsReasoning?: boolean
  supportsCoding?: boolean
  supportsAgentic?: boolean
  supportsThinkingToggle?: boolean
  maxContextSize?: number
  inferenceDefaults?: import('@/types/shared').InferenceDefaults
  llamaCppArgs?: string
  npuSupport?: boolean
  largeMoe?: boolean
  requiresPhison?: boolean
}
