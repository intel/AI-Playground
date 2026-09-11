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
  llamaCppOffloadDrive?: string | null
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
  /** Dev unpackaged: set via settings-dev.json / userData overlay. */
  PhisonSSDdetected?: boolean
  /** Linux: user accepted obfuscated-on-disk secrets when no OS keyring is available. */
  allowPlaintextSecretStorage?: boolean
}

/** Mirrors electron/laminar LaminarConfigSchema (renderer copy for IPC typing). */
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

type McpConnectionState = 'stopped' | 'starting' | 'running' | 'error'

type McpStatus = {
  state: McpConnectionState
  lastError?: string
}

type McpToolInfo = {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

type McpServerInfo = {
  id: string
  name: string
  instructions?: string
}

type McpServerConfig =
  | {
      type?: 'stdio'
      command: string
      args?: string[]
      env?: Record<string, string>
      displayName?: string
      instructions?: string
    }
  | {
      type: 'http'
      url: string
      headers?: Record<string, string>
      displayName?: string
      instructions?: string
    }

type McpToolCallResult = {
  isError?: boolean
  content?: unknown
  structuredContent?: unknown
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

type GameLibraryEntry = import('./types/agentIpc').GameLibraryEntry
type ArcadeCatalogEntry = import('./types/agentIpc').ArcadeCatalogEntry

/** An image a tool produced, shown to the user under that tool's card. */
type AgentToolImage = {
  toolCallId: string
  /** The image itself, inlined — it never enters the model's context. */
  dataUri: string
  /** What the image is, e.g. the workspace path it was saved to. */
  label: string
}

type AgentToolExecuteRequest = {
  requestId: string
  /** Model-side tool call id, matching the UI message part (progress keying). */
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

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
  getInstalledBackendVersion(
    serviceName: string,
  ): Promise<{ releaseTag?: string; version?: string } | undefined>
  getGitHubRepoUrl(): Promise<string>
  openDevTools(): void
  setVerboseAgentLogging(enabled: boolean): void
  getDeveloperSettings(): Promise<{ openDevConsoleOnStartup: boolean }>
  openUrl(url: string): void
  changeWindowMessageFilter(): void
  getWinSize(): Promise<{
    width: number
    height: number
    maxChatContentHeight: number
  }>
  getLocaleSettings(): Promise<LocaleSettings>
  updateLocalSettings(updates: Partial<LocalSettings>): Promise<{ success: boolean }>
  getLocalSettings(): Promise<LocalSettings>
  detectHardwareForModeRecommendation(): Promise<HardwareRecommendationResult>
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
  getInitialPage(): Promise<ModeType | null>
  getDemoModeSettings(): Promise<DemoModeSettings>
  saveImage(url: string): void
  saveImageToMediaInput(dataUri: string): Promise<string>
  saveGeneratedAudio(
    audioBase64: string,
    filename: string,
    /** `overwrite`: replace an existing file of that name instead of suffixing `_1`. */
    options?: { overwrite?: boolean },
  ): Promise<{ success: boolean; filePath?: string; error?: string }>
  readLocalAudioAsDataUri(
    filePath: string,
  ): Promise<{ success: boolean; dataUri?: string; error?: string }>
  /** Delete a generated audio file. Confined to the app's audio directory. */
  deleteGeneratedAudio(filePath: string): Promise<{ success: boolean; error?: string }>
  readAipgMediaAsBase64(
    url: string,
  ): Promise<{ success: true; data: string } | { success: false; error: string }>
  openImageWin(url: string, title: string, width: number, height: number): void
  wakeupApiService(): void
  screenChange(callback: (width: number, height: number) => void): void
  webServiceExit(callback: (serviceName: string, normalExit: string) => void): void
  existsPath(path: string): Promise<boolean>
  addDocumentToRAGList(
    doc: IndexedDocument,
    phisonKmConfig?: PhisonKmIngestConfig,
  ): Promise<IndexedDocument>
  embedInputUsingRag(embedInquiry: EmbedInquiry): Promise<LangchainDocument[]>
  // mergedGroups here carries `content` (derived from splitDB just before the call) —
  // this WarmupRequest payload is transient IPC, never persisted, unlike the
  // boundary-only MergedGroup stored on IndexedDocument.
  warmupKVCacheForDocument(request: WarmupRequest): Promise<{ success: boolean }>
  getEmbeddingServerUrl(
    serviceName: string,
  ): Promise<{ success: boolean; url?: string; error?: string }>
  ensureEmbeddingServerReady(
    serviceName: string,
    embeddingModelName: string,
  ): Promise<{ success: boolean; error?: string }>
  getInitSetting(): Promise<SetupData>
  updateModelPaths(modelPaths: ModelPaths): Promise<ModelLists>
  restorePathsSettings(): Promise<void>
  loadModels(): Promise<Model[]>
  /**
   * Local Laminar tracing settings, or null when tracing is off (the default).
   * Read in main from `external/laminar.dev.json` (then
   * `external/laminar.localhost.json`) so the project API key never lands in
   * the renderer bundle. Dev-only (see electron/laminar.ts).
   */
  getLaminarConfig(): Promise<LaminarConfig | null>
  /**
   * Forward one AI SDK telemetry event (already serialized to JSON) to the
   * Laminar integration running in main. Fire-and-forget.
   */
  laminarTelemetryEvent(name: string, payload: string): void
  zoomIn(): Promise<void>
  zoomOut(): Promise<void>
  getDownloadedGGUFLLMs(): Promise<string[]>
  getDownloadedOpenVINOLLMModels(): Promise<string[]>
  getDownloadedEmbeddingModels(): Promise<Model[]>
  getComfyUIModels(modelType: string): Promise<string[]>
  scanModelLibrary(): Promise<import('./assets/js/models/types').ModelLibraryScan>
  showModelInFolder(modelPath: string): Promise<{ success: boolean; error?: string }>
  deleteModelPath(modelPath: string): Promise<{ success: boolean; error?: string }>
  getPlatform(): Promise<NodeJS.Platform>
  safeStorage: {
    isEncryptionAvailable(): Promise<boolean>
    enablePlainTextEncryption(): Promise<{ success: boolean; error?: string }>
  }
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
  getComfyUiDefaultParameters(): Promise<string>
  getLlamaCppDefaultParameters(): Promise<string>
  detectPhisonSsd(): Promise<{ detected: boolean }>
  /** Which OEM this machine came from, for partner co-branding. */
  detectOem(): Promise<{ vendor: string; manufacturer: string; overridden: boolean }>
  getServices(): Promise<ApiServiceInformation[]>
  getBackendAuthToken(serviceName: string): Promise<string>
  updateServiceSettings(settings: ServiceSettings): Promise<BackendStatus>

  uninstall(serviceName: string): Promise<void>
  selectDevice(serviceName: string, deviceId: string): Promise<void>
  selectSttDevice(serviceName: string, deviceId: string): Promise<void>
  detectDevices(serviceName: string): Promise<void>
  startService(serviceName: string): Promise<BackendStatus>
  stopService(serviceName: string): Promise<BackendStatus>
  setUpService(serviceName: string): Promise<void>
  onServiceSetUpProgress(callback: (data: SetupProgress) => void): void
  onServiceInfoUpdate(callback: (service: ApiServiceInformation) => void): void
  onShowToast(callback: (data: { type: string; message: string }) => void): void
  ensureBackendReadiness(
    serviceName: string,
    llmModelName: string,
    embeddingModelName?: string,
    contextSize?: number,
    modelArgs?: string,
  ): Promise<{ success: boolean; error?: string }>
  ensureComfyUIBackendRunning(): Promise<{
    success: boolean
    error?: string
    starting?: boolean
  }>
  startTranscriptionServer(modelName: string): Promise<{ success: boolean; error?: string }>
  stopTranscriptionServer(): Promise<{ success: boolean; error?: string }>
  getTranscriptionServerUrl(): Promise<{ success: boolean; url?: string; error?: string }>
  startSpeechServer(modelName: string): Promise<{ success: boolean; error?: string }>
  stopSpeechServer(): Promise<{ success: boolean; error?: string }>
  getSpeechServerUrl(): Promise<{ success: boolean; url?: string; error?: string }>
  synthesizeSpeech(options: {
    baseURL: string
    model: string
    input: string
    voice?: string
    apiKey?: string
    format?: string
  }): Promise<
    { success: true; dataBase64: string; mediaType: string } | { success: false; error: string }
  >
  ensureOvmsImageReady(
    serviceName: string,
    modelName: string,
    keepModelsLoaded?: boolean,
    resolution?: string,
  ): Promise<{ success: boolean; url?: string; error?: string }>
  stopOvmsImageServer(): Promise<{ success: boolean; error?: string }>
  stopOvmsChatServers(): Promise<{ success: boolean; error?: string }>
  getOvmsImageServerUrl(): Promise<{ success: boolean; url?: string; error?: string }>
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
    openInBrowser(): Promise<{ success: boolean; error?: string }>
  }
  mcp: {
    listServers(): Promise<McpServerInfo[]>
    startServer(serverId: string): Promise<McpStatus>
    stopServer(serverId: string): Promise<McpStatus>
    getServerStatus(serverId: string): Promise<McpStatus>
    listServerTools(serverId: string): Promise<McpToolInfo[]>
    invokeServerTool(
      serverId: string,
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<McpToolCallResult>
    openConfig(): void
    openConfigInFolder(): void
    reloadConfig(): Promise<McpServerInfo[]>
    addServer(
      serverId: string,
      config:
        | {
            type?: 'stdio'
            command: string
            args?: string[]
            displayName?: string
            instructions?: string
          }
        | {
            type: 'http'
            url: string
            headers?: Record<string, string>
            displayName?: string
            instructions?: string
          },
    ): Promise<void>
    getServerConfig(serverId: string): Promise<McpServerConfig>
    updateServer(
      serverId: string,
      config:
        | {
            type?: 'stdio'
            command: string
            args?: string[]
            displayName?: string
            instructions?: string
          }
        | {
            type: 'http'
            url: string
            headers?: Record<string, string>
            displayName?: string
            instructions?: string
          },
    ): Promise<void>
    removeServer(serverId: string): Promise<void>
  }
  agentMode: {
    startTurn(
      turnId: string,
      prompt: string,
      config: AgentModeTurnConfig,
    ): Promise<{ success: boolean; error?: string }>
    cancel(): Promise<void>
    resetSession(): Promise<void>
    deleteSession(sessionId: string): Promise<{ success: boolean; error?: string }>
    /**
     * Copy an attached file into the workspace, so the agent can reach it with
     * its file tools. Resolves with the workspace-relative path it was saved as.
     */
    importAttachment(
      workspaceDir: string,
      name: string,
      bytes: Uint8Array,
    ): Promise<{ success: boolean; path?: string; error?: string }>
    listCapabilities(options: {
      workspaceDir?: string
      toolSpecs?: AgentToolSpec[]
      mcpServerIds?: string[]
    }): Promise<AgentCapabilityInfo[]>
    onStreamChunk(callback: (data: { turnId: string; chunk: unknown }) => void): () => void
    onToolProgress(callback: (data: AgentToolProgress) => void): () => void
    onToolImage(callback: (data: AgentToolImage) => void): () => void
    onTurnDone(callback: (data: { turnId: string }) => void): () => void
    onExecuteTool(callback: (data: AgentToolExecuteRequest) => void): () => void
    submitToolResult(requestId: string, result: unknown, error?: string): Promise<void>
  }
  games: {
    list(): Promise<GameLibraryEntry[]>
    read(dir: string): Promise<GameLibraryEntry | null>
    /**
     * Mints a folder for a new game; `name` is a starting point, not final.
     * `scaffold: false` leaves it empty for a preset that writes the game whole.
     * The rest is provenance, recorded once and never patched afterwards.
     */
    create(
      name?: string,
      options?: {
        scaffold?: boolean
        backend?: string
        startingModel?: string
        initialPrompt?: string
      },
    ): Promise<GameLibraryEntry>
    publish(
      dir: string,
      fields: { name?: string; description?: string },
    ): Promise<{ success: boolean; error?: string; game?: GameLibraryEntry }>
    openFolder(dir?: string): Promise<void>
    play(dir: string): Promise<{ success: boolean; error?: string }>
    openArcade(): Promise<{ success: boolean; error?: string; path?: string }>
    /** Everything the arcade page could list; samples only on an Acer machine. */
    arcadeCatalog(): Promise<ArcadeCatalogEntry[]>
    setArcadeShown(target: {
      kind: 'user' | 'sample'
      id: string
      shown: boolean
    }): Promise<{ success: boolean; error?: string }>
  }
  webBrowser: {
    navigate(url: string): Promise<WebPageSnapshot>
    readPage(): Promise<WebPageSnapshot>
    search(query: string, maxResults?: number): Promise<WebSearchResults>
    interact(interaction: WebBrowserInteraction): Promise<WebPageSnapshot>
    screenshot(): Promise<string>
    show(): Promise<WebBrowserState>
    hide(): Promise<WebBrowserState>
    close(): Promise<WebBrowserState>
    getState(): Promise<WebBrowserState>
    onStateChanged(callback: (state: WebBrowserState) => void): void
  }
  screenshot: {
    listWindows(): Promise<ScreenshotWindowSource[]>
    captureWindow(target: ScreenshotWindow): Promise<string>
    getPermissionStatus(): Promise<{
      platform: string
      status: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'
    }>
    openPermissionSettings(): void
  }
  homeAgent: {
    saveDocument(
      filename: string,
      base64: string,
    ): Promise<{ success: boolean; filepath?: string; error?: string }>
    localWeb: {
      getUrls(port: number, allowLan: boolean): Promise<string[]>
    }
    channel: {
      saveConfig(
        kind: string,
        config: Record<string, string>,
      ): Promise<{ success: boolean; error?: string }>
      loadConfig(kind: string): Promise<Record<string, string> | null>
      clearConfig(kind: string): Promise<void>
      savePrefs(
        kind: string,
        prefs: { verified?: boolean; enabled?: boolean },
      ): Promise<{ success: boolean; error?: string }>
      loadPrefs(kind: string): Promise<{ verified: boolean; enabled: boolean } | null>
      test(kind: string): Promise<{ success: boolean; error?: string }>
      inject(
        kind: string,
        config: Record<string, string | undefined>,
      ): Promise<{ status: string; error?: string }>
      detectIdentity(
        kind: string,
        config: Record<string, string | undefined>,
      ): Promise<{ identity: string } | { error: string }>
      detectIdentityFromSaved(kind: string): Promise<{ identity: string } | { error: string }>
      poll(kind: string): Promise<
        Array<{
          text?: string
          chat_id: string
          channel?: string
          ts?: string
          images?: Array<{ mime: string; data_base64: string }>
          audio?: Array<{ mime: string; data_base64: string }>
          documents?: Array<{ filename: string; mime: string; data_base64: string }>
          callback?: string
        }>
      >
      flushPending(kind: string): Promise<void>
      send(
        kind: string,
        action:
          | 'reply'
          | 'update'
          | 'photo'
          | 'video'
          | 'voice'
          | 'document'
          | 'typing'
          | 'keyboard'
          | 'editMessage'
          | 'history',
        payload: Record<string, unknown>,
      ): Promise<{
        success: boolean
        ts?: string
        channel?: string
        messageId?: number
        error?: string
      }>
    }
  }
  cloudProvider: {
    saveKey(providerId: string, key: string): Promise<{ success: boolean; error?: string }>
    getKey(providerId: string): Promise<string | null>
    deleteKey(providerId: string): Promise<{ success: boolean; error?: string }>
    getProxyUrl(): Promise<string>
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
  // User cancellation is no longer modeled here; it is rejected as a benign
  // silent AppError (see createCancellation / CANCELLED_CODE). Only genuine
  // failures and conflicts flow through this shape.
  type: 'error' | 'conflict'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error?: any
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
}

type ApiServiceInformation = {
  serviceName: BackendServiceName
  status: BackendStatus
  baseUrl: string
  port: number
  isSetUp: boolean
  isRequired: boolean
  devices: InferenceDevice[]
  storageTargets?: StorageTarget[]
  llamaCppSsdOffloadConfigPath?: string
  sttDevices?: InferenceDevice[]
  errorDetails: ErrorDetails | null
  installedVersion?: { version: string; releaseTag?: string }
  llamaCppStandardArtifactReady?: boolean
  llamaCppPhisonArtifactReady?: boolean
  llamaCppStandardInstalledVersion?: { version: string; releaseTag?: string }
  llamaCppPhisonInstalledVersion?: { version: string; releaseTag?: string }
}

type StorageTarget = {
  id: string
  name: string
  path: string
  selected: boolean
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
  supportsVision?: boolean
  supportsReasoning?: boolean
  supportsCoding?: boolean
  supportsThinkingToggle?: boolean
  maxContextSize?: number
  inferenceDefaults?: import('@/types/shared').InferenceDefaults
  llamaCppArgs?: string
  npuSupport?: boolean
  largeMoe?: boolean
}
