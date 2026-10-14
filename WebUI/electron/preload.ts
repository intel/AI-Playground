import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import pkg from '../package.json'
import type { LocalSettings } from './kernel/localSettings.ts'
import { ModelPaths } from '@/assets/js/store/models'
import { cloneForIpc } from '@/lib/cloneForIpc'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import type { EmbedInquiry, IndexedDocument } from '@/types/rag'
import type { PhisonKmIngestConfig, WarmupRequest } from '@/types/phisonKmRag'
import type { AgentModeTurnConfig, AgentToolExecuteRequest, AgentToolSpec } from '@/types/agentIpc'
import type { AgentSessionRecordWire } from '@/types/agentSessionIpc'
import type { ArtifactRunRequest } from '@/types/artifactIpc'
import type { ChatSummarizeRequest, ChatTurnRequest } from '@/types/chatIpc'
import type { ChatAnswerPayload, ChatAskPayload } from '@/types/chatRequests'
import type { ComfyUICustomNodeRepoId } from '@/types/comfyuiIpc'
import type { ComputeSnapshot } from '@/types/computeMetrics'
import type { ConversationSaveRequest } from '@/types/conversationIpc'
import type { McpServerConfig } from '@/types/mcpIpc'
import type { MediaRequestPayload, MediaResponsePayload } from '@/types/mediaRequests'
import type { SpeechSynthesisRequest } from '@/types/speechIpc'
import type {
  PermissionGrant,
  PermissionGrantOrigin,
  PermissionsPromptPayload,
  PermissionsPromptResponse,
} from '@/types/permissionsIpc'
import type {
  ChannelArgs,
  ChannelResult,
  ElectronApi,
  InvokeChannelName,
  MessageBoxOptions,
  OpenDialogOptions,
  PushChannelName,
  PushPayload,
  RawPushChannelName,
  SaveDialogOptions,
  SendChannelName,
} from '@/types/ipcChannels'

function listen<T>(channel: string, callback: (data: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, data: T) => callback(data)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

function invoke<N extends InvokeChannelName>(
  channel: N,
  ...args: ChannelArgs<N>
): Promise<ChannelResult<N>> {
  return ipcRenderer.invoke(channel, ...args) as unknown as Promise<ChannelResult<N>>
}

function send<N extends SendChannelName>(channel: N, ...args: ChannelArgs<N>): void {
  ipcRenderer.send(channel, ...args)
}

function onPush<N extends PushChannelName>(
  channel: N,
  cb: (data: PushPayload<N>) => void,
): () => void {
  return listen(channel, cb)
}

// Raw pushes keep the legacy member shape: the callback is registered with
// `ipcRenderer.on` and no unsubscribe is returned.
function onRaw<N extends RawPushChannelName>(channel: N, cb: (data: PushPayload<N>) => void): void {
  listen(channel, cb)
}

contextBridge.exposeInMainWorld('envVars', {
  platformTitle: import.meta.env.VITE_PLATFORM_TITLE,
  debugToolsEnabled: import.meta.env.VITE_DEBUG_TOOLS === 'true',
  productVersion: pkg.version,
  // Which build this is, baked in by vite.config.mts. Empty when the source has
  // no git history (an exported tree), so the UI must treat them as optional.
  gitCommit: import.meta.env.VITE_GIT_COMMIT ?? '',
  gitTag: import.meta.env.VITE_GIT_TAG ?? '',
})
contextBridge.exposeInMainWorld('electronAPI', {
  startDrag: (fileName: string) => send('ondragstart', fileName),
  getFilePath: (file: File) => webUtils.getPathForFile(file),
  getServices: () => invoke('getServices'),
  getBackendAuthToken: (serviceName: string) => invoke('getBackendAuthToken', serviceName),
  updateServiceSettings: (settings: ServiceSettings) => invoke('updateServiceSettings', settings),
  uninstall: (serviceName: string) => invoke('uninstall', serviceName),
  selectDevice: (serviceName: string, deviceId: string) =>
    invoke('selectDevice', serviceName, deviceId),
  selectSttDevice: (serviceName: string, deviceId: string) =>
    invoke('selectSttDevice', serviceName, deviceId),
  detectDevices: (serviceName: string) => invoke('detectDevices', serviceName),
  startService: (serviceName: string) => invoke('startService', serviceName),
  stopService: (serviceName: string) => invoke('stopService', serviceName),
  setUpService: (serviceName: BackendServiceName) => invoke('setUpService', serviceName),
  updatePresetsFromIntelRepo: () => invoke('updatePresetsFromIntelRepo'),
  reloadPresets: () => invoke('reloadPresets'),
  getUserPresetsPath: () => invoke('getUserPresetsPath'),
  loadUserPresets: () => invoke('loadUserPresets'),
  saveUserPreset: (presetContent: string) => invoke('saveUserPreset', presetContent),
  resolveBackendVersion: (serviceName: BackendServiceName) =>
    invoke('resolveBackendVersion', serviceName),
  getInstalledBackendVersion: (serviceName: BackendServiceName) =>
    invoke('getInstalledBackendVersion', serviceName),
  getGitHubRepoUrl: () => invoke('getGitHubRepoUrl'),
  openDevTools: () => send('openDevTools'),
  setVerboseAgentLogging: (enabled: boolean) => send('setVerboseAgentLogging', enabled),
  openUrl: (url: string) => send('openUrl', url),
  getLocaleSettings: () => invoke('getLocaleSettings'),
  updateLocalSettings: (updates: Partial<LocalSettings>) => invoke('updateLocalSettings', updates),
  getLocalSettings: () => invoke('getLocalSettings'),
  detectHardwareForModeRecommendation: () => invoke('detectHardwareForModeRecommendation'),
  getWinSize: () => invoke('getWinSize'),
  setWinSize: (width: number, height: number) => invoke('setWinSize', width, height),
  showSaveDialog: (options: SaveDialogOptions) => invoke('showSaveDialog', options),
  showMessageBox: (options: MessageBoxOptions) => invoke('showMessageBox', options),
  miniWindow: () => send('miniWindow'),
  exitApp: () => send('exitApp'),
  getInitialPage: () => invoke('getInitialPage'),
  getDemoModeSettings: () => invoke('getDemoModeSettings'),
  showOpenDialog: (options: OpenDialogOptions) => invoke('showOpenDialog', options),
  saveImage: (url: string) => send('saveImage', url),
  saveImageToMediaInput: (dataUri: string) => invoke('saveImageToMediaInput', dataUri),
  saveAudioToMediaInput: (dataUri: string) => invoke('saveAudioToMediaInput', dataUri),
  saveGeneratedAudio: (audioBase64: string, filename: string, options?: { overwrite?: boolean }) =>
    invoke('saveGeneratedAudio', audioBase64, filename, options),
  readLocalAudioAsDataUri: (filePath: string) => invoke('readLocalAudioAsDataUri', filePath),
  deleteGeneratedAudio: (filePath: string) => invoke('deleteGeneratedAudio', filePath),
  readAipgMediaAsBase64: (url: string) => invoke('readAipgMediaAsBase64', url),
  openImageWin: (url: string, title: string, width: number, height: number) =>
    send('openImageWin', url, title, width, height),
  screenChange: (callback: (metrics: { width: number; height: number }) => void) =>
    onRaw('display-metrics-changed', callback),
  existsPath: (path: string) => invoke('existsPath', path),
  addDocumentToRAGList: (doc: IndexedDocument, phisonKmConfig?: PhisonKmIngestConfig) =>
    invoke('addDocumentToRAGList', doc, phisonKmConfig),
  embedInputUsingRag: (embedInquiry: EmbedInquiry) => invoke('embedInputUsingRag', embedInquiry),
  warmupKVCacheForDocument: (request: WarmupRequest) => invoke('warmupKVCacheForDocument', request),
  getEmbeddingServerUrl: (serviceName: string) => invoke('getEmbeddingServerUrl', serviceName),
  ensureEmbeddingServerReady: (serviceName: string, embeddingModelName: string) =>
    invoke('ensureEmbeddingServerReady', serviceName, embeddingModelName),
  getInitSetting: () => invoke('getInitSetting'),
  updateModelPaths: (modelPaths: ModelPaths) => invoke('updateModelPaths', modelPaths),
  restorePathsSettings: () => invoke('restorePathsSettings'),
  loadModels: () => invoke('loadModels'),
  getLaminarConfig: () => invoke('getLaminarConfig'),
  getComputeMetrics: () => invoke('getComputeMetrics'),
  getComputeMetricsDiagnostics: () => invoke('getComputeMetricsDiagnostics'),
  onComputeMetricsUpdate: (callback: (snapshot: ComputeSnapshot) => void) =>
    onRaw('computeMetricsUpdate', callback),
  laminarTelemetryEvent: (name: string, payload: string) =>
    send('laminarTelemetryEvent', name, payload),
  zoomIn: () => invoke('zoomIn'),
  zoomOut: () => invoke('zoomOut'),
  getDownloadedGGUFLLMs: () => invoke('getDownloadedGGUFLLMs'),
  getDownloadedOpenVINOLLMModels: () => invoke('getDownloadedOpenVINOLLMModels'),
  getDownloadedEmbeddingModels: () => invoke('getDownloadedEmbeddingModels'),
  getComfyUIModels: (modelType: string) => invoke('getComfyUIModels', modelType),
  scanModelLibrary: () => invoke('scanModelLibrary'),
  getLlamaCppVramInputs: (modelName: string, mmprojName?: string) =>
    invoke('getLlamaCppVramInputs', modelName, mmprojName),
  showModelInFolder: (modelPath: string) => invoke('showModelInFolder', modelPath),
  deleteModelPath: (modelPath: string) => invoke('deleteModelPath', modelPath),
  getPlatform: () => invoke('getPlatform'),
  safeStorage: {
    isEncryptionAvailable: () => invoke('safeStorage:isEncryptionAvailable'),
    enablePlainTextEncryption: () => invoke('safeStorage:enablePlainTextEncryption'),
  },
  openImageWithSystem: (url: string) => send('openImageWithSystem', url),
  openImageInFolder: (url: string) => send('openImageInFolder', url),
  setFullScreen: (enable: boolean) => send('setFullScreen', enable),
  onDebugLog: (
    callback: (data: { level: 'error' | 'warn' | 'info'; source: string; message: string }) => void,
  ) => onRaw('debugLog', callback),
  getComfyUiDefaultParameters: () => invoke('getComfyUiDefaultParameters'),
  getLlamaCppDefaultParameters: () => invoke('getLlamaCppDefaultParameters'),
  detectPhisonSsd: () => invoke('detectPhisonSsd'),
  detectOem: () => invoke('detectOem'),
  onServiceSetUpProgress: (callback: (data: SetupProgress) => void) =>
    onRaw('serviceSetUpProgress', callback),
  onKernelEvent: (callback: (event: import('../src/types/kernelEvents').KernelEvent) => void) =>
    listen('kernel:event', callback),
  getKernelSnapshot: () => invoke('kernel:getSnapshot'),
  setLifecycleBusy: (busy: boolean) => send('lifecycle:busy', busy),
  onShowToast: (callback: (data: { type: string; message: string }) => void) =>
    onRaw('show-toast', callback),
  ensureBackendReadiness: (
    serviceName: string,
    llmModelName: string,
    embeddingModelName?: string,
    contextSize?: number,
    modelArgs?: string,
    skipGpuAdmission?: boolean,
    options?: { remember?: boolean },
  ) =>
    invoke(
      'ensureBackendReadiness',
      serviceName,
      llmModelName,
      embeddingModelName,
      contextSize,
      modelArgs,
      skipGpuAdmission,
      options,
    ),
  setLastChatBackendLoadActive: (active: boolean) => invoke('setLastChatBackendLoadActive', active),
  rememberChatBackendLoad: (
    args: NonNullable<import('../src/types/chatIpc').ChatModelConfig['readiness']>,
  ) => invoke('rememberChatBackendLoad', args),
  artifact: {
    run: (request: ArtifactRunRequest, options?: { queue?: 'fail-fast' | 'queue' }) =>
      invoke('artifact:run', cloneForIpc(request), options),
    cancel: (runId?: string) => invoke('artifact:cancel', runId),
    respond: (payload: MediaResponsePayload) => invoke('artifact:respond', payload),
    onRequest: (callback: (payload: MediaRequestPayload) => void) =>
      onPush('artifact:request', callback),
  },
  permissions: {
    requestDownload: (models: unknown[]) =>
      invoke('permissions:requestDownload', cloneForIpc(models)),
    requestVramWarning: (req: { presetName: string; message: string }) =>
      invoke('permissions:requestVramWarning', req),
    list: () => invoke('permissions:list'),
    grant: (key: string, origin: PermissionGrantOrigin) => invoke('permissions:grant', key, origin),
    revoke: (key: string) => invoke('permissions:revoke', key),
    migrate: (incoming: Record<string, PermissionGrant>) =>
      invoke('permissions:migrate', cloneForIpc(incoming)),
    respond: (payload: PermissionsPromptResponse) => invoke('permissions:respond', payload),
    onPrompt: (callback: (payload: PermissionsPromptPayload) => void) =>
      onPush('permissions:prompt', callback),
  },
  chat: {
    submitTurn: (request: ChatTurnRequest) => invoke('chat:submitTurn', cloneForIpc(request)),
    resumeTurn: (conversationKey: string) => invoke('chat:resumeTurn', conversationKey),
    cancelTurn: (conversationKey: string, turnId: string) =>
      invoke('chat:cancelTurn', conversationKey, turnId),
    summarize: (request: ChatSummarizeRequest) => invoke('chat:summarize', request),
    answer: (payload: ChatAnswerPayload) => invoke('chat:answer', cloneForIpc(payload)),
    onAsk: (callback: (payload: ChatAskPayload) => void) => onPush('chat:ask', callback),
  },
  conversations: {
    bootstrap: () => invoke('conversations:bootstrap'),
    migrate: (payload: unknown) => invoke('conversations:migrate', cloneForIpc(payload)),
    save: (request: ConversationSaveRequest) => invoke('conversations:save', cloneForIpc(request)),
    delete: (id: string) => invoke('conversations:delete', id),
    saveLastMainKey: (key: string | null) => invoke('conversations:saveLastMainKey', key),
  },
  mediaItems: {
    bootstrap: () => invoke('mediaItems:bootstrap'),
    migrate: (items: unknown[]) => invoke('mediaItems:migrate', cloneForIpc(items)),
    save: (items: unknown[]) => invoke('mediaItems:save', cloneForIpc(items)),
    delete: (ids: string[]) => invoke('mediaItems:delete', ids),
  },
  preferences: {
    read: () => invoke('preferences:read'),
    migrate: (section: string, payload: unknown) =>
      invoke('preferences:migrate', section, cloneForIpc(payload)),
    write: (section: string, value: unknown) =>
      invoke('preferences:write', section, cloneForIpc(value)),
  },
  ragDocuments: {
    read: () => invoke('ragDocuments:read'),
    migrate: (payload: unknown) => invoke('ragDocuments:migrate', cloneForIpc(payload)),
    write: (value: unknown) => invoke('ragDocuments:write', cloneForIpc(value)),
  },
  getBackendLaunchSettings: () => invoke('getBackendLaunchSettings'),
  migrateBackendLaunchSettings: (payload: unknown) =>
    invoke('migrateBackendLaunchSettings', cloneForIpc(payload)),
  startTranscriptionServer: (modelName: string) => invoke('startTranscriptionServer', modelName),
  stopTranscriptionServer: () => invoke('stopTranscriptionServer'),
  getTranscriptionServerUrl: () => invoke('getTranscriptionServerUrl'),
  startSpeechServer: (modelName: string) => invoke('startSpeechServer', modelName),
  stopSpeechServer: () => invoke('stopSpeechServer'),
  getSpeechServerUrl: () => invoke('getSpeechServerUrl'),
  synthesizeSpeech: (options: SpeechSynthesisRequest) => invoke('synthesizeSpeech', options),
  ensureOvmsImageReady: (
    serviceName: string,
    modelName: string,
    keepModelsLoaded?: boolean,
    resolution?: string,
  ) => invoke('ensureOvmsImageReady', serviceName, modelName, keepModelsLoaded, resolution),
  stopOvmsChatServers: () => invoke('stopOvmsChatServers'),
  getOvmsImageServerUrl: () => invoke('getOvmsImageServerUrl'),
  // ComfyUI Tools
  comfyui: {
    isGitInstalled: () => invoke('comfyui:isGitInstalled'),
    isComfyUIInstalled: () => invoke('comfyui:isComfyUIInstalled'),
    getGitRef: (repoDir: string) => invoke('comfyui:getGitRef', repoDir),
    isPackageInstalled: (packageSpecifier: string) =>
      invoke('comfyui:isPackageInstalled', packageSpecifier),
    installPypiPackage: (packageSpecifier: string) =>
      invoke('comfyui:installPypiPackage', packageSpecifier),
    isCustomNodeInstalled: (nodeRepoRef: ComfyUICustomNodeRepoId) =>
      invoke('comfyui:isCustomNodeInstalled', nodeRepoRef),
    downloadCustomNode: (nodeRepoData: ComfyUICustomNodeRepoId) =>
      invoke('comfyui:downloadCustomNode', nodeRepoData),
    uninstallCustomNode: (nodeRepoData: ComfyUICustomNodeRepoId) =>
      invoke('comfyui:uninstallCustomNode', nodeRepoData),
    listInstalledCustomNodes: () => invoke('comfyui:listInstalledCustomNodes'),
    openInBrowser: () => invoke('comfyui:openInBrowser'),
  },
  mcp: {
    listServers: () => invoke('mcp:listServers'),
    startServer: (serverId: string) => invoke('mcp:startServer', serverId),
    stopServer: (serverId: string) => invoke('mcp:stopServer', serverId),
    getServerStatus: (serverId: string) => invoke('mcp:getServerStatus', serverId),
    listServerTools: (serverId: string) => invoke('mcp:listServerTools', serverId),
    invokeServerTool: (serverId: string, toolName: string, args: Record<string, unknown>) =>
      invoke('mcp:invokeServerTool', serverId, toolName, args),
    openConfig: () => send('mcp:openConfig'),
    openConfigInFolder: () => send('mcp:openConfigInFolder'),
    reloadConfig: () => invoke('mcp:reloadConfig'),
    addServer: (serverId: string, config: McpServerConfig) =>
      invoke('mcp:addServer', serverId, config),
    getServerConfig: (serverId: string) => invoke('mcp:getServerConfig', serverId),
    updateServer: (serverId: string, config: McpServerConfig) =>
      invoke('mcp:updateServer', serverId, config),
    removeServer: (serverId: string) => invoke('mcp:removeServer', serverId),
  },
  agentMode: {
    startTurn: (turnId: string, prompt: string, config: AgentModeTurnConfig) =>
      invoke('agentMode:startTurn', turnId, prompt, cloneForIpc(config)),
    cancel: () => invoke('agentMode:cancel'),
    resetSession: () => invoke('agentMode:resetSession'),
    deleteSession: (sessionId: string) => invoke('agentMode:deleteSession', sessionId),
    bootstrapSessions: () => invoke('agentMode:bootstrapSessions'),
    migrateSessions: (legacy: unknown) => invoke('agentMode:migrateSessions', cloneForIpc(legacy)),
    saveSession: (record: AgentSessionRecordWire) =>
      invoke('agentMode:saveSession', cloneForIpc(record)),
    saveActiveSessionId: (id: string | null) => invoke('agentMode:saveActiveSessionId', id),
    readWorkspaceState: () => invoke('agentMode:readWorkspaceState'),
    migrateWorkspaceState: (payload: unknown) =>
      invoke('agentMode:migrateWorkspaceState', cloneForIpc(payload)),
    writeWorkspaceState: (value: unknown) =>
      invoke('agentMode:writeWorkspaceState', cloneForIpc(value)),
    importAttachment: (workspaceDir: string, name: string, bytes: Uint8Array) =>
      invoke('agentMode:importAttachment', workspaceDir, name, bytes),
    listCapabilities: (options: {
      workspaceDir?: string
      toolSpecs?: AgentToolSpec[]
      mcpServerIds?: string[]
      embeddingModel?: string
    }) => invoke('agentMode:listCapabilities', options),
    onExecuteTool: (callback: (data: AgentToolExecuteRequest) => void) =>
      onPush('agentMode:executeTool', callback),
    submitToolResult: (requestId: string, result: unknown, error?: string) =>
      invoke('agentMode:toolResult', requestId, result, error),
  },
  games: {
    list: () => invoke('games:list'),
    read: (dir: string) => invoke('games:read', dir),
    create: (
      name?: string,
      options?: {
        scaffold?: boolean
        backend?: string
        startingModel?: string
        initialPrompt?: string
      },
    ) => invoke('games:create', name, options),
    publish: (dir: string, fields: { name?: string; description?: string }) =>
      invoke('games:publish', dir, fields),
    openFolder: (dir?: string) => invoke('games:openFolder', dir),
    play: (dir: string) => invoke('games:play', dir),
    openArcade: () => invoke('games:openArcade'),
    arcadeCatalog: () => invoke('games:arcadeCatalog'),
    setArcadeShown: (target: { kind: 'user' | 'sample'; id: string; shown: boolean }) =>
      invoke('games:setArcadeShown', target),
  },
  webBrowser: {
    navigate: (url: string) => invoke('webBrowser:navigate', url),
    readPage: () => invoke('webBrowser:readPage'),
    search: (query: string, maxResults?: number) => invoke('webBrowser:search', query, maxResults),
    interact: (interaction: WebBrowserInteraction) => invoke('webBrowser:interact', interaction),
    screenshot: () => invoke('webBrowser:screenshot'),
    show: () => invoke('webBrowser:show'),
    hide: () => invoke('webBrowser:hide'),
    close: () => invoke('webBrowser:close'),
    getState: () => invoke('webBrowser:getState'),
    onStateChanged: (callback: (state: WebBrowserState) => void) =>
      onRaw('webBrowser:stateChanged', callback),
  },
  screenshot: {
    listWindows: () => invoke('screenshot:listWindows'),
    captureWindow: (target: ScreenshotWindow) => invoke('screenshot:captureWindow', target),
    getPermissionStatus: () => invoke('screenshot:getPermissionStatus'),
    openPermissionSettings: () => send('screenshot:openPermissionSettings'),
  },
  homeAgent: {
    // Persist an inbound document (base64) to disk for RAG ingestion.
    saveDocument: (filename: string, base64: string) =>
      invoke('saveHomeAgentDocument', filename, base64),
    // Local web chat — URL discovery (the chat server lives in the Python
    // backend; this only enumerates reachable addresses for the setup screen).
    // `allowLan` mirrors the bind: loopback only unless LAN access is on.
    localWeb: {
      getUrls: (port: number, allowLan: boolean): Promise<string[]> =>
        invoke('homeAgent:localWeb:getUrls', port, allowLan),
    },
    // Channel-agnostic dispatcher. Every method is keyed by ChannelKind
    // (`'telegram'` | `'slack'` | `'discord'` | `'local-web'`) so adding a new
    // platform requires zero edits here — only a new entry in the renderer-side
    // channel registry and a Python channel module.
    channel: {
      saveConfig: (kind: ChannelKind, config: Record<string, string>) =>
        invoke('channel:saveConfig', kind, config),
      loadConfig: (kind: ChannelKind) => invoke('channel:loadConfig', kind),
      clearConfig: (kind: ChannelKind) => invoke('channel:clearConfig', kind),
      savePrefs: (kind: ChannelKind, prefs: { verified?: boolean; enabled?: boolean }) =>
        invoke('channel:savePrefs', kind, prefs),
      loadPrefs: (kind: ChannelKind) => invoke('channel:loadPrefs', kind),
      test: (kind: ChannelKind) => invoke('channel:test', kind),
      inject: (kind: ChannelKind, config: Record<string, string | undefined>) =>
        invoke('channel:inject', kind, config),
      detectIdentity: (kind: ChannelKind, config: Record<string, string | undefined>) =>
        invoke('channel:detectIdentity', kind, config),
      detectIdentityFromSaved: (kind: ChannelKind) =>
        invoke('channel:detectIdentityFromSaved', kind),
      poll: (kind: ChannelKind) => invoke('channel:poll', kind),
      flushPending: (kind: ChannelKind) => invoke('channel:flushPending', kind),
      send: (
        kind: ChannelKind,
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
      ) => invoke('channel:send', kind, action, payload),
    },
  },
  // Cloud Mode provider secrets, encrypted at rest via safeStorage in main.
  cloudProvider: {
    saveKey: (providerId: string, key: string) => invoke('cloudProvider:saveKey', providerId, key),
    getKey: (providerId: string) => invoke('cloudProvider:getKey', providerId),
    deleteKey: (providerId: string) => invoke('cloudProvider:deleteKey', providerId),
    listModels: (providerId: string, baseUrl: string, authStyle: string) =>
      invoke('cloudProvider:listModels', providerId, baseUrl, authStyle),
  },
  // The one whole-object exhaustiveness check: every member of this object must
  // match the manifest-derived ElectronApi exactly (path, args, result) — a
  // channel missing or drifted on any side is a build error here.
} satisfies ElectronApi)
