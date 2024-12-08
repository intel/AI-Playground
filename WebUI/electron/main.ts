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
import {exec, spawn, ChildProcess, spawnSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import koffi from 'koffi';
import sudo from "sudo-prompt";
import {PathsManager} from "./pathsManager";
import getPort, {portNumbers} from "get-port";
import {DefaultBackend} from "./subprocesses/apiService.ts";

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
process.env.DIST = path.join(__dirname, "../");
process.env.VITE_PUBLIC = path.join(__dirname, app.isPackaged ? "../.." : "../../../public");

const externalRes = path.resolve(app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../external/"));
const baseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../../");
const singleInstanceLock = app.requestSingleInstanceLock();

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

export const settings: LocalSettings = {
    apiHost: "http://127.0.0.1:9999",
    isAdminExec: false,
    debug: 0,
    envType: "ultra",
    port: 59999,
    comfyUiParameters: [
        "--lowvram",
        "--disable-ipex-optimize",
        "--bf16-unet",
        "--reserve-vram",
        "4.0"
    ],
    availableThemes: ["dark", "lnl"],
    currentTheme: "lnl"
};

const comfyuiState = {
    currentVersion: null,
    port: 0,
}

let webContentsFinishedLoad = false;
const startupMessageCache: {
    message: string,
    source: 'electron-backend' | 'ai-backend' | 'comfyui-backend',
    level: 'error' | 'warn' | 'info'
}[] = []

const logger = {
    info: (message: string, source: 'electron-backend' | 'ai-backend' | 'comfyui-backend' = 'electron-backend') => {
        console.info(`[${source}]: ${message}`);
        if (webContentsFinishedLoad) {
            try {
                win?.webContents.send('debugLog', {level: 'info', source, message})
            } catch (error) {
                console.error('Could not send debug log to renderer process');
            }
        } else {
            startupMessageCache.push({level: 'info', source, message})
        }
    },
    warn: (message: string, source: 'electron-backend' | 'ai-backend' | 'comfyui-backend' = 'electron-backend') => {
        console.warn(`[${source}]: ${message}`);
        if (webContentsFinishedLoad) {
            try {
                win?.webContents.send('debugLog', {level: 'warn', source, message})
            } catch (error) {
                console.error('Could not send debug log to renderer process');
            }
        } else {
            startupMessageCache.push({level: 'error', source, message})
        }
    },
    error: (message: string, source: 'electron-backend' | 'ai-backend' | 'comfyui-backend' = 'electron-backend') => {
        console.error(`[${source}]: ${message}`);
        if (webContentsFinishedLoad) {
            try {
                win?.webContents.send('debugLog', {level: 'error', source, message})
            } catch (error) {
                console.error('Could not send debug log to renderer process');
            }
        } else {
            startupMessageCache.push({level: 'error', source, message})
        }
    }
}

async function loadSettings() {
    const settingPath = app.isPackaged
        ? path.join(process.resourcesPath, "settings.json")
        : path.join(__dirname, "../../external/settings-dev.json");

    if (fs.existsSync(settingPath)) {
        const loadSettings = JSON.parse(
            fs.readFileSync(settingPath, {encoding: "utf8"})
        );
        Object.keys(loadSettings).forEach((key) => {
            if (key in settings) {
                settings[key] = loadSettings[key];
            }
        });
    }
    settings.port = await getPort({port: portNumbers(59000, 59999)});
    comfyuiState.port = await getPort({port: portNumbers(59000, 59999)});
    settings.apiHost = `http://127.0.0.1:${settings.port}`;
}

async function createWindow() {
    win = new BrowserWindow({
        title: "AI PLAYGROUND",
        icon: path.join(process.env.VITE_PUBLIC, "app-ico.svg"),
        transparent: false,
        resizable: true,
        frame: false,
        // fullscreen: true,
        width: 1440,
        height: 951,
        webPreferences: {
            preload: path.join(__dirname, "../preload/preload.js"),
            contextIsolation: true
        },
    });
    win.webContents.on('did-finish-load', () => {
        setTimeout(() => {
            webContentsFinishedLoad = true;
            startupMessageCache.forEach((logEntry) => {
                win?.webContents.send('debugLog', logEntry)
            });
        }, 100);
    })

    const session = win.webContents.session;

    if (!app.isPackaged || settings.debug) {
        //Open devTool if the app is not packaged
        win.webContents.openDevTools({mode: "detach", activate: true});
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
        if (details.url.match(/^http:\/\/(localhost|127.0.0.1)/)) {
            // if (details.method === "OPTIONS") {
            //   details.statusLine = "HTTP/1.1 200 OK";
            //   details.statusCode = 200;
            //   return callback(details);
            // }

            details.responseHeaders = {
                ...details.responseHeaders,
                "Access-Control-Allow-Origin": ["*"],
                "Access-Control-Allow-Methods": ["GET,POST"],
                "Access-Control-Allow-Headers": ["x-requested-with,Content-Type,Authorization"],
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
        await win.loadURL(VITE_DEV_SERVER_URL);
        logger.info("load url:" + VITE_DEV_SERVER_URL);
    } else {
        await win.loadFile(path.join(process.env.DIST, "index.html"));
    }

    // Make all links open with the browser, not with the application
    win.webContents.setWindowOpenHandler(({url}) => {
        if (url.startsWith("https:")) shell.openExternal(url);
        return {action: "deny"};
    });
}

function logMessage(message: string) {
    if (app.isPackaged) {
        fs.appendFileSync(path.join(externalRes, "debug.log"), message + "\r\n");
    } else {
        logger.info(message);
    }
}

app.on("quit", async () => {
    if (singleInstanceLock) {
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

app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (win && !win.isDestroyed()) {
        if (win.isMinimized()) {
            win.restore();
        }
        win.focus();
    }
});


function initEventHandle() {
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

    ipcMain.handle("getThemeSettings", async () => {
        return {
            availableThemes: settings.availableThemes,
            currentTheme: settings.currentTheme

        };
    });

    ipcMain.on("wakeupComfyUIService", async () => {
        console.log("starting comfyUI")
        wakeupComfyUIService()
    });

    ipcMain.handle("getLocalSettings", async () => {
        return {
            apiHost: settings.apiHost,
            showIndex: settings.showIndex,
            showBenchmark: settings.showBenchmark,
            isAdminExec: isAdmin(),
            locale: app.getLocale(),
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
                win.setBounds({x: winRect.x, y, width, height});
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
        if (!win) {
            return;
        }
        const options = {
            title: "Save Image",
            defaultPath: path.join(app.getPath("documents"), "example.png"),
            filters: [{name: "AIGC-Gennerate.png", extensions: ["png"]}],
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
                    logger.info(`File downloaded and saved: ${result.filePath}`);
                } catch (error) {
                    logger.error(`Download and save error: ${JSON.stringify(error, Object.getOwnPropertyNames, 2)}`);
                }
            }
        } catch (error) {
            logger.error(`${JSON.stringify(error, Object.getOwnPropertyNames, 2)}`);
        }
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
        if (!win) {
            return;
        }
        return fs.existsSync(path);
    });

    ipcMain.handle("getPythonBackendStatus", () => apiService.status)

    let pathsManager = new PathsManager(path.join(externalRes, app.isPackaged ? "model_config.json" : "model_config.dev.json"));

    ipcMain.handle("getInitSetting", (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) {
            return;
        }
        return {
            apiHost: settings.apiHost,
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

    ipcMain.handle("refreshEmbeddingModels", (event) => {
        return pathsManager.scanEmbedding();
    });

    ipcMain.handle("getDownloadedDiffusionModels", (event) => {
        return pathsManager.scanSDModleLists(false);
    });

    ipcMain.handle("getDownloadedInpaintModels", (event) => {
        return pathsManager.scanInpaint(false);
    });

    ipcMain.handle("getDownloadedLoras", (event) => {
        return pathsManager.scanLora(false);
    });

    ipcMain.handle("getDownloadedLLMs", (event) => {
        return pathsManager.scanLLMModles(false);
    });

    ipcMain.handle("getDownloadedEmbeddingModels", (event) => {
        return pathsManager.scanEmbedding(false);
    });

    ipcMain.on("openDevTools", () => {
        win?.webContents.openDevTools({mode: "detach", activate: true});
    });

    ipcMain.handle("getComfyuiState", () => {
        return comfyuiState;
    });

    ipcMain.handle("updateComfyui", () => {
        return;
    });

    ipcMain.handle("reloadImageWorkflows", () => {
        const files = fs.readdirSync(path.join(externalRes, "workflows"));
        const workflows = files.map((file) => fs.readFileSync(path.join(externalRes, "workflows", file), {encoding: "utf-8"}));
        return workflows;
    });

    ipcMain.handle("startComfyui", () => {
        console.log('startComfyui')
        return;
    });

    const getImagePathFromUrl = (url: string) => {
        const imageUrl = URL.parse(url)
        if (!imageUrl) {
            console.error('Could not find image for URL', {url})
            return;
        }
        const backend = url.includes(settings.apiHost) ? 'service' : 'ComfyUI';

        let imagePath: string;
        if (backend === 'service') {
            imagePath = imageUrl.pathname.replace(/^\/*/, '')
        } else {
            const s = imageUrl.searchParams;
            imagePath = `static/sd_out/${s.get('filename')}`
        }

        return path.join(externalRes, 'service', imagePath);
    }

    ipcMain.on("openImageWithSystem", (event, url: string) => {
        const imagePath = getImagePathFromUrl(url);
        if (!imagePath) return;
        shell.openPath(imagePath)
    });

    ipcMain.on("selecteImage", (event, url: string) => {
        const imagePath = getImagePathFromUrl(url);
        if (!imagePath) return;

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
    normalExit: boolean,
    status: BackendStatus,
    desiredState: 'running' | 'stopped'
} = {
    webProcess: null,
    normalExit: true,
    status: {status: "starting"},
    desiredState: 'running'
}

function isProcessRunning(pid: number) {
    try {
        return process.kill(pid, 0);
    } catch (error) {
        return false;
    }
}

function getSupportedDeviceEnvVariable() {
    // Filter out unsupported devices
    try {
        const lsLevelZeroDevices = path.resolve(path.join(baseDir, "service/tools/ls_level_zero.exe"));
        // copy ls_level_zero.exe to env/Library/bin for SYCL environment
        const dest = path.resolve(path.join(pythonExe, "../Library/bin/ls_level_zero.exe"));
        fs.copyFileSync(lsLevelZeroDevices, dest);
        const ls = spawnSync(dest);
        logger.info(`ls_level_zero.exe stdout: ${ls.stdout.toString()}`);
        const devices: {name: string, device_id: number, id: string}[] = JSON.parse(ls.stdout.toString()); // TODO: use zod to parse output
        const supportedIDs = devices.filter(device => device.name.toLowerCase().includes("arc") || device.device_id === 0xE20B).map(device => device.id);
        const additionalEnvVariables = {ONEAPI_DEVICE_SELECTOR: "level_zero:" + supportedIDs.join(",")};
        logger.info(`Set ONEAPI_DEVICE_SELECTOR=${additionalEnvVariables["ONEAPI_DEVICE_SELECTOR"]}`);
        return additionalEnvVariables;
    } catch (error) {
        logger.error(`Failed to detect Level Zero devices: ${error}`);
        return {ONEAPI_DEVICE_SELECTOR:"level_zero:*"};
    }
}

async function wakeupApiService(settings: LocalSettings) {
    const backend = new DefaultBackend(settings.port.toString())
    const startupPromise = backend.start()
    const severState = await startupPromise
    logger.info(`server started in state: ${severState.status}`)
}

function wakeupComfyUIService() {
    const comfyWordkDir = path.resolve(app.isPackaged ? path.join(process.resourcesPath, "ComfyUI") : path.join(__dirname, "../../../ComfyUI"));
    const baseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../../");
    const pythonExe = path.resolve(path.join(baseDir, "env/python.exe"));
    const additionalEnvVariables = {
        "SYCL_ENABLE_DEFAULT_CONTEXTS": "1",
        "SYCL_CACHE_PERSISTENT": "1",
        "PYTHONIOENCODING": "utf-8",
        "ONEAPI_DEVICE_SELECTOR": "level_zero:*"
    };
async function writeComfyExtraModelsConfig(aipgBasePath: string, comfyUiPath: string) {
  const extraModelsYaml = `aipg:
  base_path: ${path.resolve(aipgBasePath, 'service/models/stable_diffusion')}
  checkpoints: checkpoints
  clip: checkpoints
  vae: checkpoints
  unet: checkpoints
  loras: lora`
  await fs.promises.writeFile(path.join(comfyUiPath, 'extra_model_paths.yaml'), extraModelsYaml, {encoding: 'utf-8', flag: 'w'});
 return
}


async function wakeupComfyUIService() {
  const comfyWorkDir = path.resolve(path.join(baseDir, "ComfyUI"));
  await writeComfyExtraModelsConfig(baseDir, comfyWorkDir);
  const additionalEnvVariables = {
    "SYCL_ENABLE_DEFAULT_CONTEXTS": "1",
    "SYCL_CACHE_PERSISTENT": "1",
    "PYTHONIOENCODING": "utf-8",
    ...getSupportedDeviceEnvVariable(),
  };

    spawnComfy(pythonExe, comfyWordkDir, additionalEnvVariables);
}


function spawnAPI(pythonExe: string, wordkDir: string, additionalEnvVariables: Record<string, string>, tries = 0) {
    if (apiService.desiredState === 'stopped') return;
    tries++;
    let stderrData = '';
    let maxTries = 2;
    logger.info(`#${tries} try to start python API`)

    const webProcess = spawn(pythonExe, ["web_api.py", "--port", settings.port.toString()], {
        cwd: wordkDir,
        windowsHide: true,
        env: Object.assign(process.env, additionalEnvVariables)
    });

    apiService.webProcess = webProcess;

    const handleFailure = (err: Error | null, code: number | null) => {
        logger.error(`Error: ${err || `Process exited with code ${code}`}`);
        if (tries < maxTries) {
            spawnAPI(pythonExe, wordkDir, additionalEnvVariables, tries);
        } else {
            apiService.status = {status: "stopped"};
            logger.error(`Maximum attempts reached. Giving up.`);
            if (webProcess.stderr != null) {
                // TODO: catch + retry
                logger.info(`stderrData: ${stderrData}`);
                win?.webContents.send('reportError', stderrData);
                //throw new Error(`Backend could not start:\n ${stderrData}`)
            }
        }
    };

    apiService.status = {status: "running"};

    webProcess.on('error', (err) => handleFailure(err, null));
    webProcess.on('exit', (code, signal) => handleFailure(null, code));
    webProcess.stderr?.on('data', (data) => {
        stderrData = data.toString();
    });

    webProcess.stdout.on('data', (message) => {
        if (message.toString().startsWith('INFO')) {
            logger.info(`${message}`, 'ai-backend')
        } else if (message.toString().startsWith('WARN')) {
            logger.warn(`${message}`, 'ai-backend')
        } else {
            logger.error(`${message}`, 'ai-backend')
        }
    })
    webProcess.stderr.on('data', (message) => {
        logger.error(`${message}`, 'ai-backend')
    })
}

function spawnComfy(pythonExe: string, wordkDir: string, additionalEnvVariables: Record<string, string>, tries = 0) {
    logger.info(`#1 try to start ComfyUI API`)

    const webProcess = spawn(pythonExe, ["main.py", "--port", comfyuiState.port.toString(), "--preview-method", "auto", "--output-directory", "../service/static/sd_out", ...settings.comfyUiParameters], {
        cwd: wordkDir,
        windowsHide: true,
        env: Object.assign(process.env, additionalEnvVariables)
    });

    webProcess.stdout.on('data', (message) => {
        logger.info(`${message}`, 'comfyui-backend')
    })
    webProcess.stderr.on('data', (message) => {
        logger.info(`${message}`, 'comfyui-backend')
    })
}


function closeApiService() {
    apiService.normalExit = true;
    apiService.desiredState = 'stopped';
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
    } else if (height > display.workAreaSize.height) {
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
    }).catch(error => {
        logger.error(`${JSON.stringify(error, Object.getOwnPropertyNames, 2)}`);
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
        if (singleInstanceLock) {
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
    if (!singleInstanceLock) {
        dialog.showMessageBoxSync({
            message: app.getLocale() == "zh-CN" ? "本程序仅允许单实例运行，确认后本次运行将自动结束" : "This program only allows a single instance to run, and the run will automatically end after confirmation",
            title: "error",
            type: "error"
        });
        app.exit();
    } else {
        await loadSettings();
        initEventHandle();
        await createWindow();
        await wakeupApiService(settings);
    }
});
