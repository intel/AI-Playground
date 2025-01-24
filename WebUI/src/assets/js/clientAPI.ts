  export const isClient = window.chrome.webview &&
    window.chrome.webview.hostObjects &&
    window.chrome.webview.hostObjects.clientAPI;


  export function minimizedWin() {
    window.electronAPI.miniWindow();
  }

  export function exitApp() {
    window.electronAPI.exitApp();
  }

  export function setWinSize(width: number, height: number) {
    return window.electronAPI.setWinSize(width,height)
  }


  export function showOpenDialog(options: Electron.OpenDialogOptions) {
    return window.electronAPI.showOpenDialog(options);
  }

  export function showSaveDialog(options: Electron.SaveDialogOptions) {
    return window.electronAPI.showSaveDialog(options);
  }


  export function saveImage(url: string) {
    return window.electronAPI.saveImage(url)
  }
