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
  session,
  shell,
  utilityProcess,
  UtilityProcess,
} from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'fs'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)
import { randomUUID } from 'node:crypto'
import sudo from 'sudo-prompt'
import { PathsManager } from './pathsManager'
import { appLoggerInstance } from './logging/logger.ts'
import {
  aiplaygroundApiServiceRegistry,
  ApiServiceRegistryImpl,
} from './subprocesses/apiServiceRegistry'
import {
  ComfyUiBackendService,
  COMFYUI_DEFAULT_PARAMETERS,
} from './subprocesses/comfyUIBackendService'
import { AiBackendService } from './subprocesses/aiBackendService'
import { HomeAgentBackendService } from './subprocesses/homeAgentBackendService'
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
  detectAndRegisterAutoMcpServers,
  getMcpConfigPath,
  getMcpServerConfig,
  isAutoDetectId,
  updateMcpServer,
  removeMcpServer,
  type McpServerConfig,
} from './subprocesses/mcpServers'
import { externalResourcesDir, getMediaDir } from './util.ts'
import { packagedResourcesRoot } from './aipgRoot.ts'
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
  excludeVariantBackends: z.array(z.string()).optional(),
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
  app.isPackaged ? packagedResourcesRoot() : path.join(__dirname, '../../external/'),
)

const modesDir = path.resolve(
  app.isPackaged
    ? path.join(packagedResourcesRoot(), 'modes')
    : path.join(__dirname, '../../../modes/'),
)
// On Linux (incl. headless Xvfb/VNC), Chromium's GPU process is often "not
// usable" and Electron aborts on startup. Disable hardware acceleration so the
// software rasterizer is used. This does NOT affect AI/compute workloads, which
// use Level Zero/SYCL/Vulkan directly. --no-sandbox avoids SUID-sandbox issues.
if (process.platform === 'linux') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('no-sandbox')
}
const singleInstanceLock = app.requestSingleInstanceLock()

const appLogger = appLoggerInstance

let win: BrowserWindow | null
let serviceRegistry: ApiServiceRegistryImpl | null = null
const mediaDir = getMediaDir()
fs.mkdirSync(mediaDir, { recursive: true })
const mediaInputDir = path.join(mediaDir, 'input')
fs.mkdirSync(mediaInputDir, { recursive: true })

/** Resolve aipg-media://… to an absolute file path under `mediaDir` (no path traversal). */
function getLocalPathFromAipgMediaUrl(url: string): string | null {
  if (typeof url !== 'string' || !url.startsWith('aipg-media://')) return null
  // `aipg-media` is registered as a *standard* scheme, so Chromium parses the
  // segment after `://` as the URL authority and lowercases it. The current
  // URL format therefore keeps the media-relative path in the URL *path* under
  // a constant `media` authority (see `mediaUrl()` in `src/lib/utils.ts`) so
  // case-sensitive filenames survive on case-sensitive filesystems (Linux).
  //
  // Legacy URLs (`aipg-media://<relative-path>`) put the path directly in the
  // authority; keep resolving those for already-persisted media references.
  // (Their case was lost to the authority lowercasing, so they only ever
  // resolved on case-insensitive filesystems — unchanged by this branch.)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const relativeRaw = parsed.host === 'media' ? parsed.pathname : parsed.host + parsed.pathname
  // Strip any trailing slash — Chromium occasionally appends one to
  // custom-protocol URLs (e.g. `…/foo.png/`), and `net.fetch(file://.../foo.png/)`
  // treats the trailing slash as "directory" and fails.
  // `decodeURIComponent` throws `URIError` on malformed `%` sequences (e.g.
  // `%E0`); treat that as an invalid URL rather than letting the exception
  // escape into the protocol handler or IPC reply.
  let decodedUrl: string
  try {
    decodedUrl = decodeURIComponent(relativeRaw.replace(/[/\\]+$/, ''))
  } catch {
    return null
  }
  const fullPath = path.normalize(path.join(mediaDir, decodedUrl))
  const base = path.resolve(mediaDir)
  const relative = path.relative(base, fullPath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return fullPath
}
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
  // Gates the Home Agent feature (Telegram bridge backend, setup wizard surface,
  // header toggle, bundled preset). Default false: opt-in by editing settings.json.
  isHomeAgentEnabled: z.boolean().default(false),
  languageOverride: z.string().nullable().default(null),
  remoteRepository: z.string().default('intel/ai-playground'),
  huggingfaceEndpoint: z.string().default('https://huggingface.co'),
  mcpAutoDetectionDismissed: z.array(z.string()).default([]),
  // Allowed OpenVINO devices for image-gen dropdowns (in-process upscale +
  // OVMS image variants). Case-insensitive prefix match against device IDs.
  // Default excludes NPU because RealESRGAN_x4plus and SDXL exceed current
  // Intel NPU memory budgets on most shipping hardware. Override per-machine
  // by editing settings.json, e.g. ["AUTO", "CPU", "GPU", "NPU"] to re-enable.
  openvinoImageGenDevices: z.array(z.string()).default(['CPU', 'GPU']),
  /** When true, skip hardware probe and treat Phison SSD as detected (optional overlay in userData settings). */
  PhisonSSDdetected: z.boolean().optional().default(false),
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
  excludeVariantBackends?: string[]
}

function getPresetLoadConfig(s: LocalSettings): PresetLoadConfig {
  const mode = resolveProductMode(s)
  const variant = s.isDemoModeEnabled ? 'demo' : 'presets'
  const modeConfig = loadModeConfig(mode)
  const basePresetsDir = path.join(modesDir, 'base', 'presets')
  // When the Home Agent feature is disabled, drop its bundled preset so it does
  // not appear in the chat preset selector. `includePresets` (when defined)
  // takes precedence over `excludePresets`, so we need to filter both lists.
  const includePresets = s.isHomeAgentEnabled
    ? modeConfig?.includePresets
    : modeConfig?.includePresets?.filter((p) => p !== 'home-agent-chat')
  const baseExcludePresets = modeConfig?.excludePresets ?? []
  const excludePresets = s.isHomeAgentEnabled
    ? modeConfig?.excludePresets
    : [...baseExcludePresets, 'home-agent-chat']
  return {
    baseDir: path.join(modesDir, 'base', variant),
    modeDir: path.join(modesDir, mode, variant),
    imageFallbackDirs: variant === 'demo' ? [basePresetsDir] : [],
    includePresets,
    excludePresets,
    excludeVariantBackends: modeConfig?.excludeVariantBackends,
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
  if (config.excludeVariantBackends?.length) {
    const excludedBackends = new Set(config.excludeVariantBackends)
    for (const [key, file] of presets) {
      try {
        const parsed = JSON.parse(file.content)
        if (parsed?.type !== 'comfy' || !Array.isArray(parsed.variants)) continue
        const filtered = parsed.variants.filter(
          (v: { backend?: string }) => !(v?.backend && excludedBackends.has(v.backend)),
        )
        if (filtered.length === parsed.variants.length) continue
        parsed.variants = filtered
        presets.set(key, { ...file, content: JSON.stringify(parsed) })
      } catch (e) {
        appLogger.warn(`Failed to filter variants for preset "${key}": ${e}`, 'electron-backend')
      }
    }
  }
  return presets
}

let settings = LocalSettingsSchema.parse({})
let demoProfile: DemoProfile | null = null

/** Packaged: `resources/settings.json` (same role as dev `external/settings-dev.json`). */
function getPackagedSettingsPath(): string {
  return path.join(packagedResourcesRoot(), 'settings.json')
}

/** Dev-only defaults shipped in the repo (read-only for the app). */
function getDevSettingsDefaultsPath(): string {
  return path.join(__dirname, '../../external/settings-dev.json')
}

/** Dev: userData overlay so edits do not touch the repo (avoids Vite reload loops). */
function getUserLocalSettingsPath(): string {
  return path.join(app.getPath('userData'), 'ai-playground-local-settings.json')
}

/** Packaged: read/write `resources/settings.json`. Dev: read/write userData overlay only. */
function getWritableSettingsPath(): string {
  if (app.isPackaged) {
    return getPackagedSettingsPath()
  }
  return getUserLocalSettingsPath()
}

function persistLocalSettingsToDisk(): void {
  const settingPath = getWritableSettingsPath()
  const parsed = LocalSettingsSchema.parse(settings)
  const serialized = JSON.stringify(parsed, null, 2)
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
      // Required so canvases can read pixels from `aipg-media://` images
      // (mask / outpaint editors call `getImageData()` / `toDataURL()`).
      // The handler below must also emit `Access-Control-Allow-Origin`.
      corsEnabled: true,
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
    let devDefaultsRaw: Record<string, unknown> | null = null
    appLogger.info(`loading dev defaults from ${defaultsPath}`, 'electron-backend')
    if (fs.existsSync(defaultsPath)) {
      try {
        devDefaultsRaw = JSON.parse(fs.readFileSync(defaultsPath, { encoding: 'utf8' }))
        settings = LocalSettingsSchema.parse({ ...settings, ...devDefaultsRaw })
      } catch (e) {
        appLogger.error(`failed to load dev defaults: ${e}`, 'electron-backend')
      }
    }
    const userPath = getUserLocalSettingsPath()
    appLogger.info(`loading dev user settings from ${userPath}`, 'electron-backend')
    if (fs.existsSync(userPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(userPath, { encoding: 'utf8' }))
        settings = LocalSettingsSchema.parse({ ...settings, ...raw })
      } catch (e) {
        appLogger.error(`failed to load dev user settings: ${e}`, 'electron-backend')
      }
    }
    // PhisonSSDdetected: true if userData *or* repo settings-dev says so. Repo true still beats
    // stale userData false; userData true still works when repo has false (dev Phison UI without hardware).
    if (devDefaultsRaw) {
      const repoWantsPhison =
        'PhisonSSDdetected' in devDefaultsRaw && Boolean(devDefaultsRaw.PhisonSSDdetected)
      settings = LocalSettingsSchema.parse({
        ...settings,
        PhisonSSDdetected: Boolean(settings.PhisonSSDdetected) || repoWantsPhison,
      })
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

  // Pipe renderer console warnings/errors to the app log file. Writes via
  // logMessageToFile directly: the regular logger methods echo every message
  // back to the renderer's debug stream, which a console-logging renderer
  // would turn into a feedback loop. Rate-limited so a hot error loop can't
  // bloat the log file (appendFileSync blocks the main process).
  const RENDERER_LOG_WINDOW_MS = 1000
  const MAX_RENDERER_LOGS_PER_WINDOW = 10
  let rendererLogWindowStart = 0
  let rendererLogCount = 0
  win.webContents.on('console-message', (event) => {
    if (event.level !== 'warning' && event.level !== 'error') return
    const now = Date.now()
    if (now - rendererLogWindowStart > RENDERER_LOG_WINDOW_MS) {
      rendererLogWindowStart = now
      rendererLogCount = 0
    }
    if (rendererLogCount < MAX_RENDERER_LOGS_PER_WINDOW) {
      appLogger.logMessageToFile(
        `[${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`,
        'renderer',
      )
    } else if (rendererLogCount === MAX_RENDERER_LOGS_PER_WINDOW) {
      appLogger.logMessageToFile('rate limit exceeded, suppressing further messages this second', 'renderer')
    }
    rendererLogCount++
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    appLogger.error(
      `render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`,
      'electron-backend',
      true,
    )
    dialog.showErrorBox(
      'AI Playground — Renderer Crashed',
      `The application window has crashed unexpectedly.\n\n` +
        `Reason: ${details.reason}\n` +
        `Exit code: ${details.exitCode}\n\n` +
        `Check logs for details:\n${appLogger.pathToLogFiles}`,
    )
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return // ERR_ABORTED: navigation cancelled, not a failure
    appLogger.error(
      `did-fail-load: code=${errorCode} desc="${errorDescription}" url="${validatedURL}"`,
      'electron-backend',
      true,
    )
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
      // Defer to the upstream backend's `Access-Control-Allow-Origin` if
      // it is already set. Otherwise the backend's specific origin (e.g.
      // `http://localhost:25413`) gets joined with our wildcard, yielding
      // `http://localhost:25413, *` which browsers reject as invalid.
      if (!headers.has('Access-Control-Allow-Origin')) {
        headers.append('Access-Control-Allow-Origin', '*')
      }
      append('Access-Control-Allow-Methods', 'GET')
      append('Access-Control-Allow-Methods', 'POST')
      append('Access-Control-Allow-Headers', 'x-requested-with')
      append('Access-Control-Allow-Headers', 'Content-Type')
      append('Access-Control-Allow-Headers', 'Authorization')
      // Loopback auth token header used by AI Playground's renderer to
      // authenticate to the ai-backend Flask service. Must be in the
      // preflight allow-list or the browser blocks the request.
      append('Access-Control-Allow-Headers', 'X-AIPG-Auth')
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
  const homeAgent = serviceRegistry.getService('home-agent-backend')
  if (homeAgent instanceof HomeAgentBackendService) {
    homeAgent.registerIpcHandlers()
  }
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

  ipcMain.handle(
    'readAipgMediaAsBase64',
    async (
      _event,
      url: string,
    ): Promise<{ success: true; data: string } | { success: false; error: string }> => {
      const filePath = getLocalPathFromAipgMediaUrl(url)
      if (!filePath) {
        return { success: false, error: 'invalid or unsafe aipg-media URL' }
      }
      if (!fs.existsSync(filePath)) {
        return { success: false, error: `file not found (${path.basename(filePath)})` }
      }
      try {
        return { success: true, data: fs.readFileSync(filePath).toString('base64') }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  )

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

  ipcMain.handle('getBackendAuthToken', (_event: IpcMainInvokeEvent, serviceName: string) => {
    if (!serviceRegistry) {
      return ''
    }
    const service = serviceRegistry.getService(serviceName)
    if (service instanceof AiBackendService) {
      return service.getLoopbackAuthToken()
    }
    if (service instanceof ComfyUiBackendService) {
      return service.getLoopbackAuthToken()
    }
    if (service instanceof HomeAgentBackendService) {
      return service.getLoopbackAuthToken()
    }
    return ''
  })

  ipcMain.handle('comfyui:openInBrowser', async () => {
    const comfyService = serviceRegistry?.getService('comfyui-backend') as
      | ComfyUiBackendService
      | undefined
    if (!comfyService) {
      return { success: false, error: 'ComfyUI backend service not found' }
    }
    const baseUrl = comfyService.baseUrl
    if (!baseUrl) {
      return { success: false, error: 'ComfyUI backend has no base URL yet' }
    }
    const token = comfyService.getLoopbackAuthToken()
    // /aipg/launch (provided by the bundled aipg-auth custom_node) validates
    // launch_token against AIPG_LOOPBACK_TOKEN, then issues an HttpOnly,
    // SameSite=Strict aipg_session cookie and redirects to /. After that
    // the user's default browser uses the cookie for all subsequent
    // requests; the launch_token does not need to live in browser history.
    const url = `${baseUrl}/aipg/launch?launch_token=${encodeURIComponent(token)}`
    try {
      await shell.openExternal(url)
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
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

  ipcMain.handle('detectPhisonSsd', async () => {
    if (settings.PhisonSSDdetected) {
      appLoggerInstance.info(
        'detectPhisonSsd: returning true (PhisonSSDdetected in local settings)',
        'electron-backend',
      )
      return { detected: true }
    }
    if (process.platform !== 'win32') {
      return { detected: false }
    }
    try {
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "Get-PhysicalDisk | Select-Object DeviceId,FirmwareVersion | ConvertTo-Json -Compress"',
        { timeout: 20000, windowsHide: true },
      )
      const trimmed = stdout.trim()
      if (!trimmed) {
        return { detected: false }
      }
      const parsed = JSON.parse(trimmed) as
        | { FirmwareVersion?: string }
        | Array<{ FirmwareVersion?: string }>
      const disks = Array.isArray(parsed) ? parsed : [parsed]
      const detected = disks.some((d) => {
        const fw = d.FirmwareVersion
        return typeof fw === 'string' && fw.toUpperCase().startsWith('EVFZ')
      })
      return { detected }
    } catch (e) {
      appLoggerInstance.warn(`detectPhisonSsd failed: ${e}`, 'electron-backend')
      return { detected: false }
    }
  })

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
        const homeAgentSvc = serviceRegistry?.getService('home-agent-backend')
        if (homeAgentSvc instanceof HomeAgentBackendService) {
          homeAgentSvc.notifyUpstreamReady(service.baseUrl ?? '')
        }
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

  ipcMain.handle(
    'ensureOvmsImageReady',
    async (
      _event: IpcMainInvokeEvent,
      serviceName: string,
      modelName: string,
      keepModelsLoaded?: boolean,
      resolution?: string,
    ) => {
      if (!serviceRegistry) {
        return { success: false, error: 'Service registry not ready' }
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        return { success: false, error: `Service ${serviceName} not found` }
      }

      if ('startImageServer' in service && typeof service.startImageServer === 'function') {
        try {
          await service.startImageServer(modelName, keepModelsLoaded, resolution)
          const url =
            'getImageServerUrl' in service && typeof service.getImageServerUrl === 'function'
              ? service.getImageServerUrl()
              : null
          if (url) {
            return { success: true, url }
          }
          return { success: false, error: 'Image server started but URL not available' }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          appLogger.error(
            `Failed to ensure OVMS image readiness: ${errorMessage}`,
            'electron-backend',
          )
          return { success: false, error: errorMessage }
        }
      }

      return { success: false, error: 'Image server not supported by this backend' }
    },
  )

  ipcMain.handle('stopOvmsImageServer', async (_event: IpcMainInvokeEvent) => {
    if (!serviceRegistry) {
      return { success: false, error: 'Service registry not ready' }
    }
    const service = serviceRegistry.getService('openvino-backend')
    if (!service) {
      return { success: false, error: 'OpenVINO backend service not found' }
    }

    if ('stopImageServer' in service && typeof service.stopImageServer === 'function') {
      try {
        await service.stopImageServer()
        return { success: true }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        appLogger.error(`Failed to stop OVMS image server: ${errorMessage}`, 'electron-backend')
        return { success: false, error: errorMessage }
      }
    }

    return { success: false, error: 'Image server not supported' }
  })

  ipcMain.handle('getOvmsImageServerUrl', async (_event: IpcMainInvokeEvent) => {
    if (!serviceRegistry) {
      return { success: false, error: 'Service registry not ready' }
    }
    const service = serviceRegistry.getService('openvino-backend')
    if (!service) {
      return { success: false, error: 'OpenVINO backend service not found' }
    }

    if ('getImageServerUrl' in service && typeof service.getImageServerUrl === 'function') {
      const imageUrl = service.getImageServerUrl()
      if (imageUrl) {
        return { success: true, url: imageUrl }
      }
      return { success: false, error: 'Image server not running' }
    }

    return { success: false, error: 'Image server not supported' }
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

  // Auto-detect MCP servers (e.g., Acer MCP service installed via WindowsApps).
  // Runs on every startup so newly installed services are picked up and stale
  // versioned paths get refreshed after MSIX/Store updates.
  try {
    detectAndRegisterAutoMcpServers(settings.mcpAutoDetectionDismissed ?? [])
  } catch (e) {
    appLogger.warn(`MCP auto-detect failed: ${e}`, 'mcp')
  }

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
    const result = removeMcpServer(serverId)
    if (isAutoDetectId(serverId) && !settings.mcpAutoDetectionDismissed.includes(serverId)) {
      settings.mcpAutoDetectionDismissed = [...settings.mcpAutoDetectionDismissed, serverId]
      persistLocalSettingsToDisk()
    }
    return result
  })

  const getAssetPathFromUrl = (url: string) => {
    // Handle aipg-media:// URLs
    if (url.startsWith('aipg-media://')) {
      return getLocalPathFromAipgMediaUrl(url)
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
          // windir is only defined on Windows; on Linux/macOS this check is skipped.
          if (
            process.platform === 'win32' &&
            process.env.windir &&
            path.parse(externalRes).root == path.parse(process.env.windir).root
          ) {
            resolve(!isAdmin())
          } else {
            resolve(false)
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

/**
 * Route Electron `net.fetch` traffic (llama.cpp / OVMS / remote-update
 * downloads) through an HTTP(S) proxy when one is configured via the standard
 * `*_proxy` environment variables. Chromium's network stack does not reliably
 * honor these env vars on its own, so we read them and set the session proxy
 * explicitly. No-op when no proxy is set, so direct-internet users are
 * unaffected.
 *
 * Note: GUI launches (double-click from a file manager) do NOT inherit
 * `http_proxy` exported in `~/.profile`/`~/.bashrc`; launch from a terminal
 * where the vars are set, or configure a system-wide proxy.
 */
async function configureProxyFromEnv(): Promise<void> {
  const proxy =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY
  if (!proxy) {
    return
  }
  const noProxy = process.env.no_proxy || process.env.NO_PROXY
  const proxyBypassRules = noProxy
    ? noProxy
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .join(',')
    : undefined
  appLogger.info(
    `Configuring Electron session proxy from environment: ${proxy}${
      proxyBypassRules ? ` (bypass: ${proxyBypassRules})` : ''
    }`,
    'proxy',
  )
  await session.defaultSession.setProxy({ proxyRules: proxy, proxyBypassRules })
}

app.whenReady().then(async () => {
  // Startup diagnostic — helps diagnose installation and configuration issues
  appLogger.info(
    `startup: isPackaged=${app.isPackaged} platform=${process.platform} DIST="${process.env.DIST}" userData="${app.getPath('userData')}"`,
    'electron-backend',
    true,
  )

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

    // Honor *_proxy env vars for all backend downloads (net.fetch) before any
    // service setup kicks off.
    await configureProxyFromEnv()

    initEventHandle()

    // Custom protocol docking is file protocol.
    // Use the shared `getLocalPathFromAipgMediaUrl` helper so the protocol
    // handler enforces the same path-traversal containment as the IPC reader
    // — without it, crafted `aipg-media://../...` URLs could escape `mediaDir`.
    protocol.handle('aipg-media', async (request) => {
      const safePath = getLocalPathFromAipgMediaUrl(request.url)
      if (!safePath) {
        return new Response('Not Found', { status: 404 })
      }
      const upstream = await net.fetch(pathToFileURL(safePath).href)
      // `getImageData()` / `toDataURL()` on a canvas that drew an
      // `aipg-media://` image only succeed when the response carries CORS
      // headers AND the `<img>` opts in via `crossorigin="anonymous"`.
      // `*` is safe because the scheme only ever serves files under
      // `mediaDir`, already guarded by `getLocalPathFromAipgMediaUrl`.
      const headers = new Headers(upstream.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      })
    })
    const window = await createWindow()
    await initServiceRegistry(window, settings)
    spawnLangchainUtilityProcess()
  }
})
