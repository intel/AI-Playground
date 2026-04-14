import koffi from 'koffi'
if (isAdmin()) {
  const lib = koffi.load('user32.dll')
  const MB_ICONINFORMATION = 0x40
  const MessageBoxW = lib.func('__stdcall', 'MessageBoxW', 'int', [
    'void *',
    'str16',
    'str16',
    'uint',
  ])

  MessageBoxW(
    null,
    'For security reasons, AI Playground cannot be executed with administrative permissions. Please restart AI Playground from a Windows account without Administrator rights.',
    'AI Playground',
    MB_ICONINFORMATION,
  )

  process.exit(0)
}
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  MessageBoxOptions,
  MessageBoxSyncOptions,
  nativeImage,
  net,
  OpenDialogSyncOptions,
  protocol,
  screen,
  shell,
  utilityProcess,
  UtilityProcess,
} from 'electron'
import path from 'node:path'
import fs from 'fs'
import { exec } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import sudo from 'sudo-prompt'
import { PathsManager } from './pathsManager'
import { cleanupTempFolders } from './tempFolderCleanup'
import { appLoggerInstance } from './logging/logger.ts'
import {
  aiplaygroundApiServiceRegistry,
  ApiServiceRegistryImpl,
} from './subprocesses/apiServiceRegistry'
import {
  ComfyUiBackendService,
  COMFYUI_DEFAULT_PARAMETERS,
} from './subprocesses/comfyUIBackendService'
import { LLAMACPP_DEFAULT_PARAMETERS } from './subprocesses/llamaCppBackendService'
import { filterPartnerPresets, updateIntelPresets } from './subprocesses/updateIntelPresets.ts'
import { getGitHubRepoUrl, resolveBackendVersion, resolveModels } from './remoteUpdates.ts'
import * as comfyuiTools from './subprocesses/comfyuiTools'
import {
  getMcpServerStatus,
  invokeMcpServerTool,
  listMcpServers,
  listMcpServerTools,
  startMcpServer,
  stopAllMcpServers,
  stopMcpServer,
} from './subprocesses/mcpManager'
import {
  addMcpServer,
  getMcpConfigPath,
  getMcpServerConfig,
  updateMcpServer,
  removeMcpServer,
  type McpServerConfig,
} from './subprocesses/mcpServers'
import { externalResourcesDir, getMediaDir } from './util.ts'
import { loadDemoProfile, type DemoProfile } from './demoProfile.ts'
import type { ModelPaths } from '@/assets/js/store/models.ts'
import type { IndexedDocument, EmbedInquiry } from '@/assets/js/store/textInference.ts'
import { BackendServiceName } from '@/assets/js/store/backendServices.ts'
import {
  detectGpuHardwareDevices,
  type GpuHardwareDevice,
} from './subprocesses/hardwareDiscovery.ts'
import z from 'zod'

const ProductModeUiI18nSchema = z.object({
  titleOne: z.string(),
  titleTwo: z.string(),
  subtitle: z.string().optional(),
  description: z.string(),
  supportedHardware: z.string(),
  features: z.array(z.object({ labelKey: z.string(), detailKey: z.string() })).optional(),
})

const ProductModeFileSchema = z.object({
  mode: z.enum(['studio', 'essentials', 'nvidia']),
  priority: z.number(),
  recommendForIntelDeviceIds: z.array(z.string()).default([]),
  recommendForNvidia: z.boolean().default(false),
  experimental: z.boolean().default(false),
  displayOrder: z.number(),
  requiresNvidiaGpu: z.boolean().default(false),
  includePresets: z.array(z.string()).optional(),
  excludePresets: z.array(z.string()).optional(),
  ui: z.object({
    i18n: ProductModeUiI18nSchema,
  }),
})
type ProductModeFileConfig = z.infer<typeof ProductModeFileSchema>

function loadProductModeConfigs(): ProductModeFileConfig[] {
  try {
    const modeDirs = fs
      .readdirSync(modesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'base')

    const configs: ProductModeFileConfig[] = []
    for (const dir of modeDirs) {
      const modeFile = path.join(modesDir, dir.name, 'mode.json')
      if (!fs.existsSync(modeFile)) continue
      const raw = fs.readFileSync(modeFile, 'utf-8')
      const parsed = ProductModeFileSchema.parse(JSON.parse(raw))
      configs.push({
        ...parsed,
        recommendForIntelDeviceIds: parsed.recommendForIntelDeviceIds.map((id) => id.toLowerCase()),
      })
    }
    return configs
  } catch (e) {
    appLogger.warn(`Failed to read product mode configs: ${e}`, 'electron-backend')
    return []
  }
}

function loadModeConfig(mode: string): ProductModeFileConfig | null {
  const modeFile = path.join(modesDir, mode, 'mode.json')
  if (!fs.existsSync(modeFile)) return null
  try {
    const raw = fs.readFileSync(modeFile, 'utf-8')
    return ProductModeFileSchema.parse(JSON.parse(raw))
  } catch (e) {
    appLogger.warn(`Failed to read mode config for ${mode}: ${e}`, 'electron-backend')
    return null
  }
}

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
process.env.DIST = path.join(__dirname, '../')
process.env.VITE_PUBLIC = path.join(__dirname, app.isPackaged ? '../..' : '../../../public')

const externalRes = path.resolve(
  app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../external/'),
)

const modesDir = path.resolve(
  app.isPackaged
    ? path.join(process.resourcesPath, 'modes')
    : path.join(__dirname, '../../../modes/'),
)
const singleInstanceLock = app.requestSingleInstanceLock()

const appLogger = appLoggerInstance

let win: BrowserWindow | null
let serviceRegistry: ApiServiceRegistryImpl | null = null
const mediaDir = getMediaDir()
fs.mkdirSync(mediaDir, { recursive: true })
const mediaInputDir = path.join(mediaDir, 'input')
fs.mkdirSync(mediaInputDir, { recursive: true })
let langchainChild: UtilityProcess | null = null

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
if (!app.isPackaged && process.env.AIPG_DEBUGGING_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.AIPG_DEBUGGING_PORT)
}
// const APP_TOOL_HEIGHT = 209;
const appSize = {
  width: 820,
  height: 128,
  maxChatContentHeight: 0,
}
const ThemeSchema = z.enum(['dark', 'lnl', 'bmg', 'light'])
const ProductModeSchema = z.enum(['studio', 'essentials', 'nvidia'])
const LocalSettingsSchema = z.object({
  debug: z.boolean().default(false),
  deviceArchOverride: z.enum(['bmg', 'acm', 'arl_h', 'wcl', 'lnl', 'mtl']).nullable().default(null),
  isAdminExec: z.boolean().default(false),
  availableThemes: z.array(ThemeSchema).default(['dark', 'lnl', 'bmg', 'light']),
  currentTheme: ThemeSchema.default('bmg'),
  productMode: ProductModeSchema.optional(),
  isDemoModeEnabled: z.boolean().default(false),
  demoModeResetInSeconds: z.number().min(1).nullable().default(null),
  demoModePasscode: z.string().optional(),
  languageOverride: z.string().nullable().default(null),
  remoteRepository: z.string().default('intel/ai-playground'),
  huggingfaceEndpoint: z.string().default('https://huggingface.co'),
})
export type LocalSettings = z.infer<typeof LocalSettingsSchema>
export type ProductMode = z.infer<typeof ProductModeSchema>

function resolveProductMode(s: LocalSettings): string {
  return s.productMode === 'essentials'
    ? 'essentials'
    : s.productMode === 'nvidia'
      ? 'nvidia'
      : 'studio'
}

type PresetLoadConfig = {
  baseDir: string
  modeDir: string
  imageFallbackDirs: string[]
  includePresets?: string[]
  excludePresets?: string[]
}

function getPresetLoadConfig(s: LocalSettings): PresetLoadConfig {
  const mode = resolveProductMode(s)
  const variant = s.isDemoModeEnabled ? 'demo' : 'presets'
  const modeConfig = loadModeConfig(mode)
  const basePresetsDir = path.join(modesDir, 'base', 'presets')
  return {
    baseDir: path.join(modesDir, 'base', variant),
    modeDir: path.join(modesDir, mode, variant),
    imageFallbackDirs: variant === 'demo' ? [basePresetsDir] : [],
    includePresets: modeConfig?.includePresets,
    excludePresets: modeConfig?.excludePresets,
  }
}

function getModeDemoDir(s: LocalSettings): string {
  return path.join(modesDir, resolveProductMode(s), 'demo')
}

type PresetFile = { content: string; image: string | null }

function findPresetImage(baseName: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    for (const ext of ['.png', '.jpg', '.jpeg']) {
      const imagePath = path.join(dir, `${baseName}${ext}`)
      if (fs.existsSync(imagePath)) return imagePath
    }
  }
  return null
}

async function readPresetsFromDir(
  dir: string,
  imageFallbackDirs: string[] = [],
): Promise<Map<string, PresetFile>> {
  const result = new Map<string, PresetFile>()
  if (!fs.existsSync(dir)) return result

  await fs.promises.mkdir(dir, { recursive: true })
  const files = await fs.promises.readdir(dir)
  const presetFiles = files.filter((f) => f.endsWith('.json') && !f.startsWith('_'))

  await Promise.all(
    presetFiles.map(async (file) => {
      const raw = await fs.promises.readFile(path.join(dir, file), { encoding: 'utf-8' })
      const content = process.platform !== 'win32' ? raw.replaceAll('\\\\', '/') : raw

      const baseName = path.basename(file, '.json')
      let imageBase64: string | null = null
      const imagePath = findPresetImage(baseName, [dir, ...imageFallbackDirs])
      if (imagePath) {
        try {
          const imageBuffer = await fs.promises.readFile(imagePath)
          const ext = path.extname(imagePath).toLowerCase()
          const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg'
          imageBase64 = `data:${mimeType};base64,${imageBuffer.toString('base64')}`
        } catch (error) {
          appLogger.warn(`Failed to read image file ${imagePath}: ${error}`, 'electron-backend')
        }
      }

      result.set(baseName, { content, image: imageBase64 })
    }),
  )
  return result
}

function applyPresetFilter(
  presets: Map<string, PresetFile>,
  config: PresetLoadConfig,
): Map<string, PresetFile> {
  if (config.includePresets) {
    const allowed = new Set(config.includePresets)
    for (const key of presets.keys()) {
      if (!allowed.has(key)) presets.delete(key)
    }
  } else if (config.excludePresets) {
    for (const excluded of config.excludePresets) {
      presets.delete(excluded)
    }
  }
  return presets
}

let settings = LocalSettingsSchema.parse({})
let demoProfile: DemoProfile | null = null

/** Packaged app: single JSON next to resources. Dev: never write here (Vite watches the repo). */
function getPackagedSettingsPath(): string {
  return path.join(process.resourcesPath, 'settings.json')
}

/** Dev-only defaults shipped in the repo (read-only for the app). */
function getDevSettingsDefaultsPath(): string {
  return path.join(__dirname, '../../external/settings-dev.json')
}

/** Writable path: packaged = resources settings; dev = userData overlay (avoids Vite reload loops). */
function getWritableSettingsPath(): string {
  if (app.isPackaged) {
    return getPackagedSettingsPath()
  }
  return path.join(app.getPath('userData'), 'ai-playground-local-settings.json')
}

function persistLocalSettingsToDisk(): void {
  const settingPath = getWritableSettingsPath()
  const serialized = JSON.stringify(LocalSettingsSchema.parse(settings), null, 2)
  const tmpPath = `${settingPath}.${randomUUID()}.tmp`
  try {
    fs.mkdirSync(path.dirname(settingPath), { recursive: true })
    fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8' })
    fs.renameSync(tmpPath, settingPath)
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath)
    } catch {
      // ignore cleanup failure
    }
    appLogger.error(`failed to persist local settings: ${e}`, 'electron-backend')
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aipg-media',
    privileges: {
      secure: true,
      supportFetchAPI: true, // impotant
      standard: true,
      bypassCSP: true, // impotant
      stream: true,
    },
  },
])

async function loadSettings() {
  settings = LocalSettingsSchema.parse({})

  if (app.isPackaged) {
    const packagedPath = getPackagedSettingsPath()
    appLogger.info(`loading packaged settings from ${packagedPath}`, 'electron-backend')
    if (fs.existsSync(packagedPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(packagedPath, { encoding: 'utf8' }))
        settings = LocalSettingsSchema.parse({ ...settings, ...raw })
      } catch (e) {
        appLogger.error(`failed to load settings: ${e}`, 'electron-backend')
      }
    }
  } else {
    const defaultsPath = getDevSettingsDefaultsPath()
    appLogger.info(`loading dev defaults from ${defaultsPath}`, 'electron-backend')
    if (fs.existsSync(defaultsPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(defaultsPath, { encoding: 'utf8' }))
        settings = LocalSettingsSchema.parse({ ...settings, ...raw })
      } catch (e) {
        appLogger.error(`failed to load dev defaults: ${e}`, 'electron-backend')
      }
    }
    const userPath = getWritableSettingsPath()
    appLogger.info(`loading dev user settings from ${userPath}`, 'electron-backend')
    if (fs.existsSync(userPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(userPath, { encoding: 'utf8' }))
        settings = LocalSettingsSchema.parse({ ...settings, ...raw })
      } catch (e) {
        appLogger.error(`failed to load dev user settings: ${e}`, 'electron-backend')
      }
    }
  }

  appLogger.info(`settings loaded: ${JSON.stringify({ settings })}`, 'electron-backend')

  if (settings.isDemoModeEnabled) {
    const modeDemoDir = getModeDemoDir(settings)
    const baseDemoDir = path.join(modesDir, 'base', 'demo')
    try {
      demoProfile = loadDemoProfile(modeDemoDir, baseDemoDir, appLogger)
    } catch (e) {
      appLogger.error(`Failed to load demo profile: ${e}`, 'demo-profile')
    }
  }

  return settings
}

async function createWindow() {
  win = new BrowserWindow({
    title: 'AI PLAYGROUND',
    icon: path.join(process.env.VITE_PUBLIC, 'app-ico.svg'),
    transparent: false,
    resizable: true,
    frame: false,
    // fullscreen: true,
    width: 1440,
    height: 951,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
    },
  })
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      appLogger.onWebcontentReady(win!.webContents)
    }, 100)

    // Check localStorage for developer settings after page loads
    setTimeout(async () => {
      try {
        const openDevConsoleOnStartup = await win!.webContents.executeJavaScript(
          `(() => {
            try {
              const developerSettings = localStorage.getItem('developerSettings');
              if (developerSettings) {
                const parsed = JSON.parse(developerSettings);
                return parsed.openDevConsoleOnStartup === true;
              }
            } catch (e) {
              return false;
            }
            return false;
          })()`,
        )
        if (openDevConsoleOnStartup && app.isPackaged && !settings.debug) {
          win!.webContents.openDevTools({ mode: 'detach', activate: true })
        }
      } catch (e) {
        appLogger.error(`Failed to check developer settings: ${e}`, 'electron-backend')
      }
    }, 500)
  })

  const session = win.webContents.session

  if (!app.isPackaged || settings.debug) {
    //Open devTool if the app is not packaged
    win.webContents.openDevTools({ mode: 'detach', activate: true })
  }

  if (settings.isDemoModeEnabled) {
    win.setFullScreen(true)
    win.maximize()
    win.setKiosk(true)
  }

  session.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({
      requestHeaders: {
        ...details.requestHeaders,
        Origin: '*',
      },
    })
  })
  session.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.match(/^http:\/\/(localhost|127.0.0.1)/)) {
      const headers = new Headers()
      if (details.responseHeaders) {
        for (const [headerName, values] of Object.entries(details.responseHeaders)) {
          for (const v of values) {
            headers.append(headerName, v)
          }
        }
      }
      const append = (name: string, value: string) => {
        if (!headers.get(name)?.includes(value)) {
          headers.append(name, value)
        }
      }
      append('Access-Control-Allow-Origin', '*')
      append('Access-Control-Allow-Methods', 'GET')
      append('Access-Control-Allow-Methods', 'POST')
      append('Access-Control-Allow-Headers', 'x-requested-with')
      append('Access-Control-Allow-Headers', 'Content-Type')
      append('Access-Control-Allow-Headers', 'Authorization')
      details.responseHeaders = Object.fromEntries([...headers.entries()].map(([k, v]) => [k, [v]]))
      callback(details)
    } else {
      return callback(details)
    }
  })

  win.webContents.session.setPermissionRequestHandler((_, permission, callback) => {
    if (
      permission === 'media' ||
      permission === 'clipboard-sanitized-write'
      // permission === "clipboard-sanitized-write"
    ) {
      callback(true)
    } else {
      callback(false)
    }
  })

  if (VITE_DEV_SERVER_URL) {
    await win.loadURL(VITE_DEV_SERVER_URL)
    appLogger.info('load url:' + VITE_DEV_SERVER_URL, 'electron-backend')
  } else {
    await win.loadFile(path.join(process.env.DIST, 'index.html'))
  }

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    if (url.startsWith('http://localhost')) shell.openExternal(url)
    if (url.startsWith('http://127.0.0.1')) shell.openExternal(url)
    return { action: 'deny' }
  })
  return win
}

function spawnLangchainUtilityProcess() {
  if (langchainChild) {
    appLogger.info('Langchain utility process already running', 'electron-backend')
    return
  }
  appLogger.info('Starting langchain utility process', 'electron-backend')
  try {
    appLogger.info(path.join(__dirname, '../langchain/langchain.js'), 'electron-backend')

    langchainChild = utilityProcess.fork(
      path.join(__dirname, '../langchain/langchain.js'),
      undefined,
      { stdio: 'pipe' },
    )
    langchainChild.stdout?.on('data', (data) => {
      appLogger.info(data.toString(), 'langchain')
    })
    langchainChild.stderr?.on('data', (data) => {
      appLogger.error(data.toString(), 'langchain')
    })
    langchainChild.postMessage({
      type: 'init',
      embeddingCachePath: path.join(externalResourcesDir(), 'embeddingCache'),
    })

    langchainChild.on('message', (message) => {
      appLogger.info(
        `Message from langchain utility process: Type ${message.type}`,
        'electron-backend',
      )
    })

    langchainChild.on('error', (error) => {
      appLogger.error(`Error from langchain utility process: ${error}`, 'electron-backend')
    })

    langchainChild.on('exit', (code) => {
      if (code !== 0) {
        appLogger.info(`Langchain utility process exited with code ${code}`, 'electron-backend')
      }
      setTimeout(() => {
        spawnLangchainUtilityProcess()
      }, 1000)
      langchainChild = null
    })
  } catch (error) {
    appLogger.error(`Error starting langchain utility process: ${error}`, 'electron-backend')
  }
}

function handleUtilityFunction<T, R>(
  eventType: string,
  child: UtilityProcess | null,
  args: T,
): Promise<R> {
  if (!child) {
    throw new Error('Utility process is not running')
  }
  return new Promise((resolve, reject) => {
    const messageHandler = (message: { type: string; returnValue: R }) => {
      if (message.type === eventType) {
        child.off('message', messageHandler)
        resolve(message.returnValue)
      }
    }

    const errorHandler = (type: string, location: string, report: string) => {
      const error = new Error(`Error in ${type} at ${location}: ${report}`)
      child.off('error', errorHandler)
      reject(error)
    }

    child.on('message', messageHandler)
    child.on('error', errorHandler)

    child.postMessage({ type: eventType, args: args })
  })
}

app.on('quit', async () => {
  await stopAllMcpServers()
  if (singleInstanceLock) {
    app.releaseSingleInstanceLock()
  }
})
// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', async () => {
  try {
    await stopAllMcpServers()
    await serviceRegistry?.stopAllServices()
  } catch {}
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) {
      win.restore()
    }
    win.focus()
  }
})

async function initServiceRegistry(win: BrowserWindow, settings: LocalSettings) {
  serviceRegistry = await aiplaygroundApiServiceRegistry(win, settings)
  return serviceRegistry
}

function initEventHandle() {
  screen.on('display-metrics-changed', (_event, display, _changedMetrics) => {
    if (win) {
      win.setBounds({
        x: 0,
        y: 0,
        width: display.workAreaSize.width,
        height: display.workAreaSize.height,
      })
      win.webContents.send(
        'display-metrics-changed',
        display.workAreaSize.width,
        display.workAreaSize.height,
      )
    }
  })

  ipcMain.handle('getThemeSettings', async () => {
    return {
      availableThemes: settings.availableThemes,
      currentTheme: settings.currentTheme,
    }
  })

  ipcMain.handle('getLocaleSettings', async () => {
    return {
      locale: app.getLocale(),
      languageOverride: settings.languageOverride,
    }
  })

  ipcMain.handle('getLocalSettings', () => {
    return LocalSettingsSchema.parse(settings)
  })

  ipcMain.handle('updateLocalSettings', (_event, updates: Partial<LocalSettings>) => {
    Object.assign(settings, updates)
    const shouldReloadDemoProfile =
      settings.isDemoModeEnabled && ('productMode' in updates || 'isDemoModeEnabled' in updates)
    if (shouldReloadDemoProfile) {
      const modeDemoDir = getModeDemoDir(settings)
      const baseDemoDir = path.join(modesDir, 'base', 'demo')
      try {
        demoProfile = loadDemoProfile(modeDemoDir, baseDemoDir, appLogger)
      } catch (e) {
        appLogger.error(`Failed to reload demo profile after settings change: ${e}`, 'demo-profile')
      }
    }
    persistLocalSettingsToDisk()
    appLogger.info(`Updated local settings: ${JSON.stringify(updates)}`, 'electron-backend')
    return { success: true }
  })

  ipcMain.handle('detectHardwareForModeRecommendation', async () => {
    let detected: GpuHardwareDevice[] = []
    let hasNvidia = false
    let detectSuccess = true

    try {
      const probe = await detectGpuHardwareDevices()
      detected = probe.detected
      hasNvidia = probe.hasNvidia
      appLogger.info(`Detected GPU devices: ${JSON.stringify(detected)}`, 'electron-backend')
      appLogger.info(`Has NVIDIA: ${hasNvidia}`, 'electron-backend')
    } catch (e) {
      detectSuccess = false
      appLogger.warn(`GPU detection failed: ${e}`, 'electron-backend')
    }

    const configs = loadProductModeConfigs()

    const modeCatalog = configs
      .sort((a, b) => a.displayOrder - b.displayOrder)
      .map((c) => ({
        mode: c.mode,
        experimental: c.experimental,
        ui: c.ui,
      }))

    const gpuIds = detected
      .map((d) => d.gpuDeviceId)
      .filter((id): id is string => id !== null)
      .map((id) => id.toLowerCase())

    // Highest priority wins.
    const eligible = configs
      .filter((c) => c.mode !== 'nvidia' || hasNvidia)
      .filter((c) => {
        if (c.mode === 'nvidia') return c.recommendForNvidia === true
        if (!c.recommendForIntelDeviceIds.length) return false
        if (gpuIds.length === 0) return false
        return gpuIds.some((id) => c.recommendForIntelDeviceIds.includes(id))
      })
      .sort((a, b) => b.priority - a.priority)

    const recommendedMode: ProductMode = eligible[0]?.mode ?? 'studio'

    return {
      success: detectSuccess,
      recommendedMode,
      detectedDevices: detected,
      hasNvidiaGpu: hasNvidia,
      modeCatalog,
    }
  })

  ipcMain.handle('getWinSize', () => {
    return appSize
  })

  ipcMain.handle('zoomIn', (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 1)
  })

  ipcMain.handle('zoomOut', (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 1)
  })

  ipcMain.on('openUrl', (_event, url: string) => {
    return shell.openExternal(url)
  })

  ipcMain.handle('setWinSize', (event: IpcMainInvokeEvent, width: number, height: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    const winRect = win.getBounds()
    if (winRect.width != width || winRect.height != height) {
      const y = winRect.y + (winRect.height - height)
      win.setBounds({ x: winRect.x, y, width, height })
    }
  })

  ipcMain.handle('restorePathsSettings', (_event: IpcMainInvokeEvent) => {
    const paths = app.isPackaged
      ? {
          ggufLLM: './resources/models/LLM/ggufLLM',
          openvinoLLM: './resources/models/LLM/openvino',
          embedding: './resources/models/LLM/embedding',
        }
      : {
          ggufLLM: '../models/LLM/ggufLLM',
          openvinoLLM: '../models/LLM/openvino',
          embedding: '../models/LLM/embedding',
        }
    pathsManager.updateModelPaths(paths)
  })

  ipcMain.on('miniWindow', () => {
    if (win) {
      win.minimize()
    }
  })

  ipcMain.on('setFullScreen', (_event: IpcMainEvent, enable: boolean) => {
    if (win) {
      win.setFullScreen(enable)
    }
  })

  ipcMain.on('exitApp', async () => {
    if (win) {
      win.close()
    }
  })

  ipcMain.on('saveImage', async (event: IpcMainEvent, url: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) {
      return
    }
    const options = {
      title: 'Save Image',
      defaultPath: path.join(app.getPath('documents'), 'example.png'),
      filters: [{ name: 'AIGC-Gennerate.png', extensions: ['png'] }],
    }

    try {
      const result = await dialog.showSaveDialog(win, options)
      if (!result.canceled && result.filePath) {
        if (fs.existsSync(result.filePath)) {
          fs.rmSync(result.filePath)
        }
        try {
          const response = await fetch(url)
          const arrayBuffer = await response.arrayBuffer()
          const buffer = Buffer.from(arrayBuffer)
          fs.writeFileSync(result.filePath, buffer)
          appLogger.info(`File downloaded and saved: ${result.filePath}`, 'electron-backend')
        } catch (error) {
          appLogger.error(
            `Download and save error: ${JSON.stringify(error, Object.getOwnPropertyNames, 2)}`,
            'electron-backend',
          )
        }
      }
    } catch (error) {
      appLogger.error(`${JSON.stringify(error, Object.getOwnPropertyNames, 2)}`, 'electron-backend')
    }
  })

  ipcMain.handle('saveImageToMediaInput', async (_event, dataUri: string) => {
    if (typeof dataUri !== 'string' || !dataUri.startsWith('data:image/')) {
      throw new Error('saveImageToMediaInput: expected a data URI (data:image/...)')
    }
    const match = dataUri.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/)
    if (!match) {
      throw new Error('saveImageToMediaInput: unsupported image type or malformed data URI')
    }
    const mimeSubtype = match[1]
    const base64Data = match[2]
    const ext = mimeSubtype === 'jpeg' ? 'jpg' : mimeSubtype
    const filename = `${randomUUID()}.${ext}`
    const filePath = path.join(mediaInputDir, filename)
    const buffer = Buffer.from(base64Data, 'base64')
    await fs.promises.writeFile(filePath, buffer)
    return `input/${filename}`
  })

  /** Get command line parameters when launched from IPOS to decide the default home page */
  ipcMain.handle('getInitialPage', () => {
    const startPageArg = process.argv.find((arg) => arg.startsWith('--start-page='))
    return startPageArg ? startPageArg.split('=')[1] : 'create'
  })

  /** To check whether demo mode is enabled or not for AIPG */
  ipcMain.handle('getDemoModeSettings', () => {
    return {
      isDemoModeEnabled: settings.isDemoModeEnabled,
      demoModeResetInSeconds: settings.demoModeResetInSeconds,
      demoModePasscode: settings.demoModePasscode,
      profile: demoProfile,
    }
  })

  ipcMain.handle('showOpenDialog', async (event, options: OpenDialogSyncOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    return await dialog.showOpenDialog(win, options)
  })

  ipcMain.handle('showMessageBox', async (event, options: MessageBoxOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    return dialog.showMessageBox(win, options)
  })

  ipcMain.handle('showMessageBoxSync', async (event, options: MessageBoxSyncOptions) => {
    const win = BrowserWindow.fromWebContents(event.sender)!
    return dialog.showMessageBoxSync(win, options)
  })

  ipcMain.handle('existsPath', async (event, path: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) {
      return
    }
    return fs.existsSync(path)
  })

  const pathsManager = new PathsManager(
    path.join(externalRes, app.isPackaged ? 'model_config.json' : 'model_config.dev.json'),
  )

  ipcMain.handle('getInitSetting', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) {
      return
    }
    return {
      modelLists: pathsManager.scanAll(),
      modelPaths: pathsManager.modelPaths,
      isAdminExec: settings.isAdminExec,
      version: app.getVersion(),
    }
  })

  ipcMain.handle('loadModels', async (_event) => {
    return resolveModels(settings)
  })

  ipcMain.handle('updateModelPaths', (_event, modelPaths: ModelPaths) => {
    pathsManager.updateModelPaths(modelPaths)
    return pathsManager.scanAll()
  })

  ipcMain.handle('refreshLLMModles', (_event) => {
    // Old ipexllm backend removed - return empty array
    return []
  })

  ipcMain.handle('getDownloadedLLMs', (_event) => {
    // Old ipexllm backend removed - return empty array
    return []
  })

  ipcMain.handle('getDownloadedGGUFLLMs', (_event) => {
    return pathsManager.scanGGUFLLMModels()
  })

  ipcMain.handle('getDownloadedOpenVINOLLMModels', (_event) => {
    return pathsManager.scanOpenVINOModels()
  })

  ipcMain.handle('getDownloadedEmbeddingModels', (_event) => {
    return pathsManager.scanEmbedding()
  })

  ipcMain.handle('getComfyUIModels', (_event, modelType: string) => {
    return pathsManager.scanComfyUIModels(modelType)
  })

  ipcMain.handle('getPlatform', () => process.platform)

  ipcMain.handle('addDocumentToRAGList', (_event, document: IndexedDocument) => {
    return handleUtilityFunction<IndexedDocument, IndexedDocument>(
      'addDocumentToRAGList',
      langchainChild,
      document,
    )
  })

  ipcMain.handle('embedInputUsingRag', (_event, embedInquiry: EmbedInquiry) => {
    return handleUtilityFunction<EmbedInquiry, KVObject>(
      'embedInputUsingRag',
      langchainChild,
      embedInquiry,
    )
  })

  ipcMain.on('openDevTools', () => {
    win?.webContents.openDevTools({ mode: 'detach', activate: true })
  })

  ipcMain.handle('getServices', () => {
    if (!serviceRegistry) {
      appLogger.warn(
        'frontend tried to getServices too early during aipg startup',
        'electron-backend',
      )
      return []
    }
    return serviceRegistry.getServiceInformation()
  })

  ipcMain.handle('uninstall', (_event: IpcMainInvokeEvent, serviceName: string) => {
    if (!serviceRegistry) {
      appLogger.warn('received uninstall too early during aipg startup', 'electron-backend')
      return
    }
    const service = serviceRegistry.getService(serviceName)
    if (!service) {
      appLogger.warn(
        `Tried to uninstall service ${serviceName} which is not known`,
        'electron-backend',
      )
      return
    }
    return service.uninstall()
  })

  ipcMain.handle('updateServiceSettings', (_event: IpcMainInvokeEvent, settings) => {
    if (!serviceRegistry) {
      appLogger.warn(
        'received updateServiceSettings too early during aipg startup',
        'electron-backend',
      )
      return
    }
    const service = serviceRegistry.getService(settings.serviceName)
    if (!service) {
      appLogger.warn(
        `Tried to update settings for service ${settings.serviceName} which is not known`,
        'electron-backend',
      )
      return
    }
    return service.updateSettings(settings)
  })

  ipcMain.handle('getComfyUiDefaultParameters', () => COMFYUI_DEFAULT_PARAMETERS)
  ipcMain.handle('getLlamaCppDefaultParameters', () => LLAMACPP_DEFAULT_PARAMETERS)

  ipcMain.handle('detectDevices', (_event: IpcMainInvokeEvent, serviceName: string) => {
    if (!serviceRegistry) {
      appLogger.warn('received detectDevices too early during aipg startup', 'electron-backend')
      return
    }
    const service = serviceRegistry.getService(serviceName)
    if (!service) {
      appLogger.warn(
        `Tried to detectDevices for service ${serviceName} which is not known`,
        'electron-backend',
      )
      return
    }
    return service.detectDevices()
  })

  ipcMain.handle(
    'selectDevice',
    (_event: IpcMainInvokeEvent, serviceName: string, deviceId: string) => {
      appLogger.info('selecting device', 'electron-backend')
      if (!serviceRegistry) {
        appLogger.warn('received selectDevice too early during aipg startup', 'electron-backend')
        return
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        appLogger.warn(
          `Tried to selectDevice for service ${serviceName} which is not known`,
          'electron-backend',
        )
        return
      }
      return service.selectDevice(deviceId)
    },
  )

  ipcMain.handle(
    'selectSttDevice',
    (_event: IpcMainInvokeEvent, serviceName: string, deviceId: string) => {
      appLogger.info('selecting STT device', 'electron-backend')
      if (!serviceRegistry) {
        appLogger.warn('received selectSttDevice too early during aipg startup', 'electron-backend')
        return
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        appLogger.warn(
          `Tried to selectSttDevice for service ${serviceName} which is not known`,
          'electron-backend',
        )
        return
      }
      if ('selectSttDevice' in service && typeof service.selectSttDevice === 'function') {
        return service.selectSttDevice(deviceId)
      }
      appLogger.warn(`Service ${serviceName} does not support selectSttDevice`, 'electron-backend')
    },
  )

  ipcMain.handle('startService', (_event: IpcMainInvokeEvent, serviceName: string) => {
    if (!serviceRegistry) {
      appLogger.warn('received start signal too early during aipg startup', 'electron-backend')
      return 'failed'
    }
    const service = serviceRegistry.getService(serviceName)
    if (!service) {
      appLogger.warn(`Tried to start service ${serviceName} which is not known`, 'electron-backend')
      return 'failed'
    }
    return service.start()
  })
  ipcMain.handle('stopService', (_event: IpcMainInvokeEvent, serviceName: string) => {
    if (!serviceRegistry) {
      appLogger.warn('received stop signal too early during aipg startup', 'electron-backend')
      return 'failed'
    }
    const service = serviceRegistry.getService(serviceName)
    if (!service) {
      appLogger.warn(`Tried to stop service ${serviceName} which is not known`, 'electron-backend')
      return 'failed'
    }
    return service.stop()
  })
  ipcMain.handle(
    'setUpService',
    async (_event: IpcMainInvokeEvent, serviceName: BackendServiceName) => {
      if (!serviceRegistry || !win) {
        appLogger.warn('received setup signal too early during aipg startup', 'electron-backend')
        return
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        appLogger.warn(
          `Tried to set up service ${serviceName} which is not known`,
          'electron-backend',
        )
        return
      }

      for await (const progressUpdate of service.set_up()) {
        win.webContents.send('serviceSetUpProgress', progressUpdate)
        if (progressUpdate.status === 'failed' || progressUpdate.status === 'success') {
          appLogger.info(
            `Received terminal progress update for set up request for ${serviceName}`,
            'electron-backend',
          )
          break
        }
      }
    },
  )

  ipcMain.handle(
    'ensureBackendReadiness',
    async (
      _event: IpcMainInvokeEvent,
      serviceName: string,
      llmModelName: string,
      embeddingModelName?: string,
      contextSize?: number,
    ) => {
      appLogger.info(
        `Ensuring backend readiness for service: ${serviceName}, LLM: ${llmModelName}, Embedding: ${embeddingModelName || 'none'}, Context Size: ${contextSize ?? 'undefined'}`,
        'electron-backend',
      )
      if (!serviceRegistry) {
        appLogger.warn(
          'received ensureBackendReadiness too early during aipg startup',
          'electron-backend',
        )
        return { success: false, error: 'Service registry not ready' }
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        appLogger.warn(`Service ${serviceName} not found`, 'electron-backend')
        return { success: false, error: `Service ${serviceName} not found` }
      }

      try {
        await service.ensureBackendReadiness(llmModelName, embeddingModelName, contextSize)
        appLogger.info(
          `Backend ${serviceName} ready for LLM: ${llmModelName}, Embedding: ${embeddingModelName || 'none'}`,
          'electron-backend',
        )
        return { success: true }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        appLogger.error(
          `Failed to ensure backend readiness for ${serviceName}: ${errorMessage}`,
          'electron-backend',
        )
        return { success: false, error: errorMessage }
      }
    },
  )

  ipcMain.handle('ensureComfyUIBackendRunning', async () => {
    if (!serviceRegistry) {
      return { success: false, error: 'Service registry not ready', starting: false }
    }
    const service = serviceRegistry.getService('comfyui-backend')
    if (!service) {
      return { success: false, error: 'ComfyUI service not found', starting: false }
    }
    if (service.currentStatus === 'running') {
      return { success: true, starting: false }
    }
    if (service.currentStatus === 'starting') {
      return { success: true, starting: true }
    }
    try {
      const result = await service.start()
      if (result === 'running') return { success: true, starting: false }
      if (result === 'starting') return { success: true, starting: true }
      return {
        success: false,
        starting: false,
        error: `ComfyUI backend status: ${result}`,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      appLogger.error(`Failed to start ComfyUI backend: ${errorMessage}`, 'electron-backend')
      return { success: false, error: errorMessage, starting: false }
    }
  })

  ipcMain.handle(
    'getEmbeddingServerUrl',
    async (_event: IpcMainInvokeEvent, serviceName: string) => {
      if (!serviceRegistry) {
        return { success: false, error: 'Service registry not ready' }
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        return { success: false, error: `Service ${serviceName} not found` }
      }

      // Check if service has getEmbeddingServerUrl method (llamaCPP backend)
      if (
        'getEmbeddingServerUrl' in service &&
        typeof service.getEmbeddingServerUrl === 'function'
      ) {
        const embeddingUrl = service.getEmbeddingServerUrl()
        if (embeddingUrl) {
          return { success: true, url: embeddingUrl }
        }
        return { success: false, error: 'Embedding server not running' }
      }

      // For other backends, return the base URL (they might use the same server)
      return { success: true, url: service.baseUrl }
    },
  )

  ipcMain.handle(
    'startTranscriptionServer',
    async (_event: IpcMainInvokeEvent, modelName: string) => {
      if (!serviceRegistry) {
        return { success: false, error: 'Service registry not ready' }
      }
      const service = serviceRegistry.getService('openvino-backend')
      if (!service) {
        return { success: false, error: 'OpenVINO backend service not found' }
      }

      // Check if service has startTranscriptionServer method
      if (
        'startTranscriptionServer' in service &&
        typeof service.startTranscriptionServer === 'function'
      ) {
        try {
          await service.startTranscriptionServer(modelName)
          return { success: true }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          appLogger.error(
            `Failed to start transcription server: ${errorMessage}`,
            'electron-backend',
          )
          return { success: false, error: errorMessage }
        }
      }

      return { success: false, error: 'Transcription server not supported' }
    },
  )

  ipcMain.handle('stopTranscriptionServer', async (_event: IpcMainInvokeEvent) => {
    if (!serviceRegistry) {
      return { success: false, error: 'Service registry not ready' }
    }
    const service = serviceRegistry.getService('openvino-backend')
    if (!service) {
      return { success: false, error: 'OpenVINO backend service not found' }
    }

    // Check if service has stopTranscriptionServer method
    if (
      'stopTranscriptionServer' in service &&
      typeof service.stopTranscriptionServer === 'function'
    ) {
      try {
        await service.stopTranscriptionServer()
        return { success: true }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        appLogger.error(`Failed to stop transcription server: ${errorMessage}`, 'electron-backend')
        return { success: false, error: errorMessage }
      }
    }

    return { success: false, error: 'Transcription server not supported' }
  })

  ipcMain.handle('getTranscriptionServerUrl', async (_event: IpcMainInvokeEvent) => {
    if (!serviceRegistry) {
      return { success: false, error: 'Service registry not ready' }
    }
    const service = serviceRegistry.getService('openvino-backend')
    if (!service) {
      return { success: false, error: 'OpenVINO backend service not found' }
    }

    // Check if service has getTranscriptionServerUrl method
    if (
      'getTranscriptionServerUrl' in service &&
      typeof service.getTranscriptionServerUrl === 'function'
    ) {
      const transcriptionUrl = service.getTranscriptionServerUrl()
      if (transcriptionUrl) {
        return { success: true, url: transcriptionUrl }
      }
      return { success: false, error: 'Transcription server not running' }
    }

    return { success: false, error: 'Transcription server not supported' }
  })

  ipcMain.on('ondragstart', async (event, filePath) => {
    const imagePath = getAssetPathFromUrl(filePath)
    if (!imagePath) return
    let thumbnail: Electron.NativeImage
    try {
      thumbnail = await nativeImage.createThumbnailFromPath(imagePath, { height: 128, width: 128 })
    } catch (_e: unknown) {
      thumbnail = await nativeImage.createThumbnailFromPath(path.join(externalRes, 'cam.png'), {
        height: 128,
        width: 128,
      })
    }
    event.sender.startDrag({
      file: imagePath,
      icon: thumbnail,
    })
  })

  ipcMain.handle('updatePresetsFromIntelRepo', () => {
    const mode = resolveProductMode(settings)
    const variant = settings.isDemoModeEnabled ? 'demo' : 'presets'
    const config = getPresetLoadConfig(settings)
    return updateIntelPresets(
      settings.remoteRepository,
      mode,
      variant,
      config.baseDir,
      config.modeDir,
    )
  })

  ipcMain.handle('reloadPresets', async () => {
    const config = getPresetLoadConfig(settings)
    try {
      await filterPartnerPresets(config.baseDir)
    } catch (error) {
      appLogger.error(`Failed to filter partner presets: ${error}`, 'electron-backend')
    }
    try {
      const basePresets = applyPresetFilter(
        await readPresetsFromDir(config.baseDir, config.imageFallbackDirs),
        config,
      )
      const modePresets = await readPresetsFromDir(config.modeDir, config.imageFallbackDirs)

      for (const [name, preset] of modePresets) {
        basePresets.set(name, preset)
      }

      return [...basePresets.values()]
    } catch (error) {
      appLogger.error(`Failed to load presets: ${error}`, 'electron-backend')
      return []
    }
  })

  ipcMain.handle('getUserPresetsPath', async () => {
    const userDataPath = app.getPath('documents')
    const presetsPath = path.join(userDataPath, 'AI Playground', 'presets')
    // Ensure directory exists
    await fs.promises.mkdir(presetsPath, { recursive: true })
    return presetsPath
  })

  ipcMain.handle('loadUserPresets', async () => {
    try {
      const userDataPath = app.getPath('documents')
      const presetsPath = path.join(userDataPath, 'AI Playground', 'presets')
      const presets = await readPresetsFromDir(presetsPath)
      return [...presets.values()]
    } catch (error) {
      appLogger.error(`Failed to load user presets: ${error}`, 'electron-backend')
      return []
    }
  })

  ipcMain.handle('saveUserPreset', async (_event, presetContent: string) => {
    try {
      const userDataPath = app.getPath('documents')
      const presetsPath = path.join(userDataPath, 'AI Playground', 'presets')
      await fs.promises.mkdir(presetsPath, { recursive: true })

      // Parse to get preset name for filename
      const preset = JSON.parse(presetContent)
      const filename = `${preset.name.replace(/[^a-z0-9]/gi, '_')}.json`
      const filePath = path.join(presetsPath, filename)

      await fs.promises.writeFile(filePath, presetContent, { encoding: 'utf-8' })
      appLogger.info(`Saved user preset to ${filePath}`, 'electron-backend')
      return true
    } catch (error) {
      appLogger.error(`Failed to save user preset: ${error}`, 'electron-backend')
      return false
    }
  })

  // Version management IPC handlers for frontend store integration
  ipcMain.handle('resolveBackendVersion', async (_event, serviceName: BackendServiceName) => {
    return await resolveBackendVersion(serviceName, settings)
  })

  ipcMain.handle('getGitHubRepoUrl', () => {
    return getGitHubRepoUrl(settings)
  })

  ipcMain.handle('getInstalledBackendVersion', async (_event, serviceName: BackendServiceName) => {
    if (!serviceRegistry) {
      appLogger.warn('Service registry not ready', 'electron-backend')
      return undefined
    }
    const service = serviceRegistry.getService(serviceName)
    if (
      !service ||
      !('getInstalledVersion' in service) ||
      typeof service.getInstalledVersion !== 'function'
    ) {
      return undefined
    }
    try {
      return await service.getInstalledVersion()
    } catch (error) {
      appLogger.error(
        `Failed to get installed version for ${serviceName}: ${error}`,
        'electron-backend',
      )
      return undefined
    }
  })

  // ComfyUI Tools IPC handlers
  ipcMain.handle('comfyui:isGitInstalled', async () => {
    return await comfyuiTools.isGitInstalled()
  })

  ipcMain.handle('comfyui:isComfyUIInstalled', () => {
    const comfyService = serviceRegistry?.getService('comfyui-backend') as
      | ComfyUiBackendService
      | undefined
    if (!comfyService) {
      throw new Error('ComfyUI backend service not found')
    }
    return comfyuiTools.isComfyUIInstalled(comfyService.serviceDir)
  })

  ipcMain.handle('comfyui:getGitRef', async (_event, repoDir: string) => {
    return await comfyuiTools.getGitRef(repoDir)
  })

  ipcMain.handle('comfyui:isPackageInstalled', async (_event, packageSpecifier: string) => {
    return await comfyuiTools.isPackageInstalled(packageSpecifier)
  })

  ipcMain.handle('comfyui:installPypiPackage', async (_event, packageSpecifier: string) => {
    const comfyService = serviceRegistry?.getService('comfyui-backend') as
      | ComfyUiBackendService
      | undefined
    return await comfyuiTools.installPypiPackage(
      packageSpecifier,
      comfyService?.getTorchBackendEnv(),
    )
  })

  ipcMain.handle(
    'comfyui:isCustomNodeInstalled',
    (_event, nodeRepoRef: comfyuiTools.ComfyUICustomNodeRepoId) => {
      const comfyService = serviceRegistry?.getService('comfyui-backend') as
        | ComfyUiBackendService
        | undefined
      if (!comfyService) {
        throw new Error('ComfyUI backend service not found')
      }
      return comfyuiTools.isCustomNodeInstalled(nodeRepoRef, comfyService.serviceDir)
    },
  )

  ipcMain.handle(
    'comfyui:downloadCustomNode',
    async (_event, nodeRepoData: comfyuiTools.ComfyUICustomNodeRepoId) => {
      const comfyService = serviceRegistry?.getService('comfyui-backend') as
        | ComfyUiBackendService
        | undefined
      if (!comfyService) {
        throw new Error('ComfyUI backend service not found')
      }
      const envAndWheels: comfyuiTools.ComfyUiInstallOptions = {
        extraEnv: comfyService.getTorchBackendEnv(),
        skipExtraWheels: comfyService.comfyUiVariantName !== 'xpu',
      }
      return await comfyuiTools.downloadCustomNode(
        nodeRepoData,
        comfyService.serviceDir,
        envAndWheels,
      )
    },
  )

  ipcMain.handle(
    'comfyui:uninstallCustomNode',
    async (_event, nodeRepoData: comfyuiTools.ComfyUICustomNodeRepoId) => {
      const comfyService = serviceRegistry?.getService('comfyui-backend') as
        | ComfyUiBackendService
        | undefined
      if (!comfyService) {
        throw new Error('ComfyUI backend service not found')
      }
      return await comfyuiTools.uninstallCustomNode(nodeRepoData, comfyService.serviceDir)
    },
  )

  ipcMain.handle('comfyui:listInstalledCustomNodes', () => {
    const comfyService = serviceRegistry?.getService('comfyui-backend') as
      | ComfyUiBackendService
      | undefined
    if (!comfyService) {
      throw new Error('ComfyUI backend service not found')
    }
    return comfyuiTools.listInstalledCustomNodes(comfyService.serviceDir)
  })

  // MCP server IPC handlers
  ipcMain.handle('mcp:startServer', async (_event, serverId: string) => {
    return await startMcpServer(serverId)
  })

  ipcMain.handle('mcp:listServers', () => {
    return listMcpServers()
  })

  ipcMain.handle('mcp:stopServer', async (_event, serverId: string) => {
    return await stopMcpServer(serverId)
  })

  ipcMain.handle('mcp:getServerStatus', (_event, serverId: string) => {
    return getMcpServerStatus(serverId)
  })

  ipcMain.handle('mcp:listServerTools', async (_event, serverId: string) => {
    return await listMcpServerTools(serverId)
  })

  ipcMain.handle(
    'mcp:invokeServerTool',
    async (_event, serverId: string, toolName: string, args: Record<string, unknown>) => {
      return await invokeMcpServerTool(serverId, toolName, args)
    },
  )

  // MCP config file handlers
  // TODO: Consider consolidating with openImageWithSystem/openImageInFolder
  // into generic openFileWithSystem/openFileInFolder that take file paths
  ipcMain.on('mcp:openConfig', () => {
    const configPath = getMcpConfigPath()
    shell.openPath(configPath)
  })

  ipcMain.on('mcp:openConfigInFolder', () => {
    const configPath = getMcpConfigPath()
    if (process.platform === 'win32') {
      exec(`explorer.exe /select, "${configPath}"`)
    } else {
      shell.showItemInFolder(configPath)
    }
  })

  ipcMain.handle('mcp:reloadConfig', async () => {
    await stopAllMcpServers()
    return listMcpServers()
  })

  ipcMain.handle(
    'mcp:addServer',
    async (
      _event,
      serverId: string,
      config:
        | { type?: 'stdio'; command: string; args?: string[]; displayName?: string }
        | { type: 'http'; url: string; headers?: Record<string, string>; displayName?: string },
    ) => {
      return addMcpServer(serverId, config)
    },
  )

  ipcMain.handle('mcp:getServerConfig', (_event, serverId: string) => {
    return getMcpServerConfig(serverId)
  })

  ipcMain.handle('mcp:updateServer', async (_event, serverId: string, config: McpServerConfig) => {
    await stopMcpServer(serverId)
    return updateMcpServer(serverId, config)
  })

  ipcMain.handle('mcp:removeServer', async (_event, serverId: string) => {
    await stopMcpServer(serverId)
    return removeMcpServer(serverId)
  })

  const getAssetPathFromUrl = (url: string) => {
    // Handle aipg-media:// URLs
    if (url.startsWith('aipg-media://')) {
      const decodedUrl = decodeURIComponent(url.replace(/^aipg-media:\/\//i, ''))
      return path.join(mediaDir, decodedUrl)
    }

    // Existing logic for HTTP URLs
    const imageUrl = URL.parse(url)
    if (!imageUrl) {
      console.error('Could not find image for URL', { url })
      return
    }

    const comfyBackendUrl = serviceRegistry?.getService('comfyui-backend')?.baseUrl
    const backend = comfyBackendUrl && url.includes(comfyBackendUrl) ? 'comfyui' : 'service'

    const imageSubPath =
      backend === 'comfyui'
        ? path.join(
            imageUrl.searchParams.get('subfolder') ?? '',
            imageUrl.searchParams.get('filename') ?? '',
          )
        : imageUrl.pathname
    return path.join(mediaDir, imageSubPath)
  }

  ipcMain.on('openImageWithSystem', (_event, url: string) => {
    const imagePath = getAssetPathFromUrl(url)
    if (!imagePath) return
    shell.openPath(imagePath)
  })

  ipcMain.on('openImageInFolder', (_event, url: string) => {
    const imagePath = getAssetPathFromUrl(url)
    if (!imagePath) return

    // Open the image with the default system image viewer
    if (process.platform === 'win32') {
      exec(`explorer.exe /select, "${imagePath}"`)
    } else {
      shell.showItemInFolder(imagePath)
    }
  })
}

ipcMain.on(
  'openImageWin',
  (_: IpcMainEvent, url: string, title: string, width: number, height: number) => {
    const display = screen.getPrimaryDisplay()
    width += 32
    height += 48
    if (width > display.workAreaSize.width) {
      width = display.workAreaSize.width
    } else if (height > display.workAreaSize.height) {
      height = display.workAreaSize.height
    }
    const imgWin = new BrowserWindow({
      icon: path.join(process.env.VITE_PUBLIC, 'app-ico.svg'),
      resizable: true,
      center: true,
      frame: true,
      width: width,
      height: height,
      autoHideMenuBar: true,
      show: false,
      parent: win || undefined,
      webPreferences: {
        devTools: false,
      },
    })
    imgWin.setMenu(null)
    imgWin.loadURL(url)
    imgWin.once('ready-to-show', function () {
      imgWin.show()
      imgWin.setTitle(title)
    })
  },
)

ipcMain.handle('showSaveDialog', async (_event, options: Electron.SaveDialogOptions) => {
  dialog
    .showSaveDialog(options)
    .then((result) => {
      return result
    })
    .catch((error) => {
      appLogger.error(`${JSON.stringify(error, Object.getOwnPropertyNames, 2)}`, 'electron-backend')
    })
})

function needAdminPermission() {
  return new Promise<boolean>((resolve) => {
    const filename = path.join(externalRes, `${randomUUID()}.txt`)
    fs.writeFile(filename, '', (err) => {
      if (err) {
        if (err && err.code == 'EPERM') {
          if (path.parse(externalRes).root == path.parse(process.env.windir!).root) {
            resolve(!isAdmin())
          }
        } else {
          resolve(false)
        }
      } else {
        fs.rmSync(filename)
        resolve(false)
      }
    })
  })
}

function isAdmin(): boolean {
  if (process.platform !== 'win32') {
    return false
  }
  const lib = koffi.load('Shell32.dll')
  try {
    const IsUserAnAdmin = lib.func('IsUserAnAdmin', 'bool', [])
    return IsUserAnAdmin()
  } finally {
    lib.unload()
  }
}

app.whenReady().then(async () => {
  /*
    The current user does not have write permission for files in the program directory and is not an administrator.
    Close the current program and let the user start the program with administrator privileges
    */
  if (await needAdminPermission()) {
    if (singleInstanceLock) {
      app.releaseSingleInstanceLock()
    }
    //It is possible that the program is installed in a directory that requires administrator privileges
    const message = `start "" "${process.argv.join(' ').trim()}`
    sudo.exec(message, (_err, _stdout, _stderr) => {
      app.exit(0)
    })
    return
  }
  /**Single instance processing */
  if (!singleInstanceLock) {
    dialog.showMessageBoxSync({
      message:
        app.getLocale() == 'zh-CN'
          ? '本程序仅允许单实例运行，确认后本次运行将自动结束'
          : 'This program only allows a single instance to run, and the run will automatically end after confirmation',
      title: 'error',
      type: 'error',
    })
    app.exit()
  } else {
    const settings = await loadSettings()

    const modelsDir = path.resolve(
      app.isPackaged
        ? path.join(process.resourcesPath, 'models')
        : path.join(__dirname, '../../../models'),
    )
    // Start temp-folder cleanup without blocking application startup
    void cleanupTempFolders(modelsDir)

    initEventHandle()

    // Custom protocol docking is file protocol
    protocol.handle('aipg-media', async (request) => {
      console.log('request', request)
      const decodedUrl = decodeURIComponent(
        request.url.replace(new RegExp(`^aipg-media://`, 'i'), '/'),
      )

      const fullPath = path.join(mediaDir, decodedUrl)

      const normalizedPath = path.normalize(fullPath.replace(/(\/|\\)$/, ''))
      const response = await net.fetch(`file://${normalizedPath}`)
      return response
    })
    const window = await createWindow()
    await initServiceRegistry(window, settings)
    spawnLangchainUtilityProcess()
  }
})
