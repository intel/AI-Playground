import { contextBridge, ipcRenderer, webUtils } from 'electron'
import pkg from '../package.json'
import { ModelPaths } from '@/assets/js/store/models'
import { EmbedInquiry, IndexedDocument } from '@/assets/js/store/textInference'

contextBridge.exposeInMainWorld('envVars', {
  platformTitle: import.meta.env.VITE_PLATFORM_TITLE,
  debugToolsEnabled: import.meta.env.VITE_DEBUG_TOOLS === 'true',
  productVersion: pkg.version,
})
contextBridge.exposeInMainWorld('electronAPI', {
  startDrag: (fileName: string) => ipcRenderer.send('ondragstart', fileName),
  getFilePath: (file: File) => webUtils.getPathForFile(file),
  getServices: () => ipcRenderer.invoke('getServices'),
  updateServiceSettings: (settings: ServiceSettings) =>
    ipcRenderer.invoke('updateServiceSettings', settings),
  getServiceSettings: (serviceName: string) =>
    ipcRenderer.invoke('getServiceSettings', serviceName),
  uninstall: (serviceName: string) => ipcRenderer.invoke('uninstall', serviceName),
  selectDevice: (serviceName: string, deviceId: string) =>
    ipcRenderer.invoke('selectDevice', serviceName, deviceId),
  detectDevices: (serviceName: string) => ipcRenderer.invoke('detectDevices', serviceName),
  sendStartSignal: (serviceName: string) => ipcRenderer.invoke('sendStartSignal', serviceName),
  sendStopSignal: (serviceName: string) => ipcRenderer.invoke('sendStopSignal', serviceName),
  sendSetUpSignal: (serviceName: string) => ipcRenderer.invoke('sendSetUpSignal', serviceName),
  updateWorkflowsFromIntelRepo: () => ipcRenderer.invoke('updateWorkflowsFromIntelRepo'),
  reloadImageWorkflows: () => ipcRenderer.invoke('reloadImageWorkflows'),
  openDevTools: () => ipcRenderer.send('openDevTools'),
  openUrl: (url: string) => ipcRenderer.send('openUrl', url),
  getLocalSettings: () => ipcRenderer.invoke('getLocalSettings'),
  getThemeSettings: () => ipcRenderer.invoke('getThemeSettings'),
  getWinSize: () => ipcRenderer.invoke('getWinSize'),
  setWinSize: (width: number, height: number) => ipcRenderer.invoke('setWinSize', width, height),
  showSaveDialog: (options: Electron.SaveDialogOptions) =>
    ipcRenderer.invoke('showSaveDialog', options),
  showMessageBox: (options: Electron.MessageBoxOptions) =>
    ipcRenderer.invoke('showMessageBox', options),
  showMessageBoxSync: (options: Electron.MessageBoxSyncOptions) =>
    ipcRenderer.invoke('showMessageBox', options),
  dragWinToMoveStart: (x: number, y: number) => ipcRenderer.send('dragWinToMoveStart', x, y),
  dragWinToMove: (x: number, y: number) => ipcRenderer.send('dragWinToMove', x, y),
  dragWinToMoveStop: () => ipcRenderer.send('dragWinToMoveStop'),
  setIgnoreMouseEvents: (igrnore: boolean) => ipcRenderer.send('setIgnoreMouseEvents', igrnore),
  miniWindow: () => ipcRenderer.send('miniWindow'),
  exitApp: () => ipcRenderer.send('exitApp'),
  getMediaUrlBase: () => ipcRenderer.invoke('getMediaUrlBase'),
  getInitialPage: () => ipcRenderer.invoke('getInitialPage'),
  getDemoModeSettings: () => ipcRenderer.invoke('getDemoModeSettings'),
  showOpenDialog: (options: Electron.OpenDialogOptions) =>
    ipcRenderer.invoke('showOpenDialog', options),
  reportClientEvent: (eventId: number) => ipcRenderer.send('reportClientEvent', eventId),
  saveImage: (url: string) => ipcRenderer.send('saveImage', url),
  wakeupApiService: () => ipcRenderer.send('wakeupApiService'),
  openImageWin: (url: string, title: string, width: number, height: number) =>
    ipcRenderer.send('openImageWin', url, title, width, height),
  screenChange: (callback: (width: number, height: number) => void) =>
    ipcRenderer.on('display-metrics-changed', (_event, width: number, height: number) =>
      callback(width, height),
    ),
  webServiceExit: (callback: (seriveName: string, normalExit: boolean) => void) =>
    ipcRenderer.on('webServiceExit', (_event, seriveName: string, normalExit: boolean) =>
      callback(seriveName, normalExit),
    ),
  existsPath: (path: string) => ipcRenderer.invoke('existsPath', path),
  addDocumentToRAGList: (doc: IndexedDocument) => ipcRenderer.invoke('addDocumentToRAGList', doc),
  embedInputUsingRag: (embedInquiry: EmbedInquiry) =>
    ipcRenderer.invoke('embedInputUsingRag', embedInquiry),
  getInitSetting: () => ipcRenderer.invoke('getInitSetting'),
  updateModelPaths: (modelPaths: ModelPaths) => ipcRenderer.invoke('updateModelPaths', modelPaths),
  restorePathsSettings: () => ipcRenderer.invoke('restorePathsSettings'),
  refreshSDModles: () => ipcRenderer.invoke('refreshSDModles'),
  refreshInpaintModles: () => ipcRenderer.invoke('refreshInpaintModles'),
  refreshLLMModles: () => ipcRenderer.invoke('refreshLLMModles'),
  refreshLora: () => ipcRenderer.invoke('refreshLora'),
  getDownloadedDiffusionModels: () => ipcRenderer.invoke('getDownloadedDiffusionModels'),
  getDownloadedInpaintModels: () => ipcRenderer.invoke('getDownloadedInpaintModels'),
  getDownloadedLoras: () => ipcRenderer.invoke('getDownloadedLoras'),
  getDownloadedLLMs: () => ipcRenderer.invoke('getDownloadedLLMs'),
  getDownloadedGGUFLLMs: () => ipcRenderer.invoke('getDownloadedGGUFLLMs'),
  getDownloadedOpenVINOLLMModels: () => ipcRenderer.invoke('getDownloadedOpenVINOLLMModels'),
  getDownloadedEmbeddingModels: () => ipcRenderer.invoke('getDownloadedEmbeddingModels'),
  openImageWithSystem: (url: string) => ipcRenderer.send('openImageWithSystem', url),
  openImageInFolder: (url: string) => ipcRenderer.send('openImageInFolder', url),
  setFullScreen: (enable: boolean) => ipcRenderer.send('setFullScreen', enable),
  onDebugLog: (callback: (data: { level: string; source: string; message: string }) => void) =>
    ipcRenderer.on('debugLog', (_event, value) => callback(value)),
  wakeupComfyUIService: () => ipcRenderer.send('wakeupComfyUIService'),
  onServiceSetUpProgress: (callback: (data: SetupProgress) => void) =>
    ipcRenderer.on('serviceSetUpProgress', (_event, value) => callback(value)),
  onServiceInfoUpdate: (callback: (service: ApiServiceInformation) => void) =>
    ipcRenderer.on('serviceInfoUpdate', (_event, value) => callback(value)),
  ensureBackendReadiness: (
    serviceName: string,
    llmModelName: string,
    embeddingModelName?: string,
  ) => ipcRenderer.invoke('ensureBackendReadiness', serviceName, llmModelName, embeddingModelName),
})
