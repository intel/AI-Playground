import { contextBridge, ipcRenderer, dialog } from "electron";
import pkg from "../package.json";

// function domReady(
//   condition: DocumentReadyState[] = ["complete", "interactive"]
// ) {
//   return new Promise((resolve) => {
//     if (condition.includes(document.readyState)) {
//       resolve(true);
//     } else {
//       document.addEventListener("readystatechange", () => {
//         if (condition.includes(document.readyState)) {
//           resolve(true);
//         }
//       });
//     }
//   });
// }

// const safeDOM = {
//   append(parent: HTMLElement, child: HTMLElement) {
//     if (!Array.from(parent.children).find((e) => e === child)) {
//       return parent.appendChild(child);
//     }
//   },
//   remove(parent: HTMLElement, child: HTMLElement) {
//     if (Array.from(parent.children).find((e) => e === child)) {
//       return parent.removeChild(child);
//     }
//   },
// };

// /**
//  * https://tobiasahlin.com/spinkit
//  * https://connoratherton.com/loaders
//  * https://projects.lukehaas.me/css-loaders
//  * https://matejkustec.github.io/SpinThatShit
//  */
// function useLoading() {
//   const styleContent = `
//     @keyframes ronate {
//         0% {
//             transform: rotate(0deg);
//         }
//         100% {
//             transform: rotate(360deg);
//         }
//     }
//     .animate_ronate {
//         animation-name: ronate;
//         animation-duration: 1s;
//         animation-iteration-count: infinite;
//     }
//     .app-loading-wrap {
//         position: fixed;
//         left: 50%;
//         bottom: 0px;
//         width: 456px;
//         height: 128px;
//         margin-left:-218px;
//         display: flex;
//         align-items: center;
//         justify-content: center;
//         background: rgba(244, 244, 244, 0.75);
//         box-shadow: 0px 0px 10px 0px rgba(0, 0, 0, 0.25);
//         z-index: 9;
//         gap:8px;
//         border-radius: 10px;
//     }
//         `;
//   const oStyle = document.createElement("style");
//   const oDiv = document.createElement("div");

//   oStyle.id = "app-loading-style";
//   oStyle.innerHTML = styleContent;
//   oDiv.classList.add("app-loading-wrap");
//   oDiv.innerHTML = `
//         <svg class="animate_ronate" t="1676626350062" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="2790" width="32" height="32">
//             <path d="M270.4 214.4C336 160 420 128 512 128c212 0 384 172 384 384h64c0-247.2-200.8-448-448-448-107.2 0-205.6 37.6-282.4 100l40.8 50.4z" p-id="2791">
//             </path>
//         </svg>loading`;

//   return {
//     appendLoading() {
//       safeDOM.append(document.head, oStyle);
//       safeDOM.append(document.body, oDiv);
//     },
//     removeLoading() {
//       safeDOM.remove(document.head, oStyle);
//       safeDOM.remove(document.body, oDiv);
//     },
//   };
// }

// // ----------------------------------------------------------------------

// const { appendLoading, removeLoading } = useLoading();

// window.onmessage = (ev) => {
//   ev.data === "removeLoading" && removeLoading();
// };

// domReady().then(appendLoading);

contextBridge.exposeInMainWorld("envVars", {
  platformTitle: import.meta.env.VITE_PLATFORM_TITLE,
  productVersion: pkg.version,
});
contextBridge.exposeInMainWorld("electronAPI", {
  getComfyuiState: () => ipcRenderer.invoke("getComfyuiState"),
  getServiceRegistry: () => ipcRenderer.invoke("getServiceRegistry"),
  sendStartSignal: (serviceName: string) => ipcRenderer.invoke("sendStartSignal", serviceName),
  sendStopSignal: (serviceName: string) => ipcRenderer.invoke("sendStopSignal", serviceName),
  sendSetUpSignal: (serviceName: string) => ipcRenderer.invoke("sendSetUpSignal", serviceName),
  updateComfyui: () => ipcRenderer.invoke("updateComfyui"),
  startComfyui: () => ipcRenderer.invoke("startComfyui"),
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
  getPythonBackendStatus: () => ipcRenderer.invoke("getPythonBackendStatus"),
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
  onReportError: (callback: (errorMessage: string) => void) => ipcRenderer.on('reportError', (_event, value) => callback(value)),
  onDebugLog: (callback: (data: { level: string, source: string, message: string}) => void) => ipcRenderer.on('debugLog', (_event, value) => callback(value)),
  wakeupComfyUIService: () => ipcRenderer.send('wakeupComfyUIService'),
  onServiceSetUpProgress: (callback: (data: SetupProgress) => void) => ipcRenderer.on('serviceSetUpProgress', (_event, value) => callback(value))
});
