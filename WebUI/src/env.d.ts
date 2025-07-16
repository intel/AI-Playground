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
  version?: string
  serviceName: BackendServiceName
}

type AipgPage = 'create' | 'enhance' | 'answer' | 'learn-more'

type electronAPI = {
  getFilePath: (file: File) => string
  reloadImageWorkflows(): Promise<string[]>
  updateWorkflowsFromIntelRepo(): Promise<UpdateWorkflowsFromIntelResult>
  openDevTools(): void
  openUrl(url: string): void
  changeWindowMessageFilter(): void
  getWinSize(): Promise<{
    width: number
    height: number
    maxChatContentHeight: number
  }>
  getLocalSettings(): Promise<LocalSettings>
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
  getDemoModeSettings(): Promise<boolean>
  saveImage(url: string): void
  openImageWin(url: string, title: string, width: number, height: number): void
  wakeupApiService(): void
  screenChange(callback: (width: number, height: number) => void): void
  webServiceExit(callback: (serviceName: string, normalExit: string) => void): void
  existsPath(path: string): Promise<boolean>
  addDocumentToRAGList(doc: IndexedDocument): Promise<IndexedDocument>
  embedInputUsingRag(embedInquiry: EmbedInquiry): Promise<LangchainDocument[]>
  getInitSetting(): Promise<SetupData>
  updateModelPaths(modelPaths: ModelPaths): Promise<ModelLists>
  restorePathsSettings(): Promise<void>
  refreshSDModles(): Promise<string[]>
  refreshLLMModles(): Promise<string[]>
  refreshLora(): Promise<string[]>
  refreshInpaintModles(): Promise<string[]>
  getDownloadedDiffusionModels(): Promise<string[]>
  getDownloadedInpaintModels(): Promise<string[]>
  getDownloadedLoras(): Promise<string[]>
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
  sendStartSignal(serviceName: string): Promise<BackendStatus>
  sendStopSignal(serviceName: string): Promise<BackendStatus>
  sendSetUpSignal(serviceName: string): void
  onServiceSetUpProgress(callback: (data: SetupProgress) => void): void
  onServiceInfoUpdate(callback: (service: ApiServiceInformation) => void): void
}

type SetupProgress = {
  serviceName: BackendServiceName
  step: string
  status: 'executing' | 'failed' | 'success'
  debugMessage: string
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
  type: number
  backend: 'comfyui' | 'default' | 'llama_cpp' | 'openvino'
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

type BackendServiceName = 'ai-backend' | 'comfyui-backend' | 'llamacpp-backend' | 'openvino-backend'

type InferenceDevice = {
  id: string
  name: string
  selected: boolean
}

type ApiServiceInformation = {
  serviceName: BackendServiceName
  status: BackendStatus
  baseUrl: string
  port: number
  isSetUp: boolean
  isRequired: boolean
  devices: InferenceDevice[]
}
