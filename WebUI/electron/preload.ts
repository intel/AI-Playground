import { contextBridge, ipcRenderer, dialog } from "electron";
import pkg from "../package.json";

contextBridge.exposeInMainWorld("envVars", {
  platformTitle: import.meta.env.VITE_PLATFORM_TITLE,
  productVersion: pkg.version,
});
contextBridge.exposeInMainWorld("electronAPI", {
  getServices: () => ipcRenderer.invoke("getServices"),
      sendStartSignal: (serviceName: string) => ipcRenderer.invoke("sendStartSignal", serviceName),
  sendStopSignal: (serviceName: string) => ipcRenderer.invoke("sendStopSignal", serviceName),
  sendSetUpSignal: (serviceName: string) => ipcRenderer.invoke("sendSetUpSignal", serviceName),
  reloadImageWorkflows: () => ipcRenderer.invoke("reloadImageWorkflows"),
  openDevTools: () => ipcRenderer.send("openDevTools"),
  openUrl: (url: string) => ipcRenderer.send("openUrl", url),
  getLocalSettings: () => ipcRenderer.invoke("getLocalSettings"),
  getThemeSettings: () => ipcRenderer.invoke("getThemeSettings"),
  getWinSize: () => ipcRenderer.invoke("getWinSize"),
  setWinSize: (width: number, height: number) =>
    ipcRenderer.invoke("setWinSize", width, height),
  showSaveDialog: (options: Electron.SaveDialogOptions) =>
    ipcRenderer.invoke("showSaveDialog", options),
  showMessageBox: (options: Electron.MessageBoxOptions) =>
    ipcRenderer.invoke("showMessageBox", options),
  showMessageBoxSync: (options: Electron.MessageBoxSyncOptions) =>
    ipcRenderer.invoke("showMessageBox", options),
  dragWinToMoveStart: (x: number, y: number) =>
    ipcRenderer.send("dragWinToMoveStart", x, y),
  dragWinToMove: (x: number, y: number) =>
    ipcRenderer.send("dragWinToMove", x, y),
  dragWinToMoveStop: () => ipcRenderer.send("dragWinToMoveStop"),
  setIgnoreMouseEvents: (igrnore: boolean) =>
    ipcRenderer.send("setIgnoreMouseEvents", igrnore),
  miniWindow: () => ipcRenderer.send("miniWindow"),
  exitApp: () => ipcRenderer.send("exitApp"),
  showOpenDialog: (options: Electron.OpenDialogOptions) => ipcRenderer.invoke("showOpenDialog", options),
  reportClientEvent: (eventId: number) => ipcRenderer.send("reportClientEvent", eventId),
  saveImage: (url: string) => ipcRenderer.send("saveImage", url),
  wakeupApiService: () => ipcRenderer.send("wakeupApiService"),
  openImageWin: (url: string, title: string, width: number, height: number) =>
    ipcRenderer.send("openImageWin", url, title, width, height),
  screenChange: (callback: (width: number, height: number) => void) =>
    ipcRenderer.on(
      "display-metrics-changed",
      (_event, width: number, height: number) => callback(width, height)
    ),
  webServiceExit: (callback: (seriveName: string, normalExit: boolean) => void) =>
    ipcRenderer.on(
      "webServiceExit",
      (_event, seriveName: string, normalExit: boolean) => callback(seriveName, normalExit)
    ),
  existsPath: (path: string) => ipcRenderer.invoke("existsPath", path),
  getInitSetting: () => ipcRenderer.invoke("getInitSetting"),
  updateModelPaths: (modelPaths: ModelPaths) => ipcRenderer.invoke("updateModelPaths", modelPaths),
  restorePathsSettings :()=>ipcRenderer.invoke("restorePathsSettings"),
  refreshSDModles: () => ipcRenderer.invoke("refreshSDModles"),
  refreshInpaintModles: () => ipcRenderer.invoke("refreshInpaintModles"),
  refreshLLMModles: () => ipcRenderer.invoke("refreshLLMModles"),
  refreshLora: () => ipcRenderer.invoke("refreshLora"),
  refreshEmbeddingModels: () => ipcRenderer.invoke("refreshEmbeddingModels"),
  getDownloadedDiffusionModels: () => ipcRenderer.invoke("getDownloadedDiffusionModels"),
  getDownloadedInpaintModels: () => ipcRenderer.invoke("getDownloadedInpaintModels"),
  getDownloadedLoras: () => ipcRenderer.invoke("getDownloadedLoras"),
  getDownloadedLLMs: () => ipcRenderer.invoke("getDownloadedLLMs"),
  getDownloadedEmbeddingModels: () => ipcRenderer.invoke("getDownloadedEmbeddingModels"),
  openImageWithSystem: (url: string) => ipcRenderer.send("openImageWithSystem", url),
  selecteImage: (url: string) => ipcRenderer.send("selecteImage", url),
  setFullScreen: (enable: boolean) => ipcRenderer.send("setFullScreen", enable),
  onDebugLog: (callback: (data: { level: string, source: string, message: string}) => void) => ipcRenderer.on('debugLog', (_event, value) => callback(value)),
  wakeupComfyUIService: () => ipcRenderer.send('wakeupComfyUIService'),
  onServiceSetUpProgress: (callback: (data: SetupProgress) => void) => ipcRenderer.on('serviceSetUpProgress', (_event, value) => callback(value)),
  onServiceInfoUpdate: (callback: (service: ApiServiceInformation) => void) => ipcRenderer.on('serviceInfoUpdate', (_event, value) => callback(value)),
});
