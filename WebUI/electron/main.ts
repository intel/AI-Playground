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
  desktopCapturer,
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
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  utilityProcess,
  UtilityProcess,
} from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'fs'
import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)
import { randomUUID } from 'node:crypto'
import { PathsManager } from './pathsManager'
import { writableConfigFile } from './userConfig.ts'
import { appLoggerInstance } from './logging/logger.ts'
import {
  aiplaygroundApiServiceRegistry,
  ApiServiceRegistryImpl,
  peekApiServiceRegistry,
} from './subprocesses/apiServiceRegistry'
import {
  ComfyUiBackendService,
  COMFYUI_DEFAULT_PARAMETERS,
} from './subprocesses/comfyUIBackendService'
import { AiBackendService } from './subprocesses/aiBackendService'
import { HomeAgentBackendService } from './subprocesses/homeAgentBackendService'
import { startCloudProxy, type CloudProxy } from './cloudProxy'
import { Qwen3TtsBackendService } from './subprocesses/qwen3TtsBackendService'
import { WhisperBackendService } from './subprocesses/whisperBackendService'
import { LLAMACPP_DEFAULT_PARAMETERS } from './subprocesses/llamaCppBackendService'
import { filterPartnerPresets, updateIntelPresets } from './subprocesses/updateIntelPresets.ts'
import { probeFreedesktopSecretService, shouldForceBasicPasswordStore } from './linuxPasswordStore'
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
  close as closeWebBrowser,
  destroyWebBrowser,
  getState as getWebBrowserState,
  hide as hideWebBrowser,
  interact as interactWebBrowser,
  navigate as navigateWebBrowser,
  readPage as readWebBrowserPage,
  screenshot as screenshotWebBrowser,
  search as searchWebBrowser,
  setWebBrowserMainWindow,
  show as showWebBrowser,
  type WebBrowserInteraction,
} from './subprocesses/webBrowserManager'
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
import {
  cancelAgentTurn,
  deleteAgentSession,
  listAgentCapabilities,
  resetAgentSession,
  setAgentModeMainWindow,
  shutdownAgentMode,
  startAgentTurn,
  submitAgentToolResult,
} from './agentMode/piAgentManager'
import { setVerboseLogging as setVerboseAgentLogging } from './agentMode/piAgentLog.ts'
import { importAttachment } from './agentMode/workspaceAttachments.ts'
import { AgentModeTurnConfigSchema } from '@/types/agentIpc'
import { getAudioDir, getGamesDir, getMediaDir } from './util.ts'
import {
  arcadeCatalog,
  createGame,
  listGames,
  provisionalName,
  publishGame,
  readGame,
  setArcadeShown,
  writeArcade,
} from './gameLibrary.ts'
import { detectOem } from './subprocesses/oemDetection.ts'
import { packagedResourcesRoot, writableConfigRoot } from './aipgRoot.ts'
import { loadDemoProfile, type DemoProfile } from './demoProfile.ts'
import type { ModelPaths } from '@/assets/js/store/models.ts'
import type {
  IndexedDocument,
  EmbedInquiry,
  WarmupRequest,
  PhisonKmIngestConfig,
} from '@/assets/js/store/textInference.ts'
import { BackendServiceName } from '@/assets/js/store/backendServices.ts'
import {
  classifyDetectedDevices,
  detectGpuHardwareDevices,
  type GpuHardwareDevice,
} from './subprocesses/hardwareDiscovery.ts'
import { registerSettingsPersist } from './subprocesses/defaultDeviceSelection.ts'
import { appShutdown } from './shutdown.ts'
import {
  handleChatTelemetryEvent,
  initLaminarTracing,
  laminarConfig,
  shutdownLaminarTracing,
} from './laminar.ts'
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
  // Chromium may select gnome_libsecret from XDG_CURRENT_DESKTOP even when no
  // keyring daemon is running. setUsePlainTextEncryption cannot override that
  // backend, so --password-store=basic must be set before app.whenReady().
  if (
    shouldForceBasicPasswordStore({
      platform: process.platform,
      xdgCurrentDesktop: process.env.XDG_CURRENT_DESKTOP,
      secretServiceAvailable: probeFreedesktopSecretService(),
      passwordStoreAlreadySet: app.commandLine.hasSwitch('password-store'),
    })
  ) {
    app.commandLine.appendSwitch('password-store', 'basic')
  }
}
const singleInstanceLock = app.requestSingleInstanceLock()

const appLogger = appLoggerInstance

let win: BrowserWindow | null
let serviceRegistry: ApiServiceRegistryImpl | null = null

// Cloud Mode runs its networking in the main process via a loopback proxy (see
// cloudProxy.ts), so the renderer never calls remote providers directly. The
// proxy is started lazily on first use and torn down on quit.
let cloudProxy: CloudProxy | null = null

function cloudProviderKeyPath(providerId: string): string {
  return path.join(app.getPath('userData'), `cloud-provider-${providerId}.json`)
}

// Decrypt a provider's API key from safeStorage on disk. Runs in main only —
// the plaintext key never crosses the IPC boundary into the renderer.
function readCloudProviderKey(providerId: string): string | null {
  try {
    const raw = fs.readFileSync(cloudProviderKeyPath(providerId), 'utf-8')
    const blob = JSON.parse(raw) as { data: number[] }
    return safeStorage.decryptString(Buffer.from(blob.data))
  } catch {
    return null
  }
}

async function getCloudProxy(): Promise<CloudProxy> {
  if (!cloudProxy) {
    cloudProxy = await startCloudProxy(readCloudProviderKey)
  }
  return cloudProxy
}
const mediaDir = getMediaDir()
fs.mkdirSync(mediaDir, { recursive: true })
const mediaInputDir = path.join(mediaDir, 'input')
fs.mkdirSync(mediaInputDir, { recursive: true })
const audioDir = getAudioDir()
fs.mkdirSync(audioDir, { recursive: true })

/**
 * Roots the `aipg-media` scheme serves, keyed by URL authority: generated media
 * and the game library (a game's icon lives next to its HTML, not in the media
 * folder — see gameLibrary.ts).
 */
function aipgMediaRoots(): Record<string, string> {
  return { media: mediaDir, games: getGamesDir() }
}

/** Resolve aipg-media://… to an absolute file path under a served root (no path traversal). */
function getLocalPathFromAipgMediaUrl(url: string): string | null {
  if (typeof url !== 'string' || !url.startsWith('aipg-media://')) return null
  // `aipg-media` is registered as a *standard* scheme, so Chromium parses the
  // segment after `://` as the URL authority and lowercases it. The current
  // URL format therefore keeps the root-relative path in the URL *path* under a
  // constant authority naming the root (see `mediaUrl()` in `src/lib/utils.ts`)
  // so case-sensitive filenames survive on case-sensitive filesystems (Linux).
  //
  // Legacy URLs (`aipg-media://<relative-path>`) put the path directly in the
  // authority; keep resolving those against the media folder for
  // already-persisted media references. (Their case was lost to the authority
  // lowercasing, so they only ever resolved on case-insensitive filesystems —
  // unchanged by this branch.)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const roots = aipgMediaRoots()
  const root = roots[parsed.host] ?? mediaDir
  const relativeRaw = roots[parsed.host] ? parsed.pathname : parsed.host + parsed.pathname
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
  const fullPath = path.normalize(path.join(root, decodedUrl))
  const base = path.resolve(root)
  const relative = path.relative(base, fullPath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  return fullPath
}
let langchainChild: UtilityProcess | null = null

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
if (process.env.AIPG_DEBUGGING_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.AIPG_DEBUGGING_PORT)
}
// const APP_TOOL_HEIGHT = 209;
const appSize = {
  width: 820,
  height: 128,
  maxChatContentHeight: 0,
}
const ProductModeSchema = z.enum(['studio', 'essentials', 'nvidia'])
// User's preferred GPU, captured in the setup wizard. Identified by name
// (+ PCI id when known) so it can be matched to each backend's own device
// enumeration.
const PreferredDeviceSchema = z.object({
  name: z.string(),
  gpuDeviceId: z.string().nullable(),
  // Stable vendor UUID when the pre-install probe supplied one; preferred over
  // name/PCI when matching this device onto a backend's own detected list.
  uuid: z.string().nullable().optional(),
  // Per-instance probe id (GpuHardwareDevice.device); disambiguates two
  // identically-named GPUs in the wizard when no UUID is available.
  instanceId: z.string().optional(),
})
export type PreferredDevice = z.infer<typeof PreferredDeviceSchema>

const LocalSettingsSchema = z.object({
  productMode: ProductModeSchema.optional(),
  isDemoModeEnabled: z.boolean().default(false),
  demoModeResetInSeconds: z.number().min(1).nullable().default(null),
  demoModePasscode: z.string().optional(),
  // Gates the experimental "Agent" chat preset. Written by the Settings →
  // Developer checkbox, not a documented hand-edit flag. See docs/agent-preset.md.
  isAgentPresetEnabled: z.boolean().default(false),
  // Shows the machine-level debug controls (OEM override, Phison pretend, remote
  // repository, OpenVINO image-gen devices, verbose agent logging, dummy media
  // workflows, the title-bar wizard shortcut) in Settings → Developer, and
  // unlocks the dev-only test model + dummy workflows in a packaged build.
  showDebugSettingsInUI: z.boolean().default(false),
  // Components the user switched off in the setup wizard. Persisted because the
  // toggle used to live only in the renderer's wizard store: an installed
  // component the user had disabled was auto-started again by the main process on
  // the next launch (holding its port and GPU memory).
  disabledBackends: z.array(z.string()).default([]),
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
  // Last inference device chosen per backend, keyed by service name
  // (e.g. 'llamacpp-backend') or '<serviceName>:stt' for the OpenVINO STT
  // sub-device. Restored at boot in each service's detectDevices() so the app
  // does not reset to the default GPU (iGPU) on every restart.
  lastSelectedDevicePerBackend: z.record(z.string(), z.string()).default({}),
  // UUID counterpart of lastSelectedDevicePerBackend, same keys. Lets a backend
  // re-find the chosen device (and re-derive its current selector id) after a
  // driver update or enumeration reorder shifts the backend-local id. Empty when
  // the chosen device exposes no UUID (e.g. OpenVINO/llama.cpp devices).
  lastSelectedDeviceUuidPerBackend: z.record(z.string(), z.string()).default({}),
  // Machine-wide preferred inference device, chosen in the setup wizard from the
  // raw pre-install hardware probe. Consulted by each backend's detectDevices()
  // (when it has no per-backend selection yet) to pick a matching device, before
  // falling back to the automatic dGPU > iGPU > NPU > CPU ranking. null = no
  // explicit preference (use the automatic ranking).
  preferredDevice: PreferredDeviceSchema.nullable().default(null),
  /** When true, skip hardware probe and treat Phison SSD as detected (optional overlay in userData settings). */
  PhisonSSDdetected: z.boolean().optional().default(false),
  /**
   * Pretend the machine came from this OEM ('acer', …) instead of probing the
   * firmware, so partner branding can be exercised on any dev box.
   */
  oemVendorOverride: z.string().nullable().optional().default(null),
  // Linux without an OS keyring: the user confirmed the in-app Warning dialog
  // while saving a LAN chat password. Re-applied at startup so decrypt still
  // works; first-time opt-in is the renderer WarningDialog, not a native prompt.
  allowPlaintextSecretStorage: z.boolean().default(false),
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

/**
 * Bundled presets whose feature is switched off on this machine.
 *
 * They are dropped while presets are read, so nothing downstream — the selector,
 * the settings sidebar, preset switching — ever learns they exist. Anything that
 * still points at one (a persisted `activePresetName`) falls back on its own.
 */
function disabledFeaturePresets(s: LocalSettings): string[] {
  const disabled: string[] = []
  if (!s.isAgentPresetEnabled) disabled.push('agent')
  return disabled
}

function getPresetLoadConfig(s: LocalSettings): PresetLoadConfig {
  const mode = resolveProductMode(s)
  const variant = s.isDemoModeEnabled ? 'demo' : 'presets'
  const modeConfig = loadModeConfig(mode)
  const basePresetsDir = path.join(modesDir, 'base', 'presets')
  // `includePresets` (when defined) takes precedence over `excludePresets`, so a
  // disabled preset has to be taken out of both lists.
  const disabled = new Set(disabledFeaturePresets(s))
  const includePresets = modeConfig?.includePresets?.filter((p) => !disabled.has(p))
  const excludePresets = [...(modeConfig?.excludePresets ?? []), ...disabled]
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

/** Packaged read-only default: `resources/settings.json` (dev: `external/settings-dev.json`). */
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

/**
 * Where user settings edits are written. Packaged: the per-user config root
 * (a private folder in a shared all-users install; the resources root — i.e.
 * `getPackagedSettingsPath()` — otherwise). Dev: userData overlay only.
 */
function getWritableSettingsPath(): string {
  if (app.isPackaged) {
    return path.join(writableConfigRoot(), 'settings.json')
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

// Let backend services persist the settings they auto-populate (e.g. the default
// device chosen after install) without importing main.ts's private writer.
registerSettingsPersist(persistLocalSettingsToDisk)

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
    // Read the shipped/shared defaults first, then overlay this user's writable
    // copy. In a shared all-users install these are two different files (shared
    // read-only default vs. private per-user edits); otherwise they are the same
    // file and the overlay merge is an idempotent no-op.
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
    const writablePath = getWritableSettingsPath()
    if (writablePath !== packagedPath && fs.existsSync(writablePath)) {
      appLogger.info(`loading per-user settings from ${writablePath}`, 'electron-backend')
      try {
        const raw = JSON.parse(fs.readFileSync(writablePath, { encoding: 'utf8' }))
        settings = LocalSettingsSchema.parse({ ...settings, ...raw })
      } catch (e) {
        appLogger.error(`failed to load per-user settings: ${e}`, 'electron-backend')
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
  setWebBrowserMainWindow(win)
  setAgentModeMainWindow(win)
  win.on('close', () => {
    // Tear down the headless web-browser window so the app can quit cleanly.
    destroyWebBrowser()
    // Quit from the main window's own close rather than waiting for
    // `window-all-closed`, which Electron only emits once EVERY window is
    // destroyed. Hidden helper windows (agent browser sessions, an image
    // preview) used to swallow that event, and with it the whole teardown: the
    // backends kept running and the single-instance lock stayed held, so the
    // next launch was refused. macOS keeps the app alive by convention, so
    // there the backends are freed in `window-all-closed` instead.
    if (process.platform !== 'darwin') app.quit()
  })

  // Windows log-off / shutdown / restart. The session cannot be stopped and the
  // OS terminates us within seconds, so aim well below its patience: a partial
  // teardown beats leaving the backends behind.
  win.on('session-end', () => {
    appLogger.info('Windows session ending, stopping backends', 'electron-backend')
    void appShutdown.shutdown(3000)
  })

  // [HA-DIAG] Temporary: surface renderer `[HA-DIAG]` perf logs in the main
  // terminal stream (renderer console.log normally only reaches DevTools).
  // Remove together with the renderer-side [HA-DIAG] logging.
  win.webContents.on('console-message', (event: unknown, ...rest: unknown[]) => {
    const e = event as { message?: string }
    // Electron 35+ passes a single event object with `.message`; older builds
    // pass (event, level, message, line, sourceId).
    const message =
      typeof e?.message === 'string' ? e.message : ((rest[1] as string | undefined) ?? '')
    // Route through appLogger so the line reaches the in-app debug viewer (fed
    // by the `debugLog` IPC). appLogger also mirrors back to the renderer, which
    // App.vue re-logs as `[ha-diag] <message>` — that re-enters this handler. The
    // `[ha-diag]` source prefix (absent from the original renderer line) marks
    // the echo, so skipping it breaks the otherwise-infinite loop.
    if (message.includes('[HA-DIAG]') && !message.includes('[ha-diag]')) {
      appLogger.info(message, 'ha-diag')
    }
  })

  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      appLogger.onWebcontentReady(win!.webContents)
      // [HA-DIAG] One-shot marker: if you see this line, the rebuilt main process
      // with the renderer-log forwarder is running. If it's absent, main.ts did
      // not reload — fully restart Electron (HMR only reloads the renderer).
      appLogger.info(
        '[HA-DIAG] forwarder installed — renderer perf logs will appear here',
        'ha-diag',
      )
    }, 100)

    // Check localStorage for developer settings after page loads. `null` means the
    // renderer never stored a choice, which is what keeps DevTools opening by
    // default on an unpackaged run.
    setTimeout(async () => {
      try {
        const stored: boolean | null = await win!.webContents.executeJavaScript(
          `(() => {
            try {
              const developerSettings = localStorage.getItem('developerSettings');
              if (developerSettings) {
                const parsed = JSON.parse(developerSettings);
                if (typeof parsed.openDevConsoleOnStartup === 'boolean') {
                  return parsed.openDevConsoleOnStartup;
                }
              }
            } catch (e) {
              return null;
            }
            return null;
          })()`,
        )
        if (stored ?? !app.isPackaged) {
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
      appLogger.logMessageToFile(
        'rate limit exceeded, suppressing further messages this second',
        'renderer',
      )
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
      // Cloud Mode proxy routing headers (see cloudProxy.ts) — the renderer
      // sends these to the loopback proxy, so they must clear preflight too.
      append('Access-Control-Allow-Headers', 'X-Cloud-Upstream')
      append('Access-Control-Allow-Headers', 'X-Cloud-Provider')
      append('Access-Control-Allow-Headers', 'X-Cloud-Auth-Style')
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

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    if (url.startsWith('http://localhost')) shell.openExternal(url)
    if (url.startsWith('http://127.0.0.1')) shell.openExternal(url)
    return { action: 'deny' }
  })
  // The handler above only covers `window.open` / `target="_blank"`. A plain
  // link — an agent-provided workspace preview URL, a dropped file — navigates
  // this window instead, which replaces the whole app UI with that page and
  // leaves no way back. Only the app's own document may load here.
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppDocumentUrl(url)) return
    event.preventDefault()
    void shell.openExternal(url)
  })
  return win
}

/**
 * Load the app document into an already-created window.
 *
 * Split from createWindow so the renderer only boots once the service registry
 * exists: several stores fire IPC the moment they are created — homeAgent's
 * `channel:loadConfig`, whose handler is registered off the registry's
 * home-agent service, and the setup wizard's `getServices`. A renderer that won
 * that race got "No handler registered for 'channel:loadConfig'" and an empty
 * service list ("ai-backend service not found"), neither of which is retried.
 */
async function loadAppWindow(window: BrowserWindow): Promise<void> {
  if (VITE_DEV_SERVER_URL) {
    await window.loadURL(VITE_DEV_SERVER_URL)
    appLogger.info('load url:' + VITE_DEV_SERVER_URL, 'electron-backend')
  } else {
    await window.loadFile(path.join(process.env.DIST, 'index.html'))
  }
}

/** The renderer's own document — everything else belongs in the user's browser. */
function isAppDocumentUrl(url: string): boolean {
  if (VITE_DEV_SERVER_URL) {
    try {
      return new URL(url).origin === new URL(VITE_DEV_SERVER_URL).origin
    } catch {
      return false
    }
  }
  return url.startsWith(pathToFileURL(path.join(process.env.DIST, 'index.html')).href)
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
      embeddingCachePath: path.join(writableConfigRoot(), 'embeddingCache'),
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
      langchainChild = null
      // Respawning during teardown would resurrect the worker we just stopped.
      if (appShutdown.isShuttingDown()) return
      setTimeout(() => {
        spawnLangchainUtilityProcess()
      }, 1000)
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

// Everything the app spawns, torn down in dependency order: the agent first,
// because its extensions flush state on shutdown (persistent memory writes what
// it learned) and may still call into MCP, the services and the browser.
appShutdown.register({ name: 'agent mode', run: () => shutdownAgentMode() })
appShutdown.register({ name: 'MCP servers', run: () => stopAllMcpServers() })
appShutdown.register({ name: 'backend services', run: () => serviceRegistry?.stopAllServices() })
appShutdown.register({
  name: 'langchain worker',
  run: () => {
    langchainChild?.kill()
    langchainChild = null
  },
})
appShutdown.register({ name: 'web browser', run: () => destroyWebBrowser() })
appShutdown.register({ name: 'cloud proxy', run: () => cloudProxy?.close() })
// After the agent, so the spans its extensions emit while shutting down are
// still exported. No-op unless a developer opted into Laminar tracing.
appShutdown.register({ name: 'laminar tracing', run: () => shutdownLaminarTracing() })
// Last line of defence against a window outliving the teardown. Their titles go
// to the log first: if the app ever again refuses to close, this names the
// window that held it open instead of leaving it to guesswork.
appShutdown.register({
  name: 'helper windows',
  run: () => {
    const open = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    if (open.length === 0) return
    appLogger.info(
      `Destroying ${open.length} window(s) still open: ${open.map((w) => w.getTitle() || 'untitled').join(', ')}`,
      'electron-backend',
    )
    for (const window of open) window.destroy()
  },
})

// Quitting has to wait for the teardown: backends are spawned detached so they
// outlive us, and Electron would otherwise exit while they are still stopping.
app.on('before-quit', (event) => {
  event.preventDefault()
  void appShutdown.shutdown().finally(() => {
    if (singleInstanceLock) {
      app.releaseSingleInstanceLock()
    }
    // Skips the quit handlers we just ran manually; nothing is left to unwind.
    app.exit(0)
  })
})

// A dev restart, a `Ctrl+C` or a logout sends a catchable signal. Without these
// handlers the process dies with the backends still running — the main way
// orphans accumulated on Linux and macOS, where (unlike Windows) our teardown
// was never reached. On Windows only SIGINT and SIGHUP (console closed) arrive;
// listening for SIGTERM there is inert but harmless.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    appLogger.info(`Received ${signal}, stopping backends`, 'electron-backend')
    void appShutdown.shutdown().finally(() => app.exit(0))
  })
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q — so free the backends here instead of quitting.
app.on('window-all-closed', async () => {
  if (process.platform === 'darwin') {
    await appShutdown.shutdown()
    return
  }
  win = null
  app.quit()
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow().then(loadAppWindow)
  }
})

app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) {
      win.restore()
    }
    win.focus()
    return
  }
  // We hold the single-instance lock with no window to show, so the user's
  // relaunch is refused and nothing appears. Re-creating the window here would
  // not help: the services captured the old one (`readonly win` in service.ts)
  // and would keep sending status updates to dead webContents. Closing the main
  // window now always quits (see createWindow), so this should be unreachable —
  // log it, because it means something held the quit back.
  appLogger.warn(
    `Second instance requested while holding the lock without a window (shutting down: ${appShutdown.isShuttingDown()})`,
    'electron-backend',
  )
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
    if (updates.disabledBackends) {
      serviceRegistry?.setDisabledBackends(updates.disabledBackends)
    }
    appLogger.info(`Updated local settings: ${JSON.stringify(updates)}`, 'electron-backend')
    return { success: true }
  })

  // ── Cloud Mode provider API keys ────────────────────────────────────────
  // Keys are encrypted at rest via safeStorage and never persisted in the
  // renderer. Each provider's key lives in its own file keyed by provider id,
  // mirroring the Home Agent channel-secret layout. Reading/decryption happens in
  // main only (readCloudProviderKey); the proxy attaches the bearer token so the
  // plaintext key never reaches the renderer.
  ipcMain.handle('cloudProvider:saveKey', (_event, providerId: string, key: string) => {
    try {
      const raw = (key ?? '').trim()
      if (!raw) {
        // Empty key clears any stored secret.
        try {
          fs.unlinkSync(cloudProviderKeyPath(providerId))
        } catch {
          /* nothing to remove */
        }
        return { success: true }
      }
      const blob = safeStorage.encryptString(raw).toJSON()
      fs.writeFileSync(cloudProviderKeyPath(providerId), JSON.stringify(blob), 'utf-8')
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('cloudProvider:getKey', (_event, providerId: string): string | null =>
    readCloudProviderKey(providerId),
  )

  ipcMain.handle('cloudProvider:deleteKey', (_event, providerId: string) => {
    try {
      fs.unlinkSync(cloudProviderKeyPath(providerId))
    } catch {
      /* already gone */
    }
    return { success: true }
  })

  // Loopback URL of the Cloud Mode proxy. The renderer points its
  // OpenAI-compatible client and model-list fetch at this URL and tags each
  // request with X-Cloud-Upstream / X-Cloud-Provider (see cloudProxy.ts).
  ipcMain.handle('cloudProvider:getProxyUrl', async (): Promise<string> => {
    return (await getCloudProxy()).url
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
      detectedDevices: classifyDetectedDevices(detected),
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
    pathsManager.restoreDefaultModelPaths()
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

  // Quit outright instead of closing the window and hoping that cascades into a
  // quit: `app.quit()` always reaches the gated teardown in `before-quit`.
  ipcMain.on('exitApp', async () => {
    app.quit()
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
    'saveGeneratedAudio',
    async (
      _event,
      audioBase64: string,
      filename: string,
      options?: { overwrite?: boolean },
    ): Promise<{ success: boolean; filePath?: string; error?: string }> => {
      try {
        if (typeof audioBase64 !== 'string' || typeof filename !== 'string') {
          return { success: false, error: 'invalid arguments' }
        }
        const safeName = path.basename(filename).replace(/[^\w.\-]+/g, '_')
        let outName = safeName.toLowerCase().endsWith('.wav') ? safeName : `${safeName}.wav`
        await fs.promises.mkdir(audioDir, { recursive: true })
        let filePath = path.join(audioDir, outName)
        // Chat audio keeps every take, so a name collision gets a `_1` suffix. A
        // caller that owns a single well-known file (a voice's preview) opts out:
        // suffixing would orphan the previous one on every re-save.
        if (fs.existsSync(filePath) && options?.overwrite !== true) {
          const ext = path.extname(outName)
          const base = outName.slice(0, outName.length - ext.length)
          let n = 1
          while (fs.existsSync(filePath)) {
            outName = `${base}_${n}${ext}`
            filePath = path.join(audioDir, outName)
            n++
          }
        }
        await fs.promises.writeFile(filePath, Buffer.from(audioBase64, 'base64'))
        return { success: true, filePath }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        appLogger.error(`Failed to save generated audio: ${errorMessage}`, 'electron-backend')
        return { success: false, error: errorMessage }
      }
    },
  )

  /**
   * Delete a generated audio file. Confined to the app's audio directory by the same
   * containment check `readLocalAudioAsDataUri` uses, so a renderer-supplied path can
   * never reach anything else. A path that is already gone counts as success —
   * the caller wants the file absent, not proof that it deleted it.
   */
  ipcMain.handle(
    'deleteGeneratedAudio',
    async (_event, filePath: string): Promise<{ success: boolean; error?: string }> => {
      try {
        if (typeof filePath !== 'string' || !filePath.trim()) {
          return { success: false, error: 'invalid path' }
        }
        const audioRoot = path.normalize(getAudioDir())
        const full = path.normalize(
          path.isAbsolute(filePath) ? filePath : path.join(audioRoot, filePath),
        )
        if (full !== audioRoot && !full.startsWith(audioRoot + path.sep)) {
          return { success: false, error: 'path outside audio directory' }
        }
        await fs.promises.rm(full, { force: true })
        return { success: true }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        appLogger.error(`Failed to delete generated audio: ${errorMessage}`, 'electron-backend')
        return { success: false, error: errorMessage }
      }
    },
  )

  ipcMain.handle(
    'readLocalAudioAsDataUri',
    async (
      _event,
      filePath: string,
    ): Promise<{ success: boolean; dataUri?: string; error?: string }> => {
      try {
        if (typeof filePath !== 'string' || !filePath.trim()) {
          return { success: false, error: 'invalid path' }
        }
        const audioRoot = path.normalize(getAudioDir())
        const full = path.normalize(
          path.isAbsolute(filePath) ? filePath : path.join(audioRoot, filePath),
        )
        if (full !== audioRoot && !full.startsWith(audioRoot + path.sep)) {
          return { success: false, error: 'path outside audio directory' }
        }
        const buf = await fs.promises.readFile(full)
        const ext = path.extname(full).toLowerCase()
        const mediaType = ext === '.mp3' ? 'audio/mpeg' : 'audio/wav'
        return {
          success: true,
          dataUri: `data:${mediaType};base64,${buf.toString('base64')}`,
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
      }
    },
  )

  // Persist an inbound Home Agent document (base64) to disk so the langchain
  // RAG loaders (which require a real filepath) can index it, and so the
  // persisted ragList entry keeps a stable path. Returns the absolute path.
  ipcMain.handle(
    'saveHomeAgentDocument',
    async (
      _event,
      filename: string,
      base64: string,
    ): Promise<{ success: boolean; filepath?: string; error?: string }> => {
      const supportedExtensions = ['txt', 'md', 'doc', 'docx', 'pdf']
      try {
        if (typeof filename !== 'string' || typeof base64 !== 'string') {
          return { success: false, error: 'invalid arguments' }
        }
        const safeName = path.basename(filename).replace(/[^\w.\-]+/g, '_')
        const ext = safeName.includes('.') ? safeName.split('.').pop()!.toLowerCase() : ''
        if (!supportedExtensions.includes(ext)) {
          return { success: false, error: `unsupported document type (.${ext})` }
        }
        const ragDocumentsDir = path.join(mediaDir, 'rag-documents')
        await fs.promises.mkdir(ragDocumentsDir, { recursive: true })
        const uniqueName = `${randomUUID()}-${safeName}`
        const filePath = path.join(ragDocumentsDir, uniqueName)
        await fs.promises.writeFile(filePath, Buffer.from(base64, 'base64'))
        return { success: true, filepath: filePath }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  )

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

  /** Get command line parameters when launched from IPOS to decide the default home page.
   * Returns null when --start-page was not provided so the renderer can leave
   * the persisted mode untouched; returns the validated ModeType (or 'chat' as
   * a safe fallback for an invalid value) when it was. */
  ipcMain.handle('getInitialPage', (): ModeType | null => {
    const validModes: ModeType[] = ['chat', 'audio', 'imageGen', 'imageEdit', 'video']
    const startPageArg = process.argv.find((arg) => arg.startsWith('--start-page='))
    if (!startPageArg) return null
    const parsed = startPageArg.split('=')[1]
    return validModes.includes(parsed as ModeType) ? (parsed as ModeType) : 'chat'
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
    // Packaged: the per-user writable copy (seeded from the shared default on
    // first use). Its relative model paths still resolve against the shared
    // resources root via PathsManager, so downloads/scanning hit shared models.
    app.isPackaged
      ? writableConfigFile('model_config.json')
      : path.join(externalRes, 'model_config.dev.json'),
  )

  ipcMain.handle('getInitSetting', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) {
      return
    }
    return {
      modelLists: pathsManager.scanAll(),
      modelPaths: pathsManager.modelPaths,
      version: app.getVersion(),
      modelFolderReadOnly: !pathsManager.isModelDirWritable(),
    }
  })

  ipcMain.handle('loadModels', async (_event) => {
    return resolveModels(settings)
  })

  // The renderer forwards its AI SDK telemetry here (the SDK cannot run in a
  // browser page); null config means no developer opted in, and the renderer
  // then registers nothing and sends nothing.
  ipcMain.handle('getLaminarConfig', () => laminarConfig())
  ipcMain.on('laminarTelemetryEvent', (_event, name: string, payload: string) => {
    void handleChatTelemetryEvent(name, payload)
  })

  ipcMain.handle('updateModelPaths', (_event, modelPaths: ModelPaths) => {
    pathsManager.updateModelPaths(modelPaths)
    return pathsManager.scanAll()
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

  ipcMain.handle('scanModelLibrary', (_event) => {
    return pathsManager.scanModelLibrary()
  })

  ipcMain.handle('showModelInFolder', (_event, modelPath: string) => {
    const resolved = pathsManager.resolveModelPath(modelPath)
    if ('error' in resolved) {
      return { success: false, error: resolved.error }
    }
    if (process.platform === 'win32') {
      // `execFile`, not `exec`: the path is passed as an argument rather than
      // spliced into a shell command line, so a model directory containing a
      // quote or an `&` opens the folder instead of running as a command.
      execFile('explorer.exe', ['/select,', resolved.path])
    } else {
      shell.showItemInFolder(resolved.path)
    }
    return { success: true }
  })

  // Permanent deletion, deliberately not a move to trash: freeing the disk space
  // immediately is the reason a user deletes a model. Every path is validated
  // against the configured model directories first — see resolveModelPath.
  ipcMain.handle('deleteModelPath', async (_event, modelPath: string) => {
    const resolved = pathsManager.resolveModelPath(modelPath)
    if ('error' in resolved) {
      return { success: false, error: resolved.error }
    }
    try {
      // Async throughout: a model is tens of gigabytes across thousands of files,
      // and the synchronous form froze the whole UI for the duration of the walk.
      // No `force`: a path that vanished should be reported, not silently
      // treated as a successful delete.
      await fs.promises.rm(resolved.path, { recursive: true })
      await pathsManager.pruneEmptyModelDirs(resolved.path)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }

    const comfyService = serviceRegistry?.getService('comfyui-backend') as
      ComfyUiBackendService | undefined
    const comfyUiModelsRoot = comfyService?.serviceDir
      ? path.join(comfyService.serviceDir, 'models')
      : undefined
    for (const mirror of pathsManager.mirroredModelPaths(resolved.path, comfyUiModelsRoot)) {
      try {
        await fs.promises.rm(mirror, { recursive: true, force: true })
      } catch (error) {
        // The primary copy is already gone; a failed mirror cleanup is worth a
        // log but must not report the delete as failed.
        appLogger.warn(
          `Could not remove mirrored model copy ${mirror}: ${error}`,
          'electron-backend',
        )
      }
    }
    return { success: true }
  })

  ipcMain.handle('getPlatform', () => process.platform)

  ipcMain.handle('safeStorage:isEncryptionAvailable', () => safeStorage.isEncryptionAvailable())

  ipcMain.handle('safeStorage:enablePlainTextEncryption', () => {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        safeStorage.setUsePlainTextEncryption(true)
      }
      if (!safeStorage.isEncryptionAvailable()) {
        return {
          success: false,
          error: 'Plaintext secret storage is not available on this system.',
        }
      }
      if (!settings.allowPlaintextSecretStorage) {
        settings.allowPlaintextSecretStorage = true
        persistLocalSettingsToDisk()
      }
      appLogger.warn(
        `User opted into plaintext-backed safeStorage (backend=${safeStorage.getSelectedStorageBackend()}); ` +
          `stored secrets are obfuscated, not encrypted.`,
        'electron-backend',
        true,
      )
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle(
    'addDocumentToRAGList',
    (_event, document: IndexedDocument, phisonKmConfig?: PhisonKmIngestConfig) => {
      return handleUtilityFunction<
        { document: IndexedDocument; phisonKmConfig?: PhisonKmIngestConfig },
        IndexedDocument
      >('addDocumentToRAGList', langchainChild, { document, phisonKmConfig })
    },
  )

  ipcMain.handle('embedInputUsingRag', (_event, embedInquiry: EmbedInquiry) => {
    return handleUtilityFunction<EmbedInquiry, KVObject>(
      'embedInputUsingRag',
      langchainChild,
      embedInquiry,
    )
  })

  ipcMain.handle('warmupKVCacheForDocument', (_event, request: WarmupRequest) => {
    return handleUtilityFunction<WarmupRequest, { success: boolean }>(
      'warmupKVCacheForDocument',
      langchainChild,
      request,
    )
  })

  ipcMain.on('openDevTools', () => {
    win?.webContents.openDevTools({ mode: 'detach', activate: true })
  })

  ipcMain.on('setVerboseAgentLogging', (_event, enabled: boolean) => {
    setVerboseAgentLogging(enabled)
  })

  ipcMain.handle('getServices', () => {
    const registry = serviceRegistry ?? peekApiServiceRegistry()
    if (!registry) {
      appLogger.warn(
        'frontend tried to getServices too early during aipg startup',
        'electron-backend',
      )
      return []
    }
    return registry.getServiceInformation()
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
    if (service instanceof Qwen3TtsBackendService) {
      return service.getLoopbackAuthToken()
    }
    if (service instanceof WhisperBackendService) {
      return service.getLoopbackAuthToken()
    }
    return ''
  })

  ipcMain.handle('comfyui:openInBrowser', async () => {
    const comfyService = serviceRegistry?.getService('comfyui-backend') as
      ComfyUiBackendService | undefined
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

  // Which OEM's machine this is, for co-branding (see subprocesses/oemDetection.ts).
  ipcMain.handle('detectOem', () => detectOem(settings.oemVendorOverride))

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
        { FirmwareVersion?: string } | Array<{ FirmwareVersion?: string }>
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
      // Persist so the boot-time auto-start can restore this device instead of
      // resetting to the default GPU on the next restart. Record the device's
      // UUID too (when known) so the choice survives a selector-id shift.
      settings.lastSelectedDevicePerBackend[serviceName] = deviceId
      const selectedDevice = (service as { devices?: InferenceDevice[] }).devices?.find(
        (d) => d.id === deviceId,
      )
      if (selectedDevice?.uuid) {
        settings.lastSelectedDeviceUuidPerBackend[serviceName] = selectedDevice.uuid
      } else {
        delete settings.lastSelectedDeviceUuidPerBackend[serviceName]
      }
      persistLocalSettingsToDisk()
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
        settings.lastSelectedDevicePerBackend[`${serviceName}:stt`] = deviceId
        const selectedStt = (service as { sttDevices?: InferenceDevice[] }).sttDevices?.find(
          (d) => d.id === deviceId,
        )
        if (selectedStt?.uuid) {
          settings.lastSelectedDeviceUuidPerBackend[`${serviceName}:stt`] = selectedStt.uuid
        } else {
          delete settings.lastSelectedDeviceUuidPerBackend[`${serviceName}:stt`]
        }
        persistLocalSettingsToDisk()
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

      // Never run two installs for the same service concurrently: they would run
      // two uv syncs (or two git clones) against the same directory. Bail without
      // emitting any progress — the shared renderer listener belongs to the
      // install that is already running, and a terminal update here would resolve
      // that one with the duplicate's outcome.
      if (service.setUpInProgress) {
        appLogger.warn(
          `Ignoring set up request for ${serviceName}: an installation is already in progress`,
          'electron-backend',
        )
        return
      }
      service.setUpInProgress = true

      // The renderer waits for a terminal ('failed'/'success') progress update
      // before it re-enables its UI. If set_up() throws instead of yielding one
      // — e.g. ComfyUI's Linux dependency step, which runs before its own
      // try/catch and throws on cancel — the install would stay "Installing..."
      // forever. Synthesize the terminal failure the generator owes us.
      try {
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        appLogger.error(
          `Set up for ${serviceName} threw without a terminal progress update: ${message}`,
          'electron-backend',
        )
        if (!win.isDestroyed()) {
          win.webContents.send('serviceSetUpProgress', {
            serviceName,
            step: 'setup failed',
            status: 'failed',
            debugMessage: `Installation aborted: ${message}`,
            errorDetails: {
              stderr: message,
              timestamp: new Date().toISOString(),
            },
          } satisfies SetupProgress)
        }
      } finally {
        service.setUpInProgress = false
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
      modelArgs?: string,
    ) => {
      appLogger.info(
        `Ensuring backend readiness for service: ${serviceName}, LLM: ${llmModelName}, Embedding: ${embeddingModelName || 'none'}, Context Size: ${contextSize ?? 'undefined'}, Model args: ${modelArgs || 'none'}`,
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
        await service.ensureBackendReadiness(
          llmModelName,
          embeddingModelName,
          contextSize,
          modelArgs,
        )
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
    'ensureEmbeddingServerReady',
    async (_event: IpcMainInvokeEvent, serviceName: string, embeddingModelName: string) => {
      if (!serviceRegistry) {
        return { success: false, error: 'Service registry not ready' }
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        return { success: false, error: `Service ${serviceName} not found` }
      }

      // Only the local LLM backends (llamaCPP / openVINO) can host an embedding
      // server. Used by Cloud Mode RAG to embed locally while chatting remotely.
      if (
        'ensureEmbeddingServerReady' in service &&
        typeof service.ensureEmbeddingServerReady === 'function'
      ) {
        try {
          await service.ensureEmbeddingServerReady(embeddingModelName)
          appLogger.info(
            `Embedding server ready for ${serviceName} with model: ${embeddingModelName}`,
            'electron-backend',
          )
          return { success: true }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          appLogger.error(
            `Failed to ensure embedding server ready for ${serviceName}: ${errorMessage}`,
            'electron-backend',
          )
          return { success: false, error: errorMessage }
        }
      }

      return {
        success: false,
        error: `Service ${serviceName} does not support a standalone embedding server`,
      }
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

  ipcMain.handle('startSpeechServer', async (_event: IpcMainInvokeEvent, modelName: string) => {
    if (!serviceRegistry) {
      return { success: false, error: 'Service registry not ready' }
    }
    const service = serviceRegistry.getService('openvino-backend')
    if (!service) {
      return { success: false, error: 'OpenVINO backend service not found' }
    }

    if ('startSpeechServer' in service && typeof service.startSpeechServer === 'function') {
      try {
        await service.startSpeechServer(modelName)
        return { success: true }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        appLogger.error(`Failed to start speech server: ${errorMessage}`, 'electron-backend')
        return { success: false, error: errorMessage }
      }
    }

    return { success: false, error: 'Speech server not supported' }
  })

  ipcMain.handle('stopSpeechServer', async (_event: IpcMainInvokeEvent) => {
    if (!serviceRegistry) {
      return { success: false, error: 'Service registry not ready' }
    }
    const service = serviceRegistry.getService('openvino-backend')
    if (!service) {
      return { success: false, error: 'OpenVINO backend service not found' }
    }

    if ('stopSpeechServer' in service && typeof service.stopSpeechServer === 'function') {
      try {
        await service.stopSpeechServer()
        return { success: true }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        appLogger.error(`Failed to stop speech server: ${errorMessage}`, 'electron-backend')
        return { success: false, error: errorMessage }
      }
    }

    return { success: false, error: 'Speech server not supported' }
  })

  ipcMain.handle('getSpeechServerUrl', async (_event: IpcMainInvokeEvent) => {
    if (!serviceRegistry) {
      return { success: false, error: 'Service registry not ready' }
    }
    const service = serviceRegistry.getService('openvino-backend')
    if (!service) {
      return { success: false, error: 'OpenVINO backend service not found' }
    }

    if ('getSpeechServerUrl' in service && typeof service.getSpeechServerUrl === 'function') {
      const speechUrl = service.getSpeechServerUrl()
      if (speechUrl) {
        return { success: true, url: speechUrl }
      }
      return { success: false, error: 'Speech server not running' }
    }

    return { success: false, error: 'Speech server not supported' }
  })

  // Synthesize speech in the main process so it is not subject to the
  // renderer's CORS policy. Many OpenAI-compatible `/audio/speech` servers
  // (e.g. local TTS fallbacks) do not answer the CORS preflight that an
  // `application/json` POST triggers, which blocks a direct renderer fetch.
  ipcMain.handle(
    'synthesizeSpeech',
    async (
      _event: IpcMainInvokeEvent,
      options: {
        baseURL: string
        model: string
        input: string
        voice?: string
        apiKey?: string
        format?: string
      },
    ): Promise<
      { success: true; dataBase64: string; mediaType: string } | { success: false; error: string }
    > => {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (options.apiKey) {
          headers['Authorization'] = `Bearer ${options.apiKey}`
        }
        const body: Record<string, unknown> = {
          model: options.model,
          input: options.input,
          response_format: options.format || 'wav',
        }
        if (options.voice) {
          body.voice = options.voice
        }
        const url = `${options.baseURL.replace(/\/$/, '')}/audio/speech`
        const res = await net.fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const detail = await res.text().catch(() => '')
          return { success: false, error: `Speech synthesis failed (${res.status}): ${detail}` }
        }
        const arrayBuffer = await res.arrayBuffer()
        const mediaType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'audio/wav'
        const dataBase64 = Buffer.from(arrayBuffer).toString('base64')
        return { success: true, dataBase64, mediaType }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        appLogger.error(`Failed to synthesize speech: ${errorMessage}`, 'electron-backend')
        return { success: false, error: errorMessage }
      }
    },
  )

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

  ipcMain.handle('stopOvmsChatServers', async (_event: IpcMainInvokeEvent) => {
    if (!serviceRegistry) {
      return { success: false, error: 'Service registry not ready' }
    }
    const service = serviceRegistry.getService('openvino-backend')
    if (!service) {
      return { success: false, error: 'OpenVINO backend service not found' }
    }

    if ('stopChatServers' in service && typeof service.stopChatServers === 'function') {
      try {
        await service.stopChatServers()
        return { success: true }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        appLogger.error(`Failed to stop OVMS chat servers: ${errorMessage}`, 'electron-backend')
        return { success: false, error: errorMessage }
      }
    }

    return { success: false, error: 'Chat servers not supported' }
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
      ComfyUiBackendService | undefined
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
      ComfyUiBackendService | undefined
    return await comfyuiTools.installPypiPackage(
      packageSpecifier,
      comfyService?.getTorchBackendEnv(),
    )
  })

  ipcMain.handle(
    'comfyui:isCustomNodeInstalled',
    (_event, nodeRepoRef: comfyuiTools.ComfyUICustomNodeRepoId) => {
      const comfyService = serviceRegistry?.getService('comfyui-backend') as
        ComfyUiBackendService | undefined
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
        ComfyUiBackendService | undefined
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
        ComfyUiBackendService | undefined
      if (!comfyService) {
        throw new Error('ComfyUI backend service not found')
      }
      return await comfyuiTools.uninstallCustomNode(nodeRepoData, comfyService.serviceDir)
    },
  )

  ipcMain.handle('comfyui:listInstalledCustomNodes', () => {
    const comfyService = serviceRegistry?.getService('comfyui-backend') as
      ComfyUiBackendService | undefined
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

  // Screenshot capture IPC handlers. `listWindows` is only ever called from the
  // settings UI so the user can bind the screenshot tool to a single window;
  // it is never exposed to the LLM. `captureWindow` only ever receives the
  // user-bound window from the renderer (the tool has no window argument).

  // macOS gates window/screen capture behind Screen Recording permission. When it
  // is missing, `desktopCapturer.getSources` throws an opaque "Failed to get
  // sources." — and crucially, once granted, the *running* app keeps failing until
  // it is restarted. Convert both cases into an actionable message.
  const SCREEN_PERMISSION_MESSAGE =
    'Screen Recording permission is required to capture windows. On macOS, open System ' +
    'Settings → Privacy & Security → Screen Recording, enable AI Playground (or Electron in ' +
    'development), then fully quit and restart the app — newly granted permission does not ' +
    'apply to the already-running process.'

  function getScreenCaptureStatus():
    'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown' {
    if (process.platform !== 'darwin') return 'granted'
    return systemPreferences.getMediaAccessStatus('screen')
  }

  async function getWindowSources(thumbnailSize: { width: number; height: number }) {
    if (getScreenCaptureStatus() !== 'granted') {
      throw new Error(SCREEN_PERMISSION_MESSAGE)
    }
    try {
      return await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize,
        fetchWindowIcons: false,
      })
    } catch (error) {
      // On macOS this is almost always the "granted but not yet restarted" case.
      if (process.platform === 'darwin') {
        throw new Error(SCREEN_PERMISSION_MESSAGE)
      }
      throw error
    }
  }

  ipcMain.handle('screenshot:getPermissionStatus', () => ({
    platform: process.platform,
    status: getScreenCaptureStatus(),
  }))

  ipcMain.on('screenshot:openPermissionSettings', () => {
    if (process.platform === 'darwin') {
      void shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      )
    }
  })

  ipcMain.handle('screenshot:listWindows', async () => {
    const sources = await getWindowSources({ width: 320, height: 200 })
    return sources
      .filter((source) => source.name.trim().length > 0)
      .map((source) => ({
        id: source.id,
        name: source.name,
        thumbnailDataUrl: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
      }))
  })

  ipcMain.handle(
    'screenshot:captureWindow',
    async (_event, target: { id: string; name: string }) => {
      if (!target || typeof target.id !== 'string') {
        throw new Error('screenshot:captureWindow: invalid target window')
      }
      // Capture at the primary display's pixel resolution (capped) so the
      // screenshot is legible to a vision model rather than a tiny thumbnail.
      const display = screen.getPrimaryDisplay()
      const thumbnailSize = {
        width: Math.min(Math.round(display.size.width * display.scaleFactor), 2560),
        height: Math.min(Math.round(display.size.height * display.scaleFactor), 1600),
      }
      const sources = await getWindowSources(thumbnailSize)
      // Source ids are not stable across app restarts, so fall back to matching
      // by window title when the exact id is gone.
      const source =
        sources.find((s) => s.id === target.id) ?? sources.find((s) => s.name === target.name)
      if (!source) {
        throw new Error(
          `Window "${target.name}" is no longer available. Ask the user to re-select the window to capture.`,
        )
      }
      if (source.thumbnail.isEmpty()) {
        throw new Error(
          `Window "${target.name}" could not be captured (it may be minimized or hidden).`,
        )
      }
      return source.thumbnail.toDataURL()
    },
  )

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

  // Agent Mode (Pi coding agent) IPC handlers — see agentMode/piAgentManager.ts.
  // Stream chunks are pushed main→renderer on 'agentMode:streamChunk', live tool
  // output on 'agentMode:toolProgress'.
  ipcMain.handle(
    'agentMode:startTurn',
    async (_event, turnId: string, prompt: string, config: unknown) => {
      const parsed = AgentModeTurnConfigSchema.safeParse(config)
      if (!parsed.success) {
        return { success: false, error: parsed.error.message }
      }
      return await startAgentTurn(turnId, prompt, parsed.data)
    },
  )

  ipcMain.handle('agentMode:cancel', () => {
    cancelAgentTurn()
  })

  ipcMain.handle('agentMode:resetSession', async () => {
    await resetAgentSession()
  })

  ipcMain.handle('agentMode:deleteSession', async (_event, sessionId: string) => {
    return await deleteAgentSession(sessionId)
  })

  // Copy a file the user attached into the agent's workspace, so the agent can
  // reach it with its own file tools (see agentMode/workspaceAttachments.ts).
  ipcMain.handle(
    'agentMode:importAttachment',
    (_event, workspaceDir: string, name: string, bytes: Uint8Array) => {
      try {
        return { success: true, ...importAttachment(workspaceDir, name, bytes) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  // What the agent can be equipped with, for the Capabilities checkboxes in
  // Agent Settings (availability depends on the turn's tool specs / MCP config).
  ipcMain.handle(
    'agentMode:listCapabilities',
    (
      _event,
      options: { workspaceDir?: string; toolSpecs?: AgentToolSpec[]; mcpServerIds?: string[] },
    ) => {
      return listAgentCapabilities(options ?? {})
    },
  )

  // Renderer answers a main→renderer 'agentMode:executeTool' dispatch (bridged
  // host tool execution, e.g. image generation) with the tool result or error.
  ipcMain.handle(
    'agentMode:toolResult',
    (_event, requestId: string, result: unknown, error?: string) => {
      submitAgentToolResult(requestId, result, error)
    },
  )

  // Game library (see gameLibrary.ts): the folders the Game Agent preset writes
  // into, plus the generated gallery page.
  ipcMain.handle('games:list', () => listGames())

  ipcMain.handle('games:read', (_event, dir: string) => readGame(dir))

  // `name` is the request that started the game, not a title: shorten it to
  // something that reads as one, until the agent sets a real one. The request
  // itself is kept whole as provenance.
  ipcMain.handle(
    'games:create',
    (
      _event,
      name?: string,
      options?: {
        scaffold?: boolean
        backend?: string
        startingModel?: string
        initialPrompt?: string
      },
    ) =>
      createGame({
        name: name ? provisionalName(name) : undefined,
        ...(options?.scaffold === false ? { scaffold: false } : {}),
        backend: options?.backend,
        startingModel: options?.startingModel,
        initialPrompt: options?.initialPrompt,
      }),
  )

  ipcMain.handle(
    'games:publish',
    async (_event, dir: string, fields: { name?: string; description?: string }) => {
      try {
        const { vendor } = await detectOem(settings.oemVendorOverride)
        return { success: true, game: publishGame(dir, fields ?? {}, { vendor }) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle('games:arcadeCatalog', async () => {
    const { vendor } = await detectOem(settings.oemVendorOverride)
    return arcadeCatalog({ vendor })
  })

  ipcMain.handle(
    'games:setArcadeShown',
    async (_event, target: { kind: 'user' | 'sample'; id: string; shown: boolean }) => {
      try {
        const { vendor } = await detectOem(settings.oemVendorOverride)
        setArcadeShown(target, { vendor })
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  // A game's own folder, or the library root when none is given.
  ipcMain.handle('games:openFolder', (_event, dir?: string) => {
    const target = dir ?? getGamesDir()
    fs.mkdirSync(target, { recursive: true })
    shell.openPath(target)
  })

  ipcMain.handle('games:play', async (_event, dir: string) => {
    const game = readGame(dir)
    if (!game) return { success: false, error: `Not a game folder: ${dir}` }
    if (!fs.existsSync(game.entryPath)) {
      return { success: false, error: 'This game has no playable file yet.' }
    }
    // The default browser, not an app window: a game is the user's to keep.
    const error = await shell.openPath(game.entryPath)
    return error ? { success: false, error } : { success: true }
  })

  // Regenerated on open so the gallery reflects the library as it is now.
  ipcMain.handle('games:openArcade', async () => {
    const { vendor } = await detectOem(settings.oemVendorOverride)
    const { arcadePath } = writeArcade({ vendor })
    const error = await shell.openPath(arcadePath)
    return error ? { success: false, error } : { success: true, path: arcadePath }
  })

  // Web browser IPC handlers — drives the headless BrowserWindow that the chat
  // LLM uses to browse the web (see subprocesses/webBrowserManager.ts).
  ipcMain.handle('webBrowser:navigate', async (_event, url: string) => {
    return await navigateWebBrowser(url)
  })

  ipcMain.handle('webBrowser:readPage', async () => {
    return await readWebBrowserPage()
  })

  ipcMain.handle('webBrowser:search', async (_event, query: string, maxResults?: number) => {
    return await searchWebBrowser(query, maxResults)
  })

  ipcMain.handle('webBrowser:interact', async (_event, interaction: WebBrowserInteraction) => {
    return await interactWebBrowser(interaction)
  })

  ipcMain.handle('webBrowser:screenshot', async () => {
    return await screenshotWebBrowser()
  })

  ipcMain.handle('webBrowser:show', () => {
    return showWebBrowser()
  })

  ipcMain.handle('webBrowser:hide', () => {
    return hideWebBrowser()
  })

  ipcMain.handle('webBrowser:close', () => {
    return closeWebBrowser()
  })

  ipcMain.handle('webBrowser:getState', () => {
    return getWebBrowserState()
  })

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

function applyLinuxPlaintextStorageOptIn(): void {
  if (process.platform !== 'linux' || safeStorage.isEncryptionAvailable()) return
  if (settings.allowPlaintextSecretStorage) {
    safeStorage.setUsePlainTextEncryption(true)
    appLogger.warn(
      `No usable OS keyring (backend=${safeStorage.getSelectedStorageBackend()}); ` +
        `re-enabling plaintext-backed safeStorage from a previous LAN chat opt-in — ` +
        `stored secrets are obfuscated, not encrypted.`,
      'electron-backend',
      true,
    )
    return
  }
  appLogger.warn(
    `No usable OS keyring (backend=${safeStorage.getSelectedStorageBackend()}); ` +
      `secret storage stays disabled until the user opts in while setting a LAN chat password.`,
    'electron-backend',
    true,
  )
}

app.whenReady().then(async () => {
  // Startup diagnostic — helps diagnose installation and configuration issues
  appLogger.info(
    `startup: isPackaged=${app.isPackaged} platform=${process.platform} DIST="${process.env.DIST}" userData="${app.getPath('userData')}"`,
    'electron-backend',
    true,
  )

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
    // Step markers around each startup await, written straight to the log file
    // (webContents doesn't exist yet), so a hang before the window appears
    // pinpoints the exact stage instead of leaving no trace.
    appLogger.info('startup step: loading settings', 'electron-backend', true)
    await loadSettings()
    applyLinuxPlaintextStorageOptIn()

    // Honor *_proxy env vars for all backend downloads (net.fetch) before any
    // service setup kicks off.
    appLogger.info('startup step: configuring proxy', 'electron-backend', true)
    await configureProxyFromEnv()

    // Before the first Pi session is built: the Laminar Pi extension only wins
    // its self-hosted ports if the SDK is initialized here first (see laminar.ts).
    appLogger.info('startup step: initializing tracing', 'electron-backend', true)
    await initLaminarTracing()

    appLogger.info('startup step: initializing event handlers', 'electron-backend', true)
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
      // `*` is safe because the scheme only ever serves files under the roots
      // guarded by `getLocalPathFromAipgMediaUrl`.
      const headers = new Headers(upstream.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      })
    })
    appLogger.info('startup step: creating window', 'electron-backend', true)
    const window = await createWindow()
    appLogger.info('startup step: initializing service registry', 'electron-backend', true)
    await initServiceRegistry(window, settings)
    // After the registry: the renderer's stores call into it as they are created.
    appLogger.info('startup step: loading app window', 'electron-backend', true)
    await loadAppWindow(window)
    appLogger.info('startup step: spawning langchain utility process', 'electron-backend', true)
    spawnLangchainUtilityProcess()
    appLogger.info('startup step: ready', 'electron-backend', true)
  }
})
