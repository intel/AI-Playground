import {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  screen,
  IpcMainEvent,
  IpcMainInvokeEvent,
  dialog,
  OpenDialogSyncOptions,
  MessageBoxSyncOptions,
  MessageBoxOptions,
} from "electron";
import path from "node:path";
import fs from "fs";
import { exec, spawn, ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import koffi from 'koffi';
import sudo from "sudo-prompt";
import { PathsManager } from "./pathsManager";

// }
// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.js
// │
(process.env.DIST = path.join(__dirname, "../")),
  (process.env.VITE_PUBLIC = path.join(
    __dirname,
    app.isPackaged ? "../.." : "../../../public"
  ));

const externalRes = path.resolve(app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, "../../external/"));



// try {
//   fs.accessSync(externalRes, fs.constants.W_OK);
// } catch (ex) {
//   if ((ex as NodeJS.ErrnoException).code === 'EACCES') {
//     sudo.exec("AIGC.exe");
//     app.exit(0);
//   }
// }

const signleLock = app.requestSingleInstanceLock();

// Menu.setApplicationMenu(null);
let win: BrowserWindow | null;
// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
// const APP_TOOL_HEIGHT = 209;
const appSize = {
  width: 820,
  height: 128,
  maxChatContentHeight: 0,
};
const settings: LocalSettings = {
  apiHost: "http://127.0.0.1:9999",
  settingPath: "",
  isAdminExec: false,
  debug: 0,
  envType: "ultra",
  port: 59999
};


function loadSettings() {
  const settingPath = app.isPackaged
    ? path.join(process.resourcesPath, "settings.json")
    : path.join(__dirname, "../../external/settings-dev.json");

  if (fs.existsSync(settingPath)) {
    const loadSettings = JSON.parse(
      fs.readFileSync(settingPath, { encoding: "utf8" })
    );
    Object.keys(loadSettings).forEach((key) => {
      if (key in settings) {
        settings[key] = loadSettings[key];
      }
    });
  }
  settings.apiHost = `http://127.0.0.1:${settings.port}`;
}

async function createWindow() {
  win = new BrowserWindow({
    title: "AI PLAYGROUND",
    icon: path.join(process.env.VITE_PUBLIC, "app-ico.svg"),
    transparent: true,
    resizable: false,
    frame: false,
    // fullscreen: true,
    width: 1440,
    height: 951,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true
    },
  });


  const session = win.webContents.session;

  if (!app.isPackaged || settings.debug) {
    //Open devTool if the app is not packaged
    win.webContents.openDevTools({ mode: "detach", activate: true });
  }

  session.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({
      requestHeaders: {
        ...details.requestHeaders,
        Origin: "*",
      },
    });
  });
  session.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith(settings.apiHost)) {
      // if (details.method === "OPTIONS") {
      //   details.statusLine = "HTTP/1.1 200 OK";
      //   details.statusCode = 200;
      //   return callback(details);
      // }

      details.responseHeaders = {
        ...details.responseHeaders,
        "Access-Control-Allow-Origin": ["*"],
        "Access-Control-Allow-Methods": ["GET,POST"],
        "Access-Control-Allow-Headers": ["x-requested-with,Content-Type"],
      }
      callback(details);
    } else {
      return callback(details);
    }
  });

  win.webContents.session.setPermissionRequestHandler(
    (_, permission, callback) => {
      if (
        permission === "media" ||
        permission === "clipboard-sanitized-write"
        // permission === "clipboard-sanitized-write"
      ) {
        callback(true);
      } else {
        callback(false);
      }
    }
  );

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
    console.log("load url:" + VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(process.env.DIST, "index.html"));
  }

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:")) shell.openExternal(url);
    return { action: "deny" };
  });
}

function logMessage(message: string) {
  if (app.isPackaged) {
    fs.appendFileSync(path.join(externalRes, "debug.log"), message + "\r\n");
  } else {
    console.log(message);
  }
}

app.on("quit", async () => {
  if (signleLock) {
    app.releaseSingleInstanceLock();
  }
});
// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", async () => {
  try {
    await closeApiService();
  } catch {

  }
  if (process.platform !== "darwin") {
    app.quit();
    win = null;
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

function initEventHandle() {

  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) {
        win.restore();
      }
      win.focus();
    }
  });

  screen.on("display-metrics-changed", (event, display, changedMetrics) => {
    if (win) {
      win.setBounds({
        x: 0,
        y: 0,
        width: display.workAreaSize.width,
        height: display.workAreaSize.height,
      });
      win.webContents.send(
        "display-metrics-changed",
        display.workAreaSize.width,
        display.workAreaSize.height
      );
    }
  });

  ipcMain.handle("getLocalSettings", async () => {
    return {
      apiHost: settings.apiHost,
      showIndex: settings.showIndex,
      showBenchmark: settings.showBenchmark,
      isAdminExec: isAdmin(),
    };
  });

  ipcMain.handle("getWinSize", () => {
    return appSize;
  });

  ipcMain.on("openUrl", (event, url: string) => {
    return shell.openExternal(url);
  });

  ipcMain.handle(
    "setWinSize",
    (event: IpcMainInvokeEvent, width: number, height: number) => {
      const win = BrowserWindow.fromWebContents(event.sender)!;
      const winRect = win.getBounds();
      if (winRect.width != width || winRect.height != height) {
        const y = winRect.y + (winRect.height - height);
        win.setBounds({ x: winRect.x, y, width, height });
      }
    }
  );

  ipcMain.handle(
    "restorePathsSettings",
    (event: IpcMainInvokeEvent) => {
      const paths = app.isPackaged ? {
        "llm": "./resources/service/models/llm/checkpoints",
        "embedding": "./resources/service/models/llm/embedding",
        "stableDiffusion": "./resources/service/models/stable_diffusion/checkpoints",
        "inpaint": "./resources/service/models/stable_diffusion/inpaint",
        "lora": "./resources/service/models/stable_diffusion/lora",
        "vae": "./resources/service/models/stable_diffusion/vae"
      } : {
        "llm": "../service/models/llm/checkpoints",
        "embedding": "../service/models/llm/embedding",
        "stableDiffusion": "../service/models/stable_diffusion/checkpoints",
        "inpaint": "../service/models/stable_diffusion/inpaint",
        "lora": "../service/models/stable_diffusion/lora",
        "vae": "../service/models/stable_diffusion/vae"
      }
      pathsManager.updateModelPahts(paths);
    }
  );


  ipcMain.on("miniWindow", () => {
    if (win) {
      win.minimize();
    }
  });

  ipcMain.on("setFullScreen", (event: IpcMainEvent, enable: boolean) => {
    if (win) {
      win.setFullScreen(enable);
    }
  });

  ipcMain.on("exitApp", async () => {
    if (win) {
      win.close();
    }
  });

  ipcMain.on("saveImage", async (event: IpcMainEvent, url: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) { return; }
    const options = {
      title: "Save Image",
      defaultPath: path.join(app.getPath("documents"), "example.png"),
      filters: [{ name: "AIGC-Gennerate.png", extensions: ["png"] }],
    };

    try {
      const result = await dialog
        .showSaveDialog(win, options);
      if (!result.canceled && result.filePath) {
        if (fs.existsSync(result.filePath)) {
          fs.rmSync(result.filePath);
        }
        try {
          const response = await fetch(url);
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          fs.writeFileSync(result.filePath, buffer);
          console.log("File downloaded and saved:", result.filePath);
        } catch (error) {
          console.error("Download and save error:", error);
        }
      }
    } catch (err) {
      console.error(err);
    };
  });

  ipcMain.handle("showOpenDialog", async (event, options: OpenDialogSyncOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender)!;
    return await dialog
      .showOpenDialog(win, options);
  });

  ipcMain.handle("showMessageBox", async (event, options: MessageBoxOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender)!;
    return dialog.showMessageBox(win, options);
  });


  ipcMain.handle("showMessageBoxSync", async (event, options: MessageBoxSyncOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender)!;
    return dialog.showMessageBoxSync(win, options);
  });


  ipcMain.handle("existsPath", async (event, path: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) { return; }
    return fs.existsSync(path);
  });

  let pathsManager = new PathsManager(path.join(externalRes, app.isPackaged ? "model_config.json" : "model_config.dev.json"));

  ipcMain.handle("getInitSetting", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) { return; }
    return {
      apiHost:settings.apiHost,
      modelLists: pathsManager.sacanAll(),
      modelPaths: pathsManager.modelPaths,
      envType: settings.envType,
      isAdminExec: settings.isAdminExec,
      version: app.getVersion()
    };

  });

  ipcMain.handle("updateModelPaths", (event, modelPaths: ModelPaths) => {
    pathsManager.updateModelPahts(modelPaths);
    return pathsManager.sacanAll();
  });

  ipcMain.handle("refreshSDModles", (event) => {
    return pathsManager.scanSDModleLists();
  });

  ipcMain.handle("refreshInpaintModles", (event) => {
    return pathsManager.scanInpaint();
  });

  ipcMain.handle("refreshLora", (event) => {
    return pathsManager.scanLora();
  });

  ipcMain.handle("refreshLLMModles", (event) => {
    return pathsManager.scanLLMModles();
  });

  ipcMain.on("openImageWithSystem", (event, url: string) => {
    // Assuming 'settings' and 'externalRes' are properly defined
    let imagePath = url.replace(settings.apiHost + "/", ""); // Remove the API host part

    if (app.isPackaged) {
      // Resolve path relative to app when packaged
      imagePath = path.join(externalRes, "service", imagePath);
    } else {
      // Resolve path relative to current directory during development
      const cwd = app.getAppPath();
      const parent_dir = path.dirname(cwd);
      imagePath = path.join(parent_dir, "service", imagePath);
    }

    shell.openPath(imagePath)

  });

  ipcMain.on("selecteImage", (event, url: string) => {
    // Assuming 'settings' and 'externalRes' are properly defined
    let imagePath = url.replace(settings.apiHost + "/", ""); // Remove the API host part

    if (app.isPackaged) {
      // Resolve path relative to app when packaged
      imagePath = path.join(externalRes, "service", imagePath);
    } else {
      // Resolve path relative to current directory during development
      imagePath = path.join("..", "service", imagePath);
    }

    // Open the image with the default system image viewer
    if (process.platform === 'win32') {
      exec(`explorer.exe /select, "${imagePath}"`);
    } else {
      shell.showItemInFolder(imagePath)
    }

  })

}
const apiService: {
  webProcess: ChildProcess | null,
  normalExit: boolean
} = {
  webProcess: null,
  normalExit: true
}

function isProcessRunning(pid: number) {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    return false;
  }
}

function wakeupApiService() {
  const wordkDir = path.resolve(app.isPackaged ? path.join(process.resourcesPath, "service") : path.join(__dirname, "../../../service"));
  const baseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../../");
  const pythonExe = path.resolve(path.join(baseDir, "env/python.exe"));
  const newEnv = {
    "SYCL_ENABLE_DEFAULT_CONTEXTS": "1",
    "SYCL_CACHE_PERSISTENT": "1",
    "PYTHONIOENCODING": "utf-8"
  };

  if (settings.debug) {
    apiService.webProcess = spawn("cmd.exe", ["/c", pytonExe, "web_api.py", "--port", settings.port.toString()], {
      cwd: wordkDir,
      detached: true,
      windowsHide: false,
      env: Object.assign(process.env, newEnv)
    });
  } else {
    apiService.webProcess = spawn(pytonExe, ["web_api.py", "--port", settings.port.toString()], {
      cwd: wordkDir,
      windowsHide: true,
      env: Object.assign(process.env, newEnv)
    });
  }
}

function closeApiService() {
  apiService.normalExit = true;
  if (apiService.webProcess != null && apiService.webProcess.pid && isProcessRunning(apiService.webProcess.pid)) {
    apiService.webProcess.kill();
    apiService.webProcess = null;
  }
  return fetch(`${settings.apiHost}/api/applicationExit`);
}

ipcMain.on("openImageWin", (_: IpcMainEvent, url: string, title: string, width: number, height: number) => {
  const display = screen.getPrimaryDisplay();
  width += 32;
  height += 48;
  if (width > display.workAreaSize.width) {
    width = display.workAreaSize.width;
  }
  else if (height > display.workAreaSize.height) {
    height = display.workAreaSize.height;
  }
  const imgWin = new BrowserWindow({
    icon: path.join(process.env.VITE_PUBLIC, "app-ico.svg"),
    resizable: true,
    center: true,
    frame: true,
    width: width,
    height: height,
    autoHideMenuBar: true,
    show: false,
    parent: win || undefined,
    webPreferences: {
      devTools: false
    }
  });
  imgWin.setMenu(null);
  imgWin.loadURL(url);
  imgWin.once("ready-to-show", function () {
    imgWin.show();
    imgWin.setTitle(title);
  });
});

ipcMain.handle('showSaveDialog', async (event, options: Electron.SaveDialogOptions) => {
  dialog.showSaveDialog(options).then(result => {
    return result;
  }).catch(err => {
    console.error(err);
  });
});

function needAdminPermission() {
  return new Promise<boolean>((resolve) => {
    const filename = path.join(externalRes, `${randomUUID()}.txt`);
    fs.writeFile(filename, '', (err) => {
      if (err) {
        if (err && err.code == 'EPERM') {
          if (path.parse(externalRes).root == path.parse(process.env.windir!).root) {
            resolve && resolve(!isAdmin());
          }
        } else {
          resolve && resolve(false);
        }
      } else {
        fs.rmSync(filename);
        resolve && resolve(false);
      }
    });
  })
}

function isAdmin(): boolean {
  const lib = koffi.load("Shell32.dll");
  try {
    const IsUserAnAdmin = lib.func("IsUserAnAdmin", "bool", []);
    return IsUserAnAdmin();
  } finally {
    lib.unload();
  }
}

app.whenReady().then(async () => {
  /*
  The current user does not have write permission for files in the program directory and is not an administrator. 
  Close the current program and let the user start the program with administrator privileges
  */
  if (await needAdminPermission()) {
    if (signleLock) {
      app.releaseSingleInstanceLock();
    }
    //It is possible that the program is installed in a directory that requires administrator privileges
    const message = `start "" "${process.argv.join(' ').trim()}`;
    sudo.exec(message, (err, stdout, stderr) => {
      app.exit(0);
    });
    return;
  }



  /**Single instance processing */
  if (!signleLock) {
    dialog.showMessageBoxSync({
      message: app.getLocale() == "zh-CN" ? "本程序仅允许单实例运行，确认后本次运行将自动结束" : "This program only allows a single instance to run, and the run will automatically end after confirmation",
      title: "error",
      type: "error"
    });
    app.exit();
  } else {
    loadSettings();
    initEventHandle();
    createWindow();
    wakeupApiService();
  }
});
