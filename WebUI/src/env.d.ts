declare interface Window {
  chrome: Chrome
  electronAPI: electronAPI
  envVars: { platformTitle: string; productVersion: string; debugToolsEnabled: boolean }
}

interface ImportMetaEnv {
  readonly VITE_PLATFORM_TITLE: string
  readonly VITE_DEBUG_TOOLS: 'true' | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

type ServiceSettings = {
  serviceName: BackendServiceName
  version?: string
  releaseTag?: string
}

type DemoModeSettings = {
  isDemoModeEnabled: boolean
  demoModeResetInSeconds: null | number
}

// AipgPage type kept for backward compatibility with demoMode, but old UI pages are no longer used
type AipgPage = 'create' | 'enhance' | 'answer' | 'learn-more'
type WorkflowModeType = 'imageGen' | 'imageEdit' | 'video'
type ModeType = 'chat' | WorkflowModeType

type electronAPI = {
  startDrag: (fileName: string) => void
  getFilePath: (file: File) => string
  updatePresetsFromIntelRepo(): Promise<UpdatePresetsFromIntelResult>
  reloadPresets(): Promise<Array<{ content: string; image: string | null }>>
  getUserPresetsPath(): Promise<string>
  loadUserPresets(): Promise<Array<{ content: string; image: string | null }>>
  saveUserPreset(presetContent: string): Promise<boolean>
  resolveBackendVersion(
    serviceName: string,
  ): Promise<{ releaseTag: string; version: string } | undefined>
  openDevTools(): void
  openUrl(url: string): void
  changeWindowMessageFilter(): void
  getWinSize(): Promise<{
    width: number
    height: number
    maxChatContentHeight: number
  }>
  getLocaleSettings(): Promise<LocaleSettings>
  getThemeSettings(): Promise<ThemeSettings>
  setWinSize(width: number, height: number): Promise<void>
  showSaveDialog(options: Electron.SaveDialogOptions): Promise<Electron.SaveDialogReturnValue>
  showMessageBox(options: Electron.MessageBoxOptions): Promise<number>
  showMessageBoxSync(options: Electron.MessageBoxSyncOptions): Promise<number>
  showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue>
  dragWinToMoveStart(x: number, y: number): void
  dragWinToMove(x: number, y: number): void
  dragWinToMoveStop(): void
  setIgnoreMouseEvents(ignore: boolean): void
  miniWindow(): void
  exitApp(): void
  getMediaUrlBase(): Promise<string>
  getInitialPage(): Promise<AipgPage>
  getDemoModeSettings(): Promise<DemoModeSettings>
  saveImage(url: string): void
  openImageWin(url: string, title: string, width: number, height: number): void
  wakeupApiService(): void
  screenChange(callback: (width: number, height: number) => void): void
  webServiceExit(callback: (serviceName: string, normalExit: string) => void): void
  existsPath(path: string): Promise<boolean>
  addDocumentToRAGList(doc: IndexedDocument): Promise<IndexedDocument>
  embedInputUsingRag(embedInquiry: EmbedInquiry): Promise<LangchainDocument[]>
  getEmbeddingServerUrl(
    serviceName: string,
  ): Promise<{ success: boolean; url?: string; error?: string }>
  getInitSetting(): Promise<SetupData>
  updateModelPaths(modelPaths: ModelPaths): Promise<ModelLists>
  restorePathsSettings(): Promise<void>
  refreshLLMModles(): Promise<string[]>
  loadModels(): Promise<Model[]>
  zoomIn(): Promise<void>
  zoomOut(): Promise<void>
  getDownloadedLLMs(): Promise<string[]>
  getDownloadedGGUFLLMs(): Promise<string[]>
  getDownloadedOpenVINOLLMModels(): Promise<string[]>
  getDownloadedEmbeddingModels(): Promise<Model[]>
  openImageWithSystem(url: string): void
  openImageInFolder(url: string): void
  setFullScreen(enable: boolean): void
  onDebugLog(
    callback: (data: {
      level: 'error' | 'warn' | 'info'
      source: 'ai-backend'
      message: string
    }) => void,
  ): void
  wakeupComfyUIService(): void
  getServices(): Promise<ApiServiceInformation[]>
  updateServiceSettings(settings: ServiceSettings): Promise<BackendStatus>
  getServiceSettings(serviceName: string): Promise<ServiceSettings[BackendServiceName]>
  uninstall(serviceName: string): Promise<void>
  selectDevice(serviceName: string, deviceId: string): Promise<void>
  detectDevices(serviceName: string): Promise<void>
  startService(serviceName: string): Promise<BackendStatus>
  stopService(serviceName: string): Promise<BackendStatus>
  setUpService(serviceName: string): void
  onServiceSetUpProgress(callback: (data: SetupProgress) => void): void
  onServiceInfoUpdate(callback: (service: ApiServiceInformation) => void): void
  ensureBackendReadiness(
    serviceName: string,
    llmModelName: string,
    embeddingModelName?: string,
    contextSize?: number,
  ): Promise<{ success: boolean; error?: string }>
  // ComfyUI Tools - uses uv for Python package management
  comfyui: {
    isGitInstalled(): Promise<boolean>
    isComfyUIInstalled(): Promise<boolean>
    getGitRef(repoDir: string): Promise<string | undefined>
    isPackageInstalled(packageSpecifier: string): Promise<boolean>
    installPypiPackage(packageSpecifier: string): Promise<void>
    isCustomNodeInstalled(nodeRepoRef: ComfyUICustomNodeRepoId): Promise<boolean>
    downloadCustomNode(nodeRepoData: ComfyUICustomNodeRepoId): Promise<boolean>
    uninstallCustomNode(nodeRepoData: ComfyUICustomNodeRepoId): Promise<boolean>
    listInstalledCustomNodes(): Promise<string[]>
  }
}

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

type WebSettings = {
  graphics: { name: string; index: number }[]
  schedulers: string[]
}

type GraphicsItem = {
  index: number
  name: string
}

type ClientMessageEventArgs = {
  data: UpdateLanguageSettingsNotify
  type: 'message'
}

type UpdateLanguageSettingsNotify = {
  type: 'updateLanguageSettings'
  value: LanguageSetting
}

type LanguageSetting = {
  langName: string
  records: Record<string, string>
}

type DropListItem = {
  display: string
  value: string | number
}

type MetricsData = {
  num_tokens: number
  total_time: number
  first_token_latency: number
  overall_tokens_per_second: number
  second_plus_tokens_per_second: number
}

type ChatItem = {
  metrics: MetricsData
  question: string
  answer: string
  parsedAnswer: string
  parsedThinkingText: string
  title?: string
  model?: string
  showThinkingText?: boolean
  reasoningTime?: number
  createdAt?: number
  ragSource?: string | null
  showRagSource?: boolean
}

type ChatRequestParams = {
  context?: Array<Chat>
}

type RagFileItem = {
  type: number
  filename: string
  md5: string
  status: number
  path?: string | null
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

type LoadModelComponentsCallback = {
  type: 'load_model_components'
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
  err_type: 'runtime_error' | 'download_exception' | 'unknown_exception'
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

type ShowOpenDialogOptions = {
  filters: Array<{
    name: string
    extensions: Array<string>
  }>
  title?: string
  multiSelected?: boolean
}
type ShowOpenDialogResult = {
  canceled: boolean
  filePaths: Array<string>
}

type ShowSaveDialogOptions = {
  filters: Array<{
    name: string
    extensions: Array<string>
  }>
  title?: string
  defaultPath?: string
}

type ShowSaveDialogResult = {
  canceled: boolean
  filePath: string
}

type RandomNumberSetting = {
  min: nubmer
  max: number
  scale: number
  default: number
  value: number
}

type ResolutionSettings = {
  width: NumberRange
  height: NumberRange
  preset: Size[]
}

type Size = {
  width: number
  height: number
}

type NumberRange = {
  min: number
  max: number
}

type DownloadFailedParams = {
  type: 'error' | 'cancelConfrim' | 'cancelDownload' | 'conflict'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error?: any
}

type CheckModelAlreadyLoadedParameters = {
  repo_id: string
  type: string
  backend: 'comfyui' | 'llama_cpp' | 'openvino'
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
  | 'ollama-backend'

type InferenceDevice = {
  id: string
  name: string
  selected: boolean
}

type ErrorDetails = {
  command?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  timestamp?: string
  duration?: number
  pipFreezeOutput?: string
}

type ApiServiceInformation = {
  serviceName: BackendServiceName
  status: BackendStatus
  baseUrl: string
  port: number
  isSetUp: boolean
  isRequired: boolean
  devices: InferenceDevice[]
  errorDetails: ErrorDetails | null
}

type Model = {
  name: string
  type: 'undefined' | 'embedding' | 'openVINO' | 'llamaCPP' | 'ollama'
  default: boolean
  downloaded?: boolean | undefined
  backend?: 'openVINO' | 'llamaCPP' | 'ollama' | undefined
  supportsToolCalling?: boolean
  supportsVision?: boolean
  maxContextSize?: number
}
