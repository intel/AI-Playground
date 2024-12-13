import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    IpcMainEvent,
    IpcMainInvokeEvent,
    MessageBoxOptions,
    MessageBoxSyncOptions,
    OpenDialogSyncOptions,
    screen,
    shell,
} from "electron";
import path from "node:path";
import fs from "fs";
import {exec} from "node:child_process";
import {randomUUID} from "node:crypto";
import koffi from 'koffi';
import sudo from "sudo-prompt";
import {PathsManager} from "./pathsManager";
import {appLoggerInstance} from "./logging/logger.ts";
import {aiplaygroundApiServiceRegistry, ApiServiceRegistryImpl} from "./subprocesses/apiServiceRegistry";


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

export const externalRes = path.resolve(app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../external/"));
const singleInstanceLock = app.requestSingleInstanceLock();

const appLogger = appLoggerInstance

let win: BrowserWindow | null;
let serviceRegistry: ApiServiceRegistryImpl | null = null

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
// const APP_TOOL_HEIGHT = 209;
const appSize = {
    width: 820,
    height: 128,
    maxChatContentHeight: 0,
};

export const settings: LocalSettings = {
    isAdminExec: false,
    debug: 0,
    envType: "ultra",
    availableThemes: ["dark", "lnl"],
    currentTheme: "lnl"
};

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

    return settings;
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
            appLogger.onWebcontentReady(win!.webContents)
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
        appLogger.info("load url:" + VITE_DEV_SERVER_URL, 'electron-backend');
    } else {
        await win.loadFile(path.join(process.env.DIST, "index.html"));
    }

    // Make all links open with the browser, not with the application
    win.webContents.setWindowOpenHandler(({url}) => {
        if (url.startsWith("https:")) shell.openExternal(url);
        return {action: "deny"};
    });
    return win;
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
        await serviceRegistry?.stopAllServices()
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

async function initServiceRegistry(win: BrowserWindow, settings: LocalSettings) {
    serviceRegistry = await aiplaygroundApiServiceRegistry(win, settings)
}

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

    ipcMain.handle("getLocalSettings", async () => {
        return {
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
                    appLogger.info(`File downloaded and saved: ${result.filePath}`, 'electron-backend');
                } catch (error) {
                    appLogger.error(`Download and save error: ${JSON.stringify(error, Object.getOwnPropertyNames, 2)}`, 'electron-backend');
                }
            }
        } catch (error) {
            appLogger.error(`${JSON.stringify(error, Object.getOwnPropertyNames, 2)}`, 'electron-backend');
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

    let pathsManager = new PathsManager(path.join(externalRes, app.isPackaged ? "model_config.json" : "model_config.dev.json"));

    ipcMain.handle("getInitSetting", (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) {
            return;
        }
        return {
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

    ipcMain.handle("getServices", () => {
        if(!serviceRegistry) {
            appLogger.warn('frontend tried to getServices too early during aipg startup', 'electron-backend');
            return;}
        return serviceRegistry.getServiceInformation()
    });

    ipcMain.handle("sendStartSignal", (event: IpcMainInvokeEvent, serviceName: string) => {
        if(!serviceRegistry) {
            appLogger.warn('received start signal too early during aipg startup', 'electron-backend');
            return;}
        const service = serviceRegistry.getService(serviceName);
        if(!service) {
            appLogger.warn(`Tried to start service ${serviceName} which is not known`, 'electron-backend')
            return;
        }
        return service.start()
    });
    ipcMain.handle("sendStopSignal", (event: IpcMainInvokeEvent, serviceName: string) => {
        if(!serviceRegistry) {
            appLogger.warn('received stop signal too early during aipg startup', 'electron-backend');
            return;}
        const service = serviceRegistry.getService(serviceName);
        if(!service) {
            appLogger.warn(`Tried to stop service ${serviceName} which is not known`, 'electron-backend')
            return;
        }
        return service.stop()
    });
    ipcMain.handle("sendSetUpSignal", async (event: IpcMainInvokeEvent, serviceName: string) => {
        if(!serviceRegistry || !win) {
            appLogger.warn('received setup signal too early during aipg startup', 'electron-backend');
            return;}
        const service = serviceRegistry.getService(serviceName);
        if(!service) {
            appLogger.warn(`Tried to set up service ${serviceName} which is not known`, 'electron-backend')
            return;
        }
        if(serviceName == "comfyui-backend") {
            //side effect of relying on ai-backend python env
            appLogger.info(`Starting setup of ${serviceName}`, 'electron-backend')
            if (!serviceRegistry.getService('ai-backend')?.isSetUp) {
                appLogger.warn("Called for setup of comfyUI, which so far depends on ai-backend", 'electron-backend')
                appLogger.info("Aborting comfyUI setup request", 'electron-backend')
                win.webContents.send('serviceSetUpProgress', {serviceName: "comfyui-backend", step: "intercepted", status: "failed", debugMessage: `Setup of comfyUI requires required backend already present`})
                return
            }
        }

        for await (const progressUpdate of service.set_up()) {
            win.webContents.send('serviceSetUpProgress', progressUpdate)
            if (progressUpdate.status === "failed" || progressUpdate.status === "success") {
                appLogger.info(`Received terminal progress update for set up request for ${serviceName}`, 'electron-backend')
                break
            }
        }
    });


    ipcMain.handle("reloadImageWorkflows", () => {
        const files = fs.readdirSync(path.join(externalRes, "workflows"));
        const workflows = files.map((file) => fs.readFileSync(path.join(externalRes, "workflows", file), {encoding: "utf-8"}));
        return workflows;
    });

    const getImagePathFromUrl = (url: string) => {
        const imageUrl = URL.parse(url)
        if (!imageUrl) {
            console.error('Could not find image for URL', {url})
            return;
        }
        const aiBackendUrl = serviceRegistry?.getService('ai-backend')?.baseUrl
        const backend = (aiBackendUrl && url.includes(aiBackendUrl)) ? 'service' : 'ComfyUI';

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
        appLogger.error(`${JSON.stringify(error, Object.getOwnPropertyNames, 2)}`, 'electron-backend');
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

async function setupPyenv() {
    const iterable: AsyncIterable<SetupProgress> = serviceRegistry!.getService("ai-backend")!.set_up()
    try {
        for await (const value of iterable) {
            appLogger.info(`reported progress: ${value.step}|${value.status}|${value.debugMessage}`, 'electron-backend');
        }
    } catch (e) {
        appLogger.warn(`caught error: ${e}`, 'electron-backend');
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
        const settings = await loadSettings();
        initEventHandle();
        const window = await createWindow();
        await initServiceRegistry(window, settings);
        serviceRegistry
    }
});
