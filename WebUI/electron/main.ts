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
  net,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  utilityProcess,
  UtilityProcess,
} from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'fs'
import { randomUUID } from 'node:crypto'
import { PathsManager } from './kernel/pathsManager'
import {
  LocalSettingsSchema,
  resolveProductMode,
  type LocalSettings,
} from './kernel/localSettings.ts'
import { writableConfigFile } from './kernel/userConfig.ts'
import { appLoggerInstance } from './observability/logger.ts'
import {
  aiplaygroundApiServiceRegistry,
  ApiServiceRegistryImpl,
  peekApiServiceRegistry,
} from './adapters/backends/apiServiceRegistry'
import {
  ComfyUiBackendService,
  COMFYUI_DEFAULT_PARAMETERS,
} from './adapters/backends/comfyUIBackendService'
import { AiBackendService } from './adapters/backends/aiBackendService'
import { HomeAgentBackendService } from './adapters/backends/homeAgentBackendService'
import { setCloudProviderKeyReader } from './adapters/cloudUpstream'
import { Qwen3TtsBackendService } from './adapters/backends/qwen3TtsBackendService'
import { WhisperBackendService } from './adapters/backends/whisperBackendService'
import { LLAMACPP_DEFAULT_PARAMETERS } from './adapters/backends/llamaCppBackendService'
import { filterPartnerPresets, updateIntelPresets } from './adapters/updateIntelPresets.ts'
import {
  invalidatePresetCatalog,
  loadPresetFiles,
  readPresetsFromDir,
  type PresetLoadConfig,
} from './artifact/catalog'
import {
  probeFreedesktopSecretService,
  shouldForceBasicPasswordStore,
} from './kernel/linuxPasswordStore'
import { getGitHubRepoUrl, resolveBackendVersion, resolveModels } from './adapters/remoteUpdates.ts'
import * as comfyuiTools from './adapters/backends/comfyuiTools'
import {
  getMcpServerStatus,
  invokeMcpServerTool,
  listMcpServers,
  listMcpServerTools,
  startMcpServer,
  stopAllMcpServers,
  stopMcpServer,
} from './adapters/mcp/mcpManager'
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
} from './adapters/webBrowserManager'
import {
  addMcpServer,
  detectAndRegisterAutoMcpServers,
  getMcpConfigPath,
  getMcpServerConfig,
  isAutoDetectId,
  updateMcpServer,
  removeMcpServer,
} from './adapters/mcp/mcpServers'
import {
  cancelAgentTurn,
  deleteAgentSession,
  isAgentTurnActive,
  listAgentCapabilities,
  resetAgentSession,
  setAgentModeMainWindow,
  shutdownAgentMode,
  startAgentTurn,
  submitAgentToolResult,
} from './agent/piAgentManager'
import { getKernelSnapshot, onKernelEvent, setKernelEventWindow } from './kernel/kernelBus'
import { registerInvokeHandlers, registerSendHandlers } from './kernel/ipcRegistries'
import { typedSend } from './kernel/typedIpc'
import { bindRendererBusyReset, resolveClosePolicy } from './kernel/windowLifecycle'
import { setVerboseLogging as setVerboseAgentLogging } from './agent/piAgentLog.ts'
import { setRagAccess } from './agent/ragAccess.ts'
import { importAttachment } from './agent/workspaceAttachments.ts'
import {
  dedicatedEmbeddingServerUrl,
  EMBEDDING_SERVICE_BY_BACKEND,
  embeddingServerUrl,
  hostsEmbeddingServer,
  startEmbeddingServer,
} from './rag/embeddingServer.ts'
import { ingestDocument, retrieveChunks } from './rag/langchainCalls.ts'
import { handleChatAnswer, rejectAllChatAsks } from './chat/chatAsk.ts'
import type { ArtifactMissingModel } from '@/types/mediaRequests'
import type { IpcOkWith } from '@/types/ipcChannels'
import {
  cancelActiveArtifactRun,
  setArtifactRunnerDeps,
  type RunnerComfyService,
} from './artifact/runner'
import {
  awaitChatWindow,
  cancelArtifactRun,
  cancelAllArtifactRuns,
  artifactWorkOpen,
  setOrchestratorDeps,
  submitArtifactRun,
} from './kernel/orchestrator'
import { setMediaCatalogProvider } from './agent/capabilities/mediaDirect'
import { chatInferenceStreamsActive } from './chat/chatModelMain'
import {
  ensureChatBackendReady,
  reloadLastChatBackend,
  rememberChatBackendLoad,
  setChatReadinessDeps,
  setLastChatBackendLoadActive,
} from './chat/chatReadiness'
import { piAgentCallsActive } from './agent/piCallTiming'
import { freeMemoryAndUnloadModels } from './artifact/comfyClient'
import { getPresetCatalog } from './artifact/catalog'
import {
  handleMediaResponse,
  rejectAllMediaRequests,
  requestRenderer,
} from './artifact/rendererBridge'
import {
  handlePermissionsPromptResponse,
  rejectAllPermissionPrompts,
} from './permissions/promptAdapter'
import {
  grant as grantPermission,
  listGrants,
  migrateGrants,
  requestDownloadConsent,
  requestVramWarningConsent,
  revoke as revokePermission,
} from './permissions/permissionsService'
import { setPermissionGrantsDeps, wipeDemoPermissionGrants } from './persist/grantsStore'
import {
  anyChatTurnActive,
  cancelChatTurn,
  resumeChatTurn,
  setChatEngineDeps,
  submitChatTurn,
} from './chat/turnEngine'
import { summarizeConversationText } from './chat/chatSummarize'
import { setChatModelDeps } from './chat/chatModelMain'
import { setRagRetrievalDeps } from './chat/ragRetrieval'
import { activeMediaAgentRunKeys, cancelMediaAgentRun } from './chat/mediaAgentRunner'
import {
  bootstrapConversations,
  deleteConversation,
  migrateLegacyConversations,
  saveConversation,
  saveConversationLastMainKey,
  setConversationFileDeps,
  wipeDemoConversations,
} from './persist/conversationFiles'
import { buildConversationsRegistry } from './kernel/registries/conversations'
import { buildAgentModeRegistry } from './kernel/registries/agentMode'
import { buildChatRegistry } from './kernel/registries/chat'
import { buildComfyuiRegistry } from './kernel/registries/comfyui'
import { buildGamesRegistry } from './kernel/registries/games'
import { buildMcpRegistry, buildMcpSendRegistry } from './kernel/registries/mcp'
import { buildPermissionsRegistry } from './kernel/registries/permissions'
import { buildWebBrowserRegistry } from './kernel/registries/webBrowser'
import { buildArtifactRegistry } from './kernel/registries/artifact'
import { buildCloudProviderRegistry } from './kernel/registries/cloudProvider'
import {
  buildCoreInvokeRegistry,
  buildCoreSendRegistry,
  type CoreDeps,
} from './kernel/registries/core'
import { buildKernelRegistry } from './kernel/registries/kernel'
import { buildLifecycleSendRegistry } from './kernel/registries/lifecycle'
import { buildMediaItemsRegistry } from './kernel/registries/mediaItems'
import { buildPreferencesRegistry } from './kernel/registries/preferences'
import { buildRagDocumentsRegistry } from './kernel/registries/ragDocuments'
import { buildSafeStorageRegistry } from './kernel/registries/safeStorage'
import {
  buildScreenshotRegistry,
  buildScreenshotSendRegistry,
} from './kernel/registries/screenshot'
import { buildCameraCaptureRegistry } from './kernel/registries/cameraCapture'
import { acerCameraDirectRunning } from './adapters/hardware/acerCameraDirect'
import {
  registerCameraCaptureShortcut,
  unregisterCameraCaptureShortcut,
} from './adapters/hardware/cameraCaptureShortcut'
import {
  bootstrapAgentSessions,
  deleteAgentSessionRecord,
  migrateLegacyAgentSessions,
  saveAgentSession,
  saveAgentSessionActiveId,
  setAgentSessionFileDeps,
  wipeDemoAgentSessions,
} from './persist/agentSessionFiles'
import {
  bootstrapMediaItems,
  deleteMediaItemRecords,
  migrateLegacyMediaItems,
  saveMediaItems,
  setMediaItemFileDeps,
  wipeDemoMediaRecords,
} from './persist/mediaItemFiles'
import {
  migratePreferenceSection,
  readAllPreferences,
  readPreferenceSection,
  setPreferencesFileDeps,
  wipeDemoPreferences,
  writePreferenceSection,
} from './persist/preferencesFile'

import {
  migrateAgentWorkspaceState,
  readAgentWorkspaceState,
  setAgentWorkspaceFilesDeps,
  wipeDemoAgentWorkspace,
  writeAgentWorkspaceState,
} from './persist/workspaceStateFiles'

import {
  migrateRagDocumentSection,
  readRagDocumentSection,
  setRagDocumentFilesDeps,
  wipeDemoRagDocuments,
  writeRagDocumentSection,
} from './persist/ragDocumentFiles'

import { llmServerBaseUrl } from './adapters/llmServerSnapshot'
import { getAudioDir, getGamesDir, getMediaDir } from './persist/userDataPaths.ts'
import { saveGeneratedAudioFile } from './persist/audioFiles.ts'
import {
  arcadeCatalog,
  createGame,
  listGames,
  provisionalName,
  publishGame,
  readGame,
  setArcadeShown,
  writeArcade,
} from './agent/games/gameLibrary.ts'
import { detectOem } from './adapters/hardware/oemDetection.ts'
import {
  captureWindow,
  getScreenCaptureStatus,
  listCaptureWindows,
  openScreenCaptureSettings,
} from './adapters/hardware/screenCapture.ts'
import { packagedResourcesRoot, writableConfigRoot } from './kernel/aipgRoot.ts'
import { loadDemoProfile, type DemoProfile } from './persist/demoProfile.ts'
import {
  classifyDetectedDevices,
  detectGpuHardwareDevices,
  getXpuSmiExePath,
} from './adapters/hardware/hardwareDiscovery.ts'
import { registerSettingsPersist } from './adapters/hardware/defaultDeviceSelection.ts'
import { appShutdown } from './kernel/shutdown.ts'
import {
  handleChatTelemetryEvent,
  initLaminarTracing,
  laminarConfig,
  noteLlamaCppChatTimings,
  noteMainChatTurnContext,
  shutdownLaminarTracing,
} from './observability/laminar.ts'
import {
  setComputeMetricsSink,
  startComputeMetricsSampler,
} from './adapters/hardware/computeMetrics.ts'
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

// The renderer's half of the hidden-window close policy: true while it has
// tracked activities in flight (a chat turn, a generation — see the activities
// sink). Pushed over `lifecycle:busy` whenever it flips.
let rendererBusy = false

function isHomeAgentRunning(): boolean {
  const service = serviceRegistry?.getService('home-agent-backend')
  return service?.get_info().status === 'running'
}

function cloudProviderKeyPath(providerId: string): string {
  return path.join(app.getPath('userData'), `cloud-provider-${providerId}.json`)
}

// Decrypt a provider's API key from safeStorage. Chat, agent registration, and
// the model list call the provider from main with this key.
function readCloudProviderKey(providerId: string): string | null {
  try {
    const raw = fs.readFileSync(cloudProviderKeyPath(providerId), 'utf-8')
    const blob = JSON.parse(raw) as { data: number[] }
    return safeStorage.decryptString(Buffer.from(blob.data))
  } catch {
    return null
  }
}

setCloudProviderKeyReader(readCloudProviderKey)
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
  setKernelEventWindow(win)
  bindRendererBusyReset(win.webContents, (busy) => {
    rendererBusy = busy
  })
  // The renderer that was asked a media request cannot answer from a new
  // window; settle its pendings so waiters fail instead of hanging. The same
  // holds for a chat tool execution the old renderer was told to run. Artifact
  // work is main-owned: cancel it here and again on destroyed so a crashed
  // renderer cannot leave an invisible queue draining.
  rejectAllMediaRequests('The app window was replaced')
  rejectAllChatAsks('The app window was replaced')
  rejectAllPermissionPrompts('The app window was replaced')
  cancelAllArtifactRuns('The app window was replaced')
  win.webContents.once('destroyed', () => {
    cancelAllArtifactRuns('The app window was replaced')
  })
  for (const runKey of activeMediaAgentRunKeys()) cancelMediaAgentRun(runKey)
  win.on('close', (event) => {
    // Main owns the hide/reopen/quit policy (architecture-target §5.1), never
    // the renderer: closing the window only hides it while headless work a
    // quit would orphan is in flight — Home Agent, in-flight agent/chat/artifact
    // work in main, or anything the renderer reported busy. A hidden window is
    // reopened by relaunching (second-instance) or dock activation.
    const decision = resolveClosePolicy({
      homeAgentRunning: isHomeAgentRunning(),
      rendererBusy,
      agentTurnActive: isAgentTurnActive(),
      chatTurnActive: anyChatTurnActive(),
      artifactWorkOpen: artifactWorkOpen(),
    })
    if (decision === 'hide') {
      event.preventDefault()
      win?.hide()
      return
    }
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

    // Check the kernel-owned preferences file after page loads. `undefined`
    // means no choice was ever stored, which is what keeps DevTools opening
    // by default on an unpackaged run (step 8 moved this out of localStorage).
    setTimeout(async () => {
      try {
        const section = (await readPreferenceSection('developerSettings')) as
          | {
              openDevConsoleOnStartup?: unknown
            }
          | undefined
        const stored: boolean | undefined =
          section && typeof section.openDevConsoleOnStartup === 'boolean'
            ? section.openDevConsoleOnStartup
            : undefined
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

// ── RAG plumbing for the agent's `rag` tool ──────────────────────────────────
//
// The tool lives in the agent module graph (capabilities/rag.ts), which must
// not import the service registry or this file — so main hands over the three
// operations it needs as thunks (same pattern as setLlmServiceLookup). They are
// read live: the langchain worker respawns, the embedding server is started on
// demand, and the registry fills in during app init.

setRagAccess({
  ingest: (document) => ingestDocument(handleUtilityFunction, langchainChild, document),
  retrieve: (inquiry) => retrieveChunks(handleUtilityFunction, langchainChild, inquiry),
  ensureEmbeddingServer: async (backend, model) => {
    const service = serviceRegistry?.getService(EMBEDDING_SERVICE_BY_BACKEND[backend])
    if (!hostsEmbeddingServer(service)) {
      throw new Error(`The embedding backend for '${backend}' is not installed.`)
    }
    await startEmbeddingServer(service, model)
    const url = dedicatedEmbeddingServerUrl(service)
    if (!url) throw new Error('The embedding server did not come up.')
    return url
  },
})

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
// Demo conversations are session-scoped (§6.1): nothing demo-written may
// survive the process that wrote it.
appShutdown.register({ name: 'demo conversations', run: () => wipeDemoConversations() })
appShutdown.register({ name: 'demo agent sessions', run: () => wipeDemoAgentSessions() })
appShutdown.register({ name: 'demo agent workspace', run: () => wipeDemoAgentWorkspace() })
appShutdown.register({ name: 'demo media records', run: () => wipeDemoMediaRecords() })
appShutdown.register({ name: 'demo preferences', run: () => wipeDemoPreferences() })
appShutdown.register({ name: 'demo permission grants', run: () => wipeDemoPermissionGrants() })
appShutdown.register({ name: 'demo rag documents', run: () => wipeDemoRagDocuments() })
// After the agent, so the spans its extensions emit while shutting down are
// still exported. No-op unless a developer opted into Laminar tracing.
appShutdown.register({ name: 'laminar tracing', run: () => shutdownLaminarTracing() })
appShutdown.register({
  name: 'camera capture shortcut',
  run: () => unregisterCameraCaptureShortcut(),
})
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
  } else if (win && !win.isDestroyed() && !win.isVisible()) {
    // Hidden by the close-while-headless policy: dock activation reopens it.
    win.show()
    win.focus()
  }
})

app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) {
      win.restore()
    }
    // A hidden window (closed while headless work was in flight — see the
    // close handler in createWindow) is reopened here: a relaunch means the
    // user wants the UI back, not a second copy.
    if (!win.isVisible()) win.show()
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
  wireArtifactRunner(settings)
  wireConversations(settings)
  wireAgentSessions(settings)
  wireAgentWorkspace(settings)
  wireMediaRecords(settings)
  wirePreferences(settings)
  wireRagDocuments(settings)
  wirePermissionGrants(settings)
  wireChatEngine()
  return serviceRegistry
}

/**
 * Conversation persistence (step 8, §6.1): demo mode routes threads to a
 * session-scoped sibling directory. Wipe it on boot too — a crash can leave a
 * tail behind, and the app only ever wipes on exit otherwise.
 */
function wireConversations(settings: LocalSettings): void {
  setConversationFileDeps({ isDemoMode: () => settings.isDemoModeEnabled })
  if (settings.isDemoModeEnabled) void wipeDemoConversations()
}

/** Same demo discipline for agent-session records (step 8, §6.1). */
function wireAgentSessions(settings: LocalSettings): void {
  setAgentSessionFileDeps({ isDemoMode: () => settings.isDemoModeEnabled })
  if (settings.isDemoModeEnabled) void wipeDemoAgentSessions()
}

/** Same demo discipline for generated-media gallery records (step 8, §6.1). */
function wireMediaRecords(settings: LocalSettings): void {
  setMediaItemFileDeps({ isDemoMode: () => settings.isDemoModeEnabled })
  if (settings.isDemoModeEnabled) void wipeDemoMediaRecords()
}

/** Same demo discipline for user preferences (step 8, §6.1). */
function wirePreferences(settings: LocalSettings): void {
  setPreferencesFileDeps({ isDemoMode: () => settings.isDemoModeEnabled })
  if (settings.isDemoModeEnabled) void wipeDemoPreferences()
}

/** Same demo discipline for permission grants (step 13). */
function wirePermissionGrants(settings: LocalSettings): void {
  setPermissionGrantsDeps({ isDemoMode: () => settings.isDemoModeEnabled })
  if (settings.isDemoModeEnabled) void wipeDemoPermissionGrants()
}

/** Same demo discipline for the RAG document list (step 8, §6.1). */
function wireRagDocuments(settings: LocalSettings): void {
  setRagDocumentFilesDeps({ isDemoMode: () => settings.isDemoModeEnabled })
  if (settings.isDemoModeEnabled) void wipeDemoRagDocuments()
}

/** Same demo discipline for the agent workspace state (step 8, §6.1). */
function wireAgentWorkspace(settings: LocalSettings): void {
  setAgentWorkspaceFilesDeps({ isDemoMode: () => settings.isDemoModeEnabled })
  if (settings.isDemoModeEnabled) void wipeDemoAgentWorkspace()
}

/**
 * Chat turns run in main (architecture-target §8 step 6): the renderer submits
 * a typed request over `chat:submitTurn` and consumes kernel `chat-chunk`
 * events. These deps are the only pieces of that engine that live outside the
 * chat modules — the service registry, last-load memory, the Home Agent
 * loopback token, and on-disk aipg-media bytes.
 */
function wireChatEngine(): void {
  setChatReadinessDeps({
    getService: (name) => serviceRegistry?.getService(name),
    awaitChatWindow,
    stopOvmsImageServer: async () => {
      const ovms = serviceRegistry?.getService('openvino-backend')
      if (ovms && 'stopImageServer' in ovms && typeof ovms.stopImageServer === 'function') {
        await ovms.stopImageServer()
      }
    },
    notifyHomeAgentUpstreamReady: (baseUrl) => {
      const homeAgentSvc = serviceRegistry?.getService('home-agent-backend')
      if (homeAgentSvc instanceof HomeAgentBackendService) {
        homeAgentSvc.notifyUpstreamReady(baseUrl)
      }
    },
    resetIdleChatBackend: async (serviceName) => {
      const service = serviceRegistry?.getService(serviceName)
      if (!service) return
      await service.stop()
      await service.start()
    },
  })
  setChatModelDeps({
    llmApiBase: (backend) => llmServerBaseUrl(backend),
    ensureBackendReadiness: (args) => ensureChatBackendReady(args),
    homeAgentAuthToken: () => {
      const homeAgentSvc = serviceRegistry?.getService('home-agent-backend')
      return homeAgentSvc instanceof HomeAgentBackendService
        ? homeAgentSvc.getLoopbackAuthToken()
        : ''
    },
    readCloudProviderKey,
  })
  // Reuses the main-side aipg-media reader the agent attachments already use;
  // the engine contract throws on failure (the ported customFetch behavior).
  setChatEngineDeps({
    readMediaAsDataUri: async (url) => {
      const dataUri = await readAipgMediaAsDataUri(url)
      if (!dataUri) throw new Error(`Could not read media ${url}`)
      return dataUri
    },
    // Tracing hooks: no-ops in laminar.ts unless a Laminar config is present.
    noteTimings: (timings) => noteLlamaCppChatTimings(timings),
    noteTraceContext: (context) => noteMainChatTurnContext(context),
  })
  setRagRetrievalDeps({
    ensureEmbeddingServerReady: async (serviceName, embeddingModel) => {
      const service = serviceRegistry?.getService(serviceName)
      if (!hostsEmbeddingServer(service)) {
        throw new Error(`Service ${serviceName} does not support a standalone embedding server`)
      }
      await startEmbeddingServer(service, embeddingModel)
    },
    getEmbeddingServerUrl: async (serviceName) => {
      const service = serviceRegistry?.getService(serviceName)
      if (!service) return null
      return embeddingServerUrl(service)
    },
    embed: async (inquiry) => {
      const docs = await retrieveChunks(handleUtilityFunction, langchainChild, inquiry)
      return Array.isArray(docs) ? docs : []
    },
    loadDocuments: async () => {
      const section = await readRagDocumentSection()
      return section?.ragList ?? null
    },
  })
}

/**
 * The artifact runner and GPU occupancy wrap (architecture-target §4.1 step 5)
 * run in main; everything they need that lives renderer-side — the model
 * pre-flight and download consent — crosses the `artifact:request` bridge.
 * Post-swap chat reload is in-process (`reloadLastChatBackend`). Service facts
 * are read through the registry and the kernel stream.
 */
function wireArtifactRunner(settings: LocalSettings): void {
  const comfyService = (): RunnerComfyService | null =>
    (serviceRegistry?.getService('comfyui-backend') ?? null) as RunnerComfyService | null

  // The in-process media tools resolve workflows from the same catalog the
  // runner trusts (bundle + user presets, dummies behind the debug gate).
  setMediaCatalogProvider(() =>
    getPresetCatalog(
      getPresetLoadConfig(settings),
      !app.isPackaged || settings.showDebugSettingsInUI,
    ),
  )

  setArtifactRunnerDeps({
    getComfyService: comfyService,
    onServiceStatusChange: (cb) =>
      onKernelEvent((event) => {
        if (event.type !== 'service') return
        const info = event.info as { serviceName?: string; status?: string }
        if (info?.serviceName === 'comfyui-backend' && info.status) cb(info.status)
      }),
    modelsMissing: async (preset) => {
      const reply = await requestRenderer<{ models: ArtifactMissingModel[] }>({
        kind: 'artifact-check-models',
        requiredModels: preset.requiredModels ?? [],
      })
      return reply.models ?? []
    },
    requestModelConsent: async (models, onProgress) => {
      try {
        await requestDownloadConsent(models, { onProgress })
        return true
      } catch (error) {
        appLogger.warn(`Model consent request failed: ${String(error)}`, 'electron-backend')
        return false
      }
    },
    ensureOvmsImageReady: (modelId, keepModelsLoaded, resolution) =>
      ensureOvmsImageServerReady('openvino-backend', modelId, keepModelsLoaded, resolution),
    readMediaAsDataUri: readAipgMediaAsDataUri,
    getPlatform: () => process.platform,
    devPresetsEnabled: () => !app.isPackaged || settings.showDebugSettingsInUI,
  })

  // The orchestrator owns GPU policy (step 7): every run — panel, chat tool,
  // Home Agent or in-process agent tool — is bracketed through these, so the
  // renderer's stop/return wraps and the occupancy refcount are gone.
  setOrchestratorDeps({
    stopChatForMedia: stopChatServicesForMedia,
    freeComfyMemory: async () => {
      const service = comfyService()
      if (!service || service.currentStatus !== 'running') return
      await freeMemoryAndUnloadModels(service.baseUrl, {
        getServiceBaseUrl: () => service.baseUrl,
        getToken: () => comfyService()?.getLoopbackAuthToken() ?? '',
      })
    },
    restartChatBackend: reloadLastChatBackend,
    chatRequestsOpen: () => chatInferenceStreamsActive() + piAgentCallsActive(),
  })
}

/**
 * Frees GPU memory the chat/LLM models hold before image generation — an
 * orchestrator dep (step 7): only running backends are touched, and OpenVINO
 * keeps its speech servers.
 */
async function stopChatServicesForMedia(): Promise<void> {
  if (!serviceRegistry) return
  for (const serviceName of ['llamacpp-backend', 'openvino-backend'] as const) {
    const service = serviceRegistry.getService(serviceName)
    if (!service || service.currentStatus !== 'running') continue
    try {
      if (
        serviceName === 'openvino-backend' &&
        'stopChatServers' in service &&
        typeof service.stopChatServers === 'function'
      ) {
        await service.stopChatServers()
      } else {
        await service.stop()
      }
    } catch (error) {
      appLogger.warn(
        `Failed to stop ${serviceName} before media: ${String(error)}`,
        'electron-backend',
      )
    }
  }
}

/** The audio a chat attachment may be, and the extension each is stored under. */
const AUDIO_ATTACHMENT_EXTENSIONS: Record<string, string> = {
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.m4a',
  'audio/ogg': '.ogg',
  'audio/webm': '.webm',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
}

/** Images plus the audio above; anything else reads as PNG. */
const MEDIA_MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
}

async function readAipgMediaAsDataUri(url: string): Promise<string | null> {
  const localPath = getLocalPathFromAipgMediaUrl(url)
  if (!localPath) return null
  try {
    const data = await fs.promises.readFile(localPath)
    const ext = path.extname(localPath).toLowerCase()
    const mime = MEDIA_MIME_BY_EXTENSION[ext] ?? 'image/png'
    return `data:${mime};base64,${data.toString('base64')}`
  } catch (error) {
    appLogger.warn(`Could not read media ${url}: ${String(error)}`, 'electron-backend')
    return null
  }
}

/**
 * Starts (or confirms) the OVMS image-gen server — shared by the renderer IPC
 * handler and the artifact runner, which calls it directly.
 */
async function ensureOvmsImageServerReady(
  serviceName: string,
  modelName: string,
  keepModelsLoaded?: boolean,
  resolution?: string,
): Promise<IpcOkWith<{ url: string }>> {
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
      appLogger.error(`Failed to ensure OVMS image readiness: ${errorMessage}`, 'electron-backend')
      return { success: false, error: errorMessage }
    }
  }

  return { success: false, error: 'Image server not supported by this backend' }
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
      typedSend(win.webContents, 'display-metrics-changed', {
        width: display.workAreaSize.width,
        height: display.workAreaSize.height,
      })
    }
  })

  // ── Cloud Mode provider API keys ────────────────────────────────────────
  registerInvokeHandlers(buildCloudProviderRegistry({ cloudProviderKeyPath, readCloudProviderKey }))

  // The renderer reports whether it has tracked work in flight; an input to
  // the main-owned close policy (see createWindow's 'close' handler).
  registerSendHandlers(
    buildLifecycleSendRegistry({
      setRendererBusy: (busy) => {
        rendererBusy = busy
      },
    }),
  )

  // Projection hydration: the renderer subscribes to the kernel event stream
  // BEFORE requesting this snapshot and applies only events above its
  // sequence (docs/architecture-target.md §4.6).
  registerInvokeHandlers(buildKernelRegistry({ getKernelSnapshot }))

  const pathsManager = new PathsManager(
    // Packaged: the per-user writable copy (seeded from the shared default on
    // first use). Its relative model paths still resolve against the shared
    // resources root via PathsManager, so downloads/scanning hit shared models.
    app.isPackaged
      ? writableConfigFile('model_config.json')
      : path.join(externalRes, 'model_config.dev.json'),
  )

  const coreDeps: CoreDeps = {
    getWin: () => win ?? undefined,
    getServiceRegistry: () => serviceRegistry,
    getLangchainChild: () => langchainChild,
    getDemoProfile: () => demoProfile,
    setDemoProfile: (profile) => {
      demoProfile = profile
    },
    settings,
    persistLocalSettingsToDisk,
    appLogger,
    appSize,
    mediaDir,
    mediaInputDir,
    modesDir,
    AUDIO_ATTACHMENT_EXTENSIONS,
    getLocalPathFromAipgMediaUrl,
    getModeDemoDir,
    getPresetLoadConfig,
    loadProductModeConfigs,
    handleUtilityFunction,
    ensureOvmsImageServerReady,
    pathsManager,
    peekApiServiceRegistry,
    invalidatePresetCatalog,
    loadPresetFiles,
    readPresetsFromDir,
    resolveModels,
    resolveBackendVersion,
    getGitHubRepoUrl,
    updateIntelPresets,
    filterPartnerPresets,
    detectOem,
    detectGpuHardwareDevices,
    classifyDetectedDevices,
    loadDemoProfile,
    getAudioDir,
    saveGeneratedAudioFile,
    laminarConfig,
    ensureChatBackendReady,
    rememberChatBackendLoad,
    setLastChatBackendLoadActive,
    resolveProductMode,
    COMFYUI_DEFAULT_PARAMETERS,
    LLAMACPP_DEFAULT_PARAMETERS,
    AiBackendService,
    ComfyUiBackendService,
    HomeAgentBackendService,
    Qwen3TtsBackendService,
    WhisperBackendService,
  }

  // The core registry (#301): every flat main-owned invoke channel — the
  // complement of the prefix domains registered below and above.
  registerInvokeHandlers(buildCoreInvokeRegistry(coreDeps))

  // Its sends: the flat renderer→main fire-and-forget channels (window
  // controls, image opens, drag start, telemetry forwarding).
  registerSendHandlers(
    buildCoreSendRegistry({
      getWin: coreDeps.getWin,
      getServiceRegistry: coreDeps.getServiceRegistry,
      appLogger,
      mediaDir,
      getLocalPathFromAipgMediaUrl,
      externalRes,
      handleChatTelemetryEvent,
      setVerboseAgentLogging,
    }),
  )

  registerInvokeHandlers(
    buildSafeStorageRegistry({ settings, persistLocalSettingsToDisk, appLogger }),
  )

  // ── Artifact runner IPC (architecture-target §4.1 step 5) ─────────────────
  // The renderer ships fully-resolved runs; the runner owns readiness,
  // submission and the progress stream back over the kernel bus.

  registerInvokeHandlers(
    buildArtifactRegistry({
      appLogger,
      submitArtifactRun,
      cancelArtifactRun,
      cancelActiveArtifactRun,
      handleMediaResponse,
    }),
  )

  registerInvokeHandlers(
    buildPermissionsRegistry({
      requestDownloadConsent,
      requestVramWarningConsent,
      listGrants,
      grantPermission,
      revokePermission,
      migrateGrants,
      handlePermissionsPromptResponse,
    }),
  )

  registerInvokeHandlers(
    buildChatRegistry({
      submitChatTurn,
      resumeChatTurn,
      cancelChatTurn,
      handleChatAnswer,
      summarizeConversationText,
    }),
  )

  registerInvokeHandlers(
    buildConversationsRegistry({
      bootstrapConversations,
      deleteConversation,
      migrateLegacyConversations,
      saveConversation,
      saveConversationLastMainKey,
    }),
  )

  registerInvokeHandlers(
    buildAgentModeRegistry({
      startAgentTurn,
      cancelAgentTurn,
      resetAgentSession,
      deleteAgentSession,
      submitAgentToolResult,
      listAgentCapabilities,
      importAttachment,
      bootstrapAgentSessions,
      migrateLegacyAgentSessions,
      saveAgentSession,
      saveAgentSessionActiveId,
      deleteAgentSessionRecord,
      readAgentWorkspaceState,
      migrateAgentWorkspaceState,
      writeAgentWorkspaceState,
    }),
  )

  // Generated-media gallery records (step 8, §6.1): same one-writer contract
  // as the conversations and agent sessions above — one JSON per item plus an
  // ordered index inside `media/records/`, beside the media files themselves.
  registerInvokeHandlers(
    buildMediaItemsRegistry({
      bootstrapMediaItems,
      migrateLegacyMediaItems,
      saveMediaItems,
      deleteMediaItemRecords,
    }),
  )

  // User preferences (step 8, §6.1): one file, one section per store. The
  // one-shot migrate writes only when the section is absent, so a retry can
  // never overwrite what the files already own.
  registerInvokeHandlers(
    buildPreferencesRegistry({
      readAllPreferences,
      migratePreferenceSection,
      writePreferenceSection,
    }),
  )

  // ── RAG documents (step 8, §6.1): the textInference store's indexed
  // document set, one kernel-owned file — same section-shaped contract as
  // the preferences channels, over rag/documents.json. read keeps "absent"
  // (section null) apart from "failed" (success false): only the former may
  // trigger the one-shot legacy upload.
  registerInvokeHandlers(
    buildRagDocumentsRegistry({
      readRagDocumentSection,
      migrateRagDocumentSection,
      writeRagDocumentSection,
    }),
  )

  // ComfyUI Tools IPC handlers
  registerInvokeHandlers(
    buildComfyuiRegistry({
      comfyService: () =>
        serviceRegistry?.getService('comfyui-backend') as ComfyUiBackendService | undefined,
      comfyuiTools,
    }),
  )

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
  // it is never exposed to the LLM. The Chat tool captures in main (it ships
  // the bound window on the turn); this channel serves the settings picker.
  const screenshotDeps = {
    getScreenCaptureStatus,
    openScreenCaptureSettings,
    listCaptureWindows,
    captureWindow,
  }
  registerInvokeHandlers(buildScreenshotRegistry(screenshotDeps))
  registerSendHandlers(buildScreenshotSendRegistry(screenshotDeps))

  registerInvokeHandlers(
    buildCameraCaptureRegistry({
      isAcerMachine: async () => (await detectOem(settings.oemVendorOverride)).vendor === 'acer',
      isDirectRunning: acerCameraDirectRunning,
      logWarn: (message) => appLogger.warn(message, 'electron-backend'),
      registerShortcut: registerCameraCaptureShortcut,
      unregisterShortcut: unregisterCameraCaptureShortcut,
    }),
  )

  // MCP server IPC handlers
  const mcpDeps = {
    settings,
    persistLocalSettingsToDisk,
    startMcpServer,
    stopMcpServer,
    stopAllMcpServers,
    getMcpServerStatus,
    listMcpServers,
    listMcpServerTools,
    invokeMcpServerTool,
    getMcpConfigPath,
    addMcpServer,
    getMcpServerConfig,
    updateMcpServer,
    removeMcpServer,
    isAutoDetectId,
  }
  registerInvokeHandlers(buildMcpRegistry(mcpDeps))
  registerSendHandlers(buildMcpSendRegistry(mcpDeps))

  // Game library (see gameLibrary.ts): the folders the Game Agent preset writes
  // into, plus the generated gallery page.
  registerInvokeHandlers(
    buildGamesRegistry({
      settings,
      detectOem,
      getGamesDir,
      listGames,
      readGame,
      provisionalName,
      createGame,
      publishGame,
      arcadeCatalog,
      setArcadeShown,
      writeArcade,
    }),
  )

  // Web browser IPC handlers — drives the headless BrowserWindow that the chat
  // LLM uses to browse the web (see adapters/webBrowserManager.ts).
  registerInvokeHandlers(
    buildWebBrowserRegistry({
      navigateWebBrowser,
      readWebBrowserPage,
      searchWebBrowser,
      interactWebBrowser,
      screenshotWebBrowser,
      showWebBrowser,
      hideWebBrowser,
      closeWebBrowser,
      getWebBrowserState,
    }),
  )
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
    setComputeMetricsSink((snapshot) => {
      if (!window.isDestroyed()) typedSend(window.webContents, 'computeMetricsUpdate', snapshot)
    })
    startComputeMetricsSampler({ xpuSmiPath: getXpuSmiExePath() })
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
