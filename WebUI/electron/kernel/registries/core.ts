import fs from 'fs'
import path from 'node:path'
import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import {
  app,
  BrowserWindow,
  dialog,
  IpcMainInvokeEvent,
  nativeImage,
  net,
  screen,
  shell,
  type UtilityProcess,
} from 'electron'
import z from 'zod'
import { LocalSettingsSchema } from '../localSettings'
import { ipcErrorText, ipcFail, typedSend } from '../typedIpc'
import { hintFromError } from '../../adapters/backends/applicationControl.ts'
import type {
  CoreInvokeName,
  CoreSendName,
  InvokeHandlerMap,
  SendHandlerMap,
} from '../ipcRegistries'
import type { PathsManager } from '../pathsManager'
import type { LocalSettings, ProductMode, resolveProductMode } from '../localSettings'
import type { appLoggerInstance } from '../../observability/logger'
import type {
  ApiServiceRegistryImpl,
  peekApiServiceRegistry,
} from '../../adapters/backends/apiServiceRegistry'
import type {
  COMFYUI_DEFAULT_PARAMETERS,
  ComfyUiBackendService,
} from '../../adapters/backends/comfyUIBackendService'
import type { LLAMACPP_DEFAULT_PARAMETERS } from '../../adapters/backends/llamaCppBackendService'
import type { AiBackendService } from '../../adapters/backends/aiBackendService'
import type { HomeAgentBackendService } from '../../adapters/backends/homeAgentBackendService'
import type { Qwen3TtsBackendService } from '../../adapters/backends/qwen3TtsBackendService'
import type { WhisperBackendService } from '../../adapters/backends/whisperBackendService'
import type {
  GpuHardwareDevice,
  classifyDetectedDevices,
  detectGpuHardwareDevices,
} from '../../adapters/hardware/hardwareDiscovery'
import type { detectOem } from '../../adapters/hardware/oemDetection'
import type { DemoProfile, loadDemoProfile } from '../../persist/demoProfile'
import type { getAudioDir } from '../../persist/userDataPaths'
import type { saveGeneratedAudioFile } from '../../persist/audioFiles'
import type { handleChatTelemetryEvent, laminarConfig } from '../../observability/laminar'
import {
  collectComputeSnapshot,
  computeMetricsProbeReport,
  latestComputeSnapshot,
} from '../../adapters/hardware/computeMetrics'
import { readLlamaCppVramInputs } from '../../adapters/vram/llamaCppVramInputs'
import { readRemoteLlamaCppVramInputs } from '../../adapters/vram/remoteGgufMeta'
import type { setVerboseLogging } from '../../agent/piAgentLog.ts'
import type {
  ChatReadinessArgs,
  ensureChatBackendReady,
  rememberChatBackendLoad,
  setLastChatBackendLoadActive,
} from '../../chat/chatReadiness'
import type {
  PresetLoadConfig,
  invalidatePresetCatalog,
  loadPresetFiles,
  readPresetsFromDir,
} from '../../artifact/catalog'
import type { filterPartnerPresets, updateIntelPresets } from '../../adapters/updateIntelPresets'
import type {
  getGitHubRepoUrl,
  resolveBackendVersion,
  resolveModels,
} from '../../adapters/remoteUpdates'
import type { ModelPaths } from '@/assets/js/store/models'
import type { BackendServiceName } from '@/assets/js/store/backendServices'
import type { EmbedInquiry, IndexedDocument } from '@/types/rag'
import type { PhisonKmIngestConfig, WarmupRequest } from '@/types/phisonKmRag'
import {
  embeddingServerUrl,
  hostsEmbeddingServer,
  readsDedicatedEmbeddingUrl,
  startEmbeddingServer,
} from '../../rag/embeddingServer'
import { ingestDocument, retrieveChunks } from '../../rag/langchainCalls'
import type { IpcMutationResult, IpcOk, IpcOkWith } from '@/types/ipcChannels'
import type { SpeechSynthesisRequest } from '@/types/speechIpc'

const execAsync = promisify(exec)

/**
 * Everything in main.ts the 76 flat-channel handlers close over — the wiring
 * surface for every main-owned channel no prefix domain claims. Late-assigned
 * module state (the window, the service registry, the langchain worker, the
 * demo profile) reaches the handlers through accessors; the rest is the live
 * settings object, main-owned helpers, and imported module functions.
 */
export type CoreDeps = {
  getWin: () => BrowserWindow | undefined
  getServiceRegistry: () => ApiServiceRegistryImpl | null
  getLangchainChild: () => UtilityProcess | null
  getDemoProfile: () => DemoProfile | null
  setDemoProfile: (profile: DemoProfile | null) => void
  settings: LocalSettings
  persistLocalSettingsToDisk: () => void
  appLogger: typeof appLoggerInstance
  appSize: { width: number; height: number; maxChatContentHeight: number }
  mediaDir: string
  mediaInputDir: string
  modesDir: string
  AUDIO_ATTACHMENT_EXTENSIONS: Record<string, string>
  getLocalPathFromAipgMediaUrl: (url: string) => string | null
  getModeDemoDir: (s: LocalSettings) => string
  getPresetLoadConfig: (s: LocalSettings) => PresetLoadConfig
  loadProductModeConfigs: () => Array<{
    mode: ProductMode
    priority: number
    recommendForIntelDeviceIds: string[]
    recommendForNvidia: boolean
    experimental: boolean
    displayOrder: number
    ui: {
      i18n: {
        titleOne: string
        titleTwo: string
        subtitle?: string
        description: string
        supportedHardware: string
        features?: Array<{ labelKey: string; detailKey: string }>
      }
    }
  }>
  handleUtilityFunction: <T, R>(
    eventType: string,
    child: UtilityProcess | null,
    args: T,
  ) => Promise<R>
  ensureOvmsImageServerReady: (
    serviceName: string,
    modelName: string,
    keepModelsLoaded?: boolean,
    resolution?: string,
  ) => Promise<IpcOkWith<{ url: string }>>
  pathsManager: PathsManager
  peekApiServiceRegistry: typeof peekApiServiceRegistry
  invalidatePresetCatalog: typeof invalidatePresetCatalog
  loadPresetFiles: typeof loadPresetFiles
  readPresetsFromDir: typeof readPresetsFromDir
  resolveModels: typeof resolveModels
  resolveBackendVersion: typeof resolveBackendVersion
  getGitHubRepoUrl: typeof getGitHubRepoUrl
  updateIntelPresets: typeof updateIntelPresets
  filterPartnerPresets: typeof filterPartnerPresets
  detectOem: typeof detectOem
  detectGpuHardwareDevices: typeof detectGpuHardwareDevices
  classifyDetectedDevices: typeof classifyDetectedDevices
  loadDemoProfile: typeof loadDemoProfile
  getAudioDir: typeof getAudioDir
  saveGeneratedAudioFile: typeof saveGeneratedAudioFile
  laminarConfig: typeof laminarConfig
  ensureChatBackendReady: typeof ensureChatBackendReady
  rememberChatBackendLoad: typeof rememberChatBackendLoad
  setLastChatBackendLoadActive: typeof setLastChatBackendLoadActive
  resolveProductMode: typeof resolveProductMode
  COMFYUI_DEFAULT_PARAMETERS: typeof COMFYUI_DEFAULT_PARAMETERS
  LLAMACPP_DEFAULT_PARAMETERS: typeof LLAMACPP_DEFAULT_PARAMETERS
  AiBackendService: typeof AiBackendService
  ComfyUiBackendService: typeof ComfyUiBackendService
  HomeAgentBackendService: typeof HomeAgentBackendService
  Qwen3TtsBackendService: typeof Qwen3TtsBackendService
  WhisperBackendService: typeof WhisperBackendService
}

export function buildCoreInvokeRegistry(deps: CoreDeps) {
  return {
    getLocaleSettings: async () => {
      return {
        locale: app.getLocale(),
        languageOverride: deps.settings.languageOverride,
      }
    },

    getLocalSettings: () => {
      return LocalSettingsSchema.parse(deps.settings)
    },

    updateLocalSettings: (_event, updates: Partial<LocalSettings>) => {
      Object.assign(deps.settings, updates)
      // Any of these can change which preset files the catalog reads or injects.
      if (
        'productMode' in updates ||
        'isDemoModeEnabled' in updates ||
        'isAgentPresetEnabled' in updates ||
        'showDebugSettingsInUI' in updates
      ) {
        deps.invalidatePresetCatalog()
      }
      const shouldReloadDemoProfile =
        deps.settings.isDemoModeEnabled &&
        ('productMode' in updates || 'isDemoModeEnabled' in updates)
      if (shouldReloadDemoProfile) {
        const modeDemoDir = deps.getModeDemoDir(deps.settings)
        const baseDemoDir = path.join(deps.modesDir, 'base', 'demo')
        try {
          deps.setDemoProfile(deps.loadDemoProfile(modeDemoDir, baseDemoDir, deps.appLogger))
        } catch (e) {
          deps.appLogger.error(
            `Failed to reload demo profile after settings change: ${e}`,
            'demo-profile',
          )
        }
      }
      deps.persistLocalSettingsToDisk()
      if (updates.disabledBackends) {
        deps.getServiceRegistry()?.setDisabledBackends(updates.disabledBackends)
      }
      deps.appLogger.info(`Updated local settings: ${JSON.stringify(updates)}`, 'electron-backend')
      return { success: true as const }
    },

    // ── Backend launch settings (step 8, §6.1) ─────────────────────────────
    // The backendServices store's half of the kernel-owned settings file:
    // the launch flags and version pins hydrate from settings.json at boot and
    // write through on change (updateLocalSettings above), replacing the old
    // renderer-persisted Pinia key. The device map is main-owned all along —
    // selectDevice below writes it — so it is only ever read here.
    getBackendLaunchSettings: () => ({
      versionOverrides: deps.settings.versionOverrides,
      comfyUiParameters: deps.settings.comfyUiParameters,
      llamaCppParameters: deps.settings.llamaCppParameters,
      llamaCppBuildVariant: deps.settings.llamaCppBuildVariant,
      llamaCppOffloadDrive: deps.settings.llamaCppOffloadDrive,
      openvinoKvCacheU4: deps.settings.openvinoKvCacheU4,
      lastSelectedDevicePerBackend: deps.settings.lastSelectedDevicePerBackend,
    }),

    // One-shot legacy upload from the pre-step-8 Pinia key. Per-field
    // only-when-default: settings.json may already hold a value a previous
    // partial migration wrote, and a null flag is a valid user choice that
    // must not be mistaken for "never set".
    migrateBackendLaunchSettings: (_event, payload: unknown) => {
      const parsed = z
        .object({
          versionOverrides: z
            .record(
              z.string(),
              z.object({ releaseTag: z.string().optional(), version: z.string() }),
            )
            .optional(),
          comfyUiParameters: z.string().nullable().optional(),
          llamaCppParameters: z.string().nullable().optional(),
          llamaCppBuildVariant: z.enum(['standard', 'ssd-offload']).optional(),
          llamaCppOffloadDrive: z.string().nullable().optional(),
          openvinoKvCacheU4: z.boolean().optional(),
        })
        .safeParse(payload)
      if (!parsed.success) {
        return {
          success: false as const,
          error: `invalid launch settings payload: ${parsed.error.message}`,
        }
      }
      const incoming = parsed.data
      if (incoming.comfyUiParameters != null && deps.settings.comfyUiParameters === null) {
        deps.settings.comfyUiParameters = incoming.comfyUiParameters
      }
      if (incoming.llamaCppParameters != null && deps.settings.llamaCppParameters === null) {
        deps.settings.llamaCppParameters = incoming.llamaCppParameters
      }
      if (
        incoming.llamaCppBuildVariant === 'ssd-offload' &&
        deps.settings.llamaCppBuildVariant === 'standard'
      ) {
        deps.settings.llamaCppBuildVariant = incoming.llamaCppBuildVariant
      }
      if (incoming.llamaCppOffloadDrive != null && deps.settings.llamaCppOffloadDrive === null) {
        deps.settings.llamaCppOffloadDrive = incoming.llamaCppOffloadDrive
      }
      if (incoming.openvinoKvCacheU4 === true && deps.settings.openvinoKvCacheU4 === false) {
        deps.settings.openvinoKvCacheU4 = true
      }
      if (
        incoming.versionOverrides &&
        Object.keys(incoming.versionOverrides).length > 0 &&
        Object.keys(deps.settings.versionOverrides).length === 0
      ) {
        deps.settings.versionOverrides = incoming.versionOverrides
      }
      deps.persistLocalSettingsToDisk()
      return { success: true as const }
    },

    detectHardwareForModeRecommendation: async () => {
      let detected: GpuHardwareDevice[] = []
      let hasNvidia = false
      let detectSuccess = true

      try {
        const probe = await deps.detectGpuHardwareDevices()
        detected = probe.detected
        hasNvidia = probe.hasNvidia
        deps.appLogger.info(`Detected GPU devices: ${JSON.stringify(detected)}`, 'electron-backend')
        deps.appLogger.info(`Has NVIDIA: ${hasNvidia}`, 'electron-backend')
      } catch (e) {
        detectSuccess = false
        deps.appLogger.warn(`GPU detection failed: ${e}`, 'electron-backend')
      }

      const configs = deps.loadProductModeConfigs()

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
        detectedDevices: deps.classifyDetectedDevices(detected),
        hasNvidiaGpu: hasNvidia,
        modeCatalog,
      }
    },

    getWinSize: () => {
      return deps.appSize
    },

    zoomIn: (event: IpcMainInvokeEvent) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 1)
    },

    zoomOut: (event: IpcMainInvokeEvent) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return
      win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 1)
    },

    setWinSize: (event: IpcMainInvokeEvent, width: number, height: number) => {
      const win = BrowserWindow.fromWebContents(event.sender)!
      const winRect = win.getBounds()
      if (winRect.width != width || winRect.height != height) {
        const y = winRect.y + (winRect.height - height)
        win.setBounds({ x: winRect.x, y, width, height })
      }
    },

    restorePathsSettings: (_event: IpcMainInvokeEvent) => {
      deps.pathsManager.restoreDefaultModelPaths()
    },

    saveImageToMediaInput: async (_event, dataUri: string) => {
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
      const filePath = path.join(deps.mediaInputDir, filename)
      const buffer = Buffer.from(base64Data, 'base64')
      await fs.promises.writeFile(filePath, buffer)
      return `input/${filename}`
    },

    // An attached clip is kept beside attached images rather than inlined in the
    // thread: a minute of audio is megabytes of base64 in the conversation file,
    // and `transcribeAudio` reads it back through the same media reader.
    saveAudioToMediaInput: async (_event, dataUri: string) => {
      const match =
        typeof dataUri === 'string'
          ? dataUri.match(/^data:(audio\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
          : null
      if (!match) {
        throw new Error('saveAudioToMediaInput: expected a data URI (data:audio/...;base64,...)')
      }
      const ext = deps.AUDIO_ATTACHMENT_EXTENSIONS[match[1].toLowerCase()]
      if (!ext) throw new Error(`saveAudioToMediaInput: unsupported audio type ${match[1]}`)
      const filename = `${randomUUID()}${ext}`
      await fs.promises.writeFile(
        path.join(deps.mediaInputDir, filename),
        Buffer.from(match[2], 'base64'),
      )
      return `input/${filename}`
    },

    saveGeneratedAudio: async (
      _event,
      audioBase64: string,
      filename: string,
      options?: { overwrite?: boolean },
    ): Promise<IpcOkWith<{ filePath: string }>> => {
      try {
        if (typeof audioBase64 !== 'string' || typeof filename !== 'string') {
          return { success: false, error: 'invalid arguments' }
        }
        const filePath = await deps.saveGeneratedAudioFile(audioBase64, filename, options)
        return { success: true, filePath }
      } catch (error) {
        const errorMessage = ipcErrorText(error)
        deps.appLogger.error(`Failed to save generated audio: ${errorMessage}`, 'electron-backend')
        return { success: false, error: errorMessage }
      }
    },

    /**
     * Delete a generated audio file. Confined to the app's audio directory by the same
     * containment check `readLocalAudioAsDataUri` uses, so a renderer-supplied path can
     * never reach anything else. A path that is already gone counts as success —
     * the caller wants the file absent, not proof that it deleted it.
     */
    deleteGeneratedAudio: async (_event, filePath: string): Promise<IpcMutationResult> => {
      try {
        if (typeof filePath !== 'string' || !filePath.trim()) {
          return { success: false, error: 'invalid path' }
        }
        const audioRoot = path.normalize(deps.getAudioDir())
        const full = path.normalize(
          path.isAbsolute(filePath) ? filePath : path.join(audioRoot, filePath),
        )
        if (full !== audioRoot && !full.startsWith(audioRoot + path.sep)) {
          return { success: false, error: 'path outside audio directory' }
        }
        await fs.promises.rm(full, { force: true })
        return { success: true }
      } catch (error) {
        const errorMessage = ipcErrorText(error)
        deps.appLogger.error(
          `Failed to delete generated audio: ${errorMessage}`,
          'electron-backend',
        )
        return { success: false, error: errorMessage }
      }
    },

    readLocalAudioAsDataUri: async (
      _event,
      filePath: string,
    ): Promise<IpcOkWith<{ dataUri: string }>> => {
      try {
        if (typeof filePath !== 'string' || !filePath.trim()) {
          return { success: false, error: 'invalid path' }
        }
        const audioRoot = path.normalize(deps.getAudioDir())
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
        return ipcFail(error)
      }
    },

    // Persist an inbound Home Agent document (base64) to disk so the langchain
    // RAG loaders (which require a real filepath) can index it, and so the
    // persisted ragList entry keeps a stable path. Returns the absolute path.
    saveHomeAgentDocument: async (
      _event,
      filename: string,
      base64: string,
    ): Promise<IpcOkWith<{ filepath: string }>> => {
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
        const ragDocumentsDir = path.join(deps.mediaDir, 'rag-documents')
        await fs.promises.mkdir(ragDocumentsDir, { recursive: true })
        const uniqueName = `${randomUUID()}-${safeName}`
        const filePath = path.join(ragDocumentsDir, uniqueName)
        await fs.promises.writeFile(filePath, Buffer.from(base64, 'base64'))
        return { success: true, filepath: filePath }
      } catch (e) {
        return ipcFail(e)
      }
    },

    readAipgMediaAsBase64: async (
      _event,
      url: string,
    ): Promise<{ success: true; data: string } | { success: false; error: string }> => {
      const filePath = deps.getLocalPathFromAipgMediaUrl(url)
      if (!filePath) {
        return { success: false, error: 'invalid or unsafe aipg-media URL' }
      }
      if (!fs.existsSync(filePath)) {
        return { success: false, error: `file not found (${path.basename(filePath)})` }
      }
      try {
        return { success: true, data: fs.readFileSync(filePath).toString('base64') }
      } catch (e) {
        return ipcFail(e)
      }
    },

    /** Get command line parameters when launched from IPOS to decide the default home page.
     * Returns null when --start-page was not provided so the renderer can leave
     * the persisted mode untouched; returns the validated ModeType (or 'chat' as
     * a safe fallback for an invalid value) when it was. */
    getInitialPage: (): ModeType | null => {
      const validModes: ModeType[] = ['chat', 'audio', 'imageGen', 'imageEdit', 'video']
      const startPageArg = process.argv.find((arg) => arg.startsWith('--start-page='))
      if (!startPageArg) return null
      const parsed = startPageArg.split('=')[1]
      return validModes.includes(parsed as ModeType) ? (parsed as ModeType) : 'chat'
    },

    /** To check whether demo mode is enabled or not for AIPG */
    getDemoModeSettings: () => {
      return {
        isDemoModeEnabled: deps.settings.isDemoModeEnabled,
        demoModeResetInSeconds: deps.settings.demoModeResetInSeconds,
        demoModePasscode: deps.settings.demoModePasscode,
        profile: deps.getDemoProfile(),
      }
    },

    showOpenDialog: async (event, options) => {
      const win = BrowserWindow.fromWebContents(event.sender)!
      return await dialog.showOpenDialog(win, options)
    },

    showMessageBox: async (event, options) => {
      const win = BrowserWindow.fromWebContents(event.sender)!
      return dialog.showMessageBox(win, options)
    },

    existsPath: async (event, path: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) {
        return
      }
      return fs.existsSync(path)
    },

    getInitSetting: (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) {
        return
      }
      return {
        modelLists: deps.pathsManager.scanAll(),
        modelPaths: deps.pathsManager.modelPaths,
        version: app.getVersion(),
        modelFolderReadOnly: !deps.pathsManager.isModelDirWritable(),
      }
    },

    loadModels: async (_event) => {
      return deps.resolveModels(deps.settings)
    },

    // The renderer forwards its AI SDK telemetry here (the SDK cannot run in a
    // browser page); null config means no developer opted in, and the renderer
    // then registers nothing and sends nothing.
    getLaminarConfig: () => deps.laminarConfig(),

    getComputeMetrics: async () => latestComputeSnapshot() ?? collectComputeSnapshot(),

    getComputeMetricsDiagnostics: () => computeMetricsProbeReport(),

    getLlamaCppVramInputs: async (_event, modelName: string, mmprojName?: string) => {
      try {
        const local = readLlamaCppVramInputs(deps.pathsManager.modelPaths.ggufLLM, modelName)
        if (local) return local
        const remote = await readRemoteLlamaCppVramInputs(
          { name: modelName, mmproj: mmprojName },
          {
            endpoint: deps.settings.huggingfaceEndpoint,
            cachePath: path.join(app.getPath('userData'), 'gguf-vram-cache.json'),
          },
        )
        return remote ?? null
      } catch (error) {
        deps.appLogger.warn(
          `Could not read VRAM inputs for ${modelName}: ${error}`,
          'electron-backend',
        )
        return null
      }
    },

    updateModelPaths: (_event, modelPaths: ModelPaths) => {
      deps.pathsManager.updateModelPaths(modelPaths)
      return deps.pathsManager.scanAll()
    },

    getDownloadedGGUFLLMs: (_event) => {
      return deps.pathsManager.scanGGUFLLMModels()
    },

    getDownloadedOpenVINOLLMModels: (_event) => {
      return deps.pathsManager.scanOpenVINOModels()
    },

    getDownloadedEmbeddingModels: (_event) => {
      return deps.pathsManager.scanEmbedding()
    },

    getComfyUIModels: (_event, modelType: string) => {
      return deps.pathsManager.scanComfyUIModels(modelType)
    },

    scanModelLibrary: (_event) => {
      return deps.pathsManager.scanModelLibrary()
    },

    showModelInFolder: (_event, modelPath: string) => {
      const resolved = deps.pathsManager.resolveModelPath(modelPath)
      if ('error' in resolved) {
        return { success: false as const, error: resolved.error }
      }
      if (process.platform === 'win32') {
        // `execFile`, not `exec`: the path is passed as an argument rather than
        // spliced into a shell command line, so a model directory containing a
        // quote or an `&` opens the folder instead of running as a command.
        execFile('explorer.exe', ['/select,', resolved.path])
      } else {
        shell.showItemInFolder(resolved.path)
      }
      return { success: true as const }
    },

    // Permanent deletion, deliberately not a move to trash: freeing the disk space
    // immediately is the reason a user deletes a model. Every path is validated
    // against the configured model directories first — see resolveModelPath.
    deleteModelPath: async (_event, modelPath: string) => {
      const resolved = deps.pathsManager.resolveModelPath(modelPath)
      if ('error' in resolved) {
        return { success: false as const, error: resolved.error }
      }
      try {
        // Async throughout: a model is tens of gigabytes across thousands of files,
        // and the synchronous form froze the whole UI for the duration of the walk.
        // No `force`: a path that vanished should be reported, not silently
        // treated as a successful delete.
        await fs.promises.rm(resolved.path, { recursive: true })
        await deps.pathsManager.pruneEmptyModelDirs(resolved.path)
      } catch (error) {
        return ipcFail(error)
      }

      const comfyService = deps.getServiceRegistry()?.getService('comfyui-backend') as
        ComfyUiBackendService | undefined
      const comfyUiModelsRoot = comfyService?.serviceDir
        ? path.join(comfyService.serviceDir, 'models')
        : undefined
      for (const mirror of deps.pathsManager.mirroredModelPaths(resolved.path, comfyUiModelsRoot)) {
        try {
          await fs.promises.rm(mirror, { recursive: true, force: true })
        } catch (error) {
          // The primary copy is already gone; a failed mirror cleanup is worth a
          // log but must not report the delete as failed.
          deps.appLogger.warn(
            `Could not remove mirrored model copy ${mirror}: ${error}`,
            'electron-backend',
          )
        }
      }
      return { success: true as const }
    },

    getPlatform: () => process.platform,

    addDocumentToRAGList: (
      _event,
      document: IndexedDocument,
      phisonKmConfig?: PhisonKmIngestConfig,
    ) =>
      ingestDocument(
        deps.handleUtilityFunction,
        deps.getLangchainChild(),
        document,
        phisonKmConfig,
      ),

    embedInputUsingRag: (_event, embedInquiry: EmbedInquiry) =>
      retrieveChunks(deps.handleUtilityFunction, deps.getLangchainChild(), embedInquiry),

    warmupKVCacheForDocument: (_event, request: WarmupRequest) => {
      return deps.handleUtilityFunction<WarmupRequest, IpcOk>(
        'warmupKVCacheForDocument',
        deps.getLangchainChild(),
        request,
      )
    },

    getServices: () => {
      const registry = deps.getServiceRegistry() ?? deps.peekApiServiceRegistry()
      if (!registry) {
        deps.appLogger.warn(
          'frontend tried to getServices too early during aipg startup',
          'electron-backend',
        )
        return []
      }
      return registry.getServiceInformation()
    },

    getBackendAuthToken: (_event: IpcMainInvokeEvent, serviceName: string) => {
      const serviceRegistry = deps.getServiceRegistry()
      if (!serviceRegistry) {
        return ''
      }
      const service = serviceRegistry.getService(serviceName)
      if (service instanceof deps.AiBackendService) {
        return service.getLoopbackAuthToken()
      }
      if (service instanceof deps.ComfyUiBackendService) {
        return service.getLoopbackAuthToken()
      }
      if (service instanceof deps.HomeAgentBackendService) {
        return service.getLoopbackAuthToken()
      }
      if (service instanceof deps.Qwen3TtsBackendService) {
        return service.getLoopbackAuthToken()
      }
      if (service instanceof deps.WhisperBackendService) {
        return service.getLoopbackAuthToken()
      }
      return ''
    },

    uninstall: (_event: IpcMainInvokeEvent, serviceName: string) => {
      const serviceRegistry = deps.getServiceRegistry()
      if (!serviceRegistry) {
        deps.appLogger.warn('received uninstall too early during aipg startup', 'electron-backend')
        return
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        deps.appLogger.warn(
          `Tried to uninstall service ${serviceName} which is not known`,
          'electron-backend',
        )
        return
      }
      return service.uninstall()
    },

    updateServiceSettings: (_event: IpcMainInvokeEvent, settings) => {
      const serviceRegistry = deps.getServiceRegistry()
      if (!serviceRegistry) {
        deps.appLogger.warn(
          'received updateServiceSettings too early during aipg startup',
          'electron-backend',
        )
        return
      }
      const service = serviceRegistry.getService(settings.serviceName)
      if (!service) {
        deps.appLogger.warn(
          `Tried to update settings for service ${settings.serviceName} which is not known`,
          'electron-backend',
        )
        return
      }
      return service.updateSettings(settings)
    },

    getComfyUiDefaultParameters: () => deps.COMFYUI_DEFAULT_PARAMETERS,
    getLlamaCppDefaultParameters: () => deps.LLAMACPP_DEFAULT_PARAMETERS,

    // Which OEM's machine this is, for co-branding (see adapters/hardware/oemDetection.ts).
    detectOem: () => deps.detectOem(deps.settings.oemVendorOverride),

    detectPhisonSsd: async () => {
      if (deps.settings.PhisonSSDdetected) {
        deps.appLogger.info(
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
        deps.appLogger.warn(`detectPhisonSsd failed: ${e}`, 'electron-backend')
        return { detected: false }
      }
    },

    detectDevices: (_event: IpcMainInvokeEvent, serviceName: string) => {
      const serviceRegistry = deps.getServiceRegistry()
      if (!serviceRegistry) {
        deps.appLogger.warn(
          'received detectDevices too early during aipg startup',
          'electron-backend',
        )
        return
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        deps.appLogger.warn(
          `Tried to detectDevices for service ${serviceName} which is not known`,
          'electron-backend',
        )
        return
      }
      return service.detectDevices()
    },

    selectDevice: (_event: IpcMainInvokeEvent, serviceName: string, deviceId: string) => {
      deps.appLogger.info('selecting device', 'electron-backend')
      const serviceRegistry = deps.getServiceRegistry()
      if (!serviceRegistry) {
        deps.appLogger.warn(
          'received selectDevice too early during aipg startup',
          'electron-backend',
        )
        return
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        deps.appLogger.warn(
          `Tried to selectDevice for service ${serviceName} which is not known`,
          'electron-backend',
        )
        return
      }
      // Persist so the boot-time auto-start can restore this device instead of
      // resetting to the default GPU on the next restart. Record the device's
      // UUID too (when known) so the choice survives a selector-id shift.
      deps.settings.lastSelectedDevicePerBackend[serviceName] = deviceId
      const selectedDevice = (service as { devices?: InferenceDevice[] }).devices?.find(
        (d) => d.id === deviceId,
      )
      if (selectedDevice?.uuid) {
        deps.settings.lastSelectedDeviceUuidPerBackend[serviceName] = selectedDevice.uuid
      } else {
        delete deps.settings.lastSelectedDeviceUuidPerBackend[serviceName]
      }
      deps.persistLocalSettingsToDisk()
      return service.selectDevice(deviceId)
    },

    selectSttDevice: (_event: IpcMainInvokeEvent, serviceName: string, deviceId: string) => {
      deps.appLogger.info('selecting STT device', 'electron-backend')
      const serviceRegistry = deps.getServiceRegistry()
      if (!serviceRegistry) {
        deps.appLogger.warn(
          'received selectSttDevice too early during aipg startup',
          'electron-backend',
        )
        return
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        deps.appLogger.warn(
          `Tried to selectSttDevice for service ${serviceName} which is not known`,
          'electron-backend',
        )
        return
      }
      if ('selectSttDevice' in service && typeof service.selectSttDevice === 'function') {
        deps.settings.lastSelectedDevicePerBackend[`${serviceName}:stt`] = deviceId
        const selectedStt = (service as { sttDevices?: InferenceDevice[] }).sttDevices?.find(
          (d) => d.id === deviceId,
        )
        if (selectedStt?.uuid) {
          deps.settings.lastSelectedDeviceUuidPerBackend[`${serviceName}:stt`] = selectedStt.uuid
        } else {
          delete deps.settings.lastSelectedDeviceUuidPerBackend[`${serviceName}:stt`]
        }
        deps.persistLocalSettingsToDisk()
        return service.selectSttDevice(deviceId)
      }
      deps.appLogger.warn(
        `Service ${serviceName} does not support selectSttDevice`,
        'electron-backend',
      )
    },

    startService: (_event: IpcMainInvokeEvent, serviceName: string) => {
      const serviceRegistry = deps.getServiceRegistry()
      if (!serviceRegistry) {
        deps.appLogger.warn(
          'received start signal too early during aipg startup',
          'electron-backend',
        )
        return 'failed'
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        deps.appLogger.warn(
          `Tried to start service ${serviceName} which is not known`,
          'electron-backend',
        )
        return 'failed'
      }
      return service.start()
    },

    stopService: (_event: IpcMainInvokeEvent, serviceName: string) => {
      const serviceRegistry = deps.getServiceRegistry()
      if (!serviceRegistry) {
        deps.appLogger.warn(
          'received stop signal too early during aipg startup',
          'electron-backend',
        )
        return 'failed'
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        deps.appLogger.warn(
          `Tried to stop service ${serviceName} which is not known`,
          'electron-backend',
        )
        return 'failed'
      }
      return service.stop()
    },

    setUpService: async (_event: IpcMainInvokeEvent, serviceName: BackendServiceName) => {
      const serviceRegistry = deps.getServiceRegistry()
      const win = deps.getWin()
      if (!serviceRegistry || !win) {
        deps.appLogger.warn(
          'received setup signal too early during aipg startup',
          'electron-backend',
        )
        return
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        deps.appLogger.warn(
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
        deps.appLogger.warn(
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
          typedSend(win.webContents, 'serviceSetUpProgress', progressUpdate)
          if (progressUpdate.status === 'failed' || progressUpdate.status === 'success') {
            deps.appLogger.info(
              `Received terminal progress update for set up request for ${serviceName}`,
              'electron-backend',
            )
            break
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        deps.appLogger.error(
          `Set up for ${serviceName} threw without a terminal progress update: ${message}`,
          'electron-backend',
        )
        if (!win.isDestroyed()) {
          const hint = hintFromError(error, message)
          typedSend(win.webContents, 'serviceSetUpProgress', {
            serviceName,
            step: 'setup failed',
            status: 'failed',
            debugMessage: `Installation aborted: ${message}`,
            errorDetails: {
              stderr: message,
              timestamp: new Date().toISOString(),
              ...(hint ? { hint } : {}),
            },
          } satisfies SetupProgress)
        }
      } finally {
        service.setUpInProgress = false
      }
    },

    ensureBackendReadiness: async (
      _event: IpcMainInvokeEvent,
      serviceName: string,
      llmModelName: string,
      embeddingModelName?: string,
      contextSize?: number,
      modelArgs?: string,
      skipGpuAdmission?: boolean,
      options?: { remember?: boolean },
    ) => {
      const serviceRegistry = deps.getServiceRegistry()
      if (!serviceRegistry) {
        deps.appLogger.warn(
          'received ensureBackendReadiness too early during aipg startup',
          'electron-backend',
        )
        return { success: false as const, error: 'Service registry not ready' }
      }

      try {
        await deps.ensureChatBackendReady(
          { serviceName, llmModelName, embeddingModelName, contextSize, modelArgs },
          {
            skipGpuAdmission: Boolean(skipGpuAdmission),
            remember: options?.remember,
          },
        )
        return {
          success: true as const,
          service: serviceRegistry.getService(serviceName)?.get_info(),
        }
      } catch (error) {
        const errorMessage = ipcErrorText(error)
        deps.appLogger.error(
          `Failed to ensure backend readiness for ${serviceName}: ${errorMessage}`,
          'electron-backend',
        )
        return { success: false as const, error: errorMessage }
      }
    },

    setLastChatBackendLoadActive: (_event: IpcMainInvokeEvent, active: boolean) => {
      deps.setLastChatBackendLoadActive(Boolean(active))
      return { success: true as const }
    },

    rememberChatBackendLoad: (_event: IpcMainInvokeEvent, args: ChatReadinessArgs) => {
      if (typeof args?.serviceName !== 'string' || typeof args?.llmModelName !== 'string') {
        return { success: false as const, error: 'invalid last-load args' }
      }
      deps.rememberChatBackendLoad(args)
      return { success: true as const }
    },

    getEmbeddingServerUrl: async (
      _event: IpcMainInvokeEvent,
      serviceName: string,
    ): Promise<IpcOkWith<{ url: string }>> => {
      const serviceRegistry = deps.getServiceRegistry()
      if (!serviceRegistry) {
        return { success: false, error: 'Service registry not ready' }
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        return { success: false, error: `Service ${serviceName} not found` }
      }

      if (readsDedicatedEmbeddingUrl(service)) {
        const embeddingUrl = embeddingServerUrl(service)
        if (embeddingUrl) {
          return { success: true, url: embeddingUrl }
        }
        return { success: false, error: 'Embedding server not running' }
      }

      // For other backends, return the base URL (they might use the same server)
      return { success: true, url: service.baseUrl }
    },

    ensureEmbeddingServerReady: async (
      _event: IpcMainInvokeEvent,
      serviceName: string,
      embeddingModelName: string,
    ): Promise<IpcMutationResult> => {
      const serviceRegistry = deps.getServiceRegistry()
      if (!serviceRegistry) {
        return { success: false, error: 'Service registry not ready' }
      }
      const service = serviceRegistry.getService(serviceName)
      if (!service) {
        return { success: false, error: `Service ${serviceName} not found` }
      }

      // Only the local LLM backends (llamaCPP / openVINO) can host an embedding
      // server. Used by Cloud Mode RAG to embed locally while chatting remotely.
      if (hostsEmbeddingServer(service)) {
        try {
          await startEmbeddingServer(service, embeddingModelName)
          deps.appLogger.info(
            `Embedding server ready for ${serviceName} with model: ${embeddingModelName}`,
            'electron-backend',
          )
          return { success: true }
        } catch (error) {
          const errorMessage = ipcErrorText(error)
          deps.appLogger.error(
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

    startTranscriptionServer: async (
      _event: IpcMainInvokeEvent,
      modelName: string,
    ): Promise<IpcMutationResult> => {
      const serviceRegistry = deps.getServiceRegistry()
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
          const errorMessage = ipcErrorText(error)
          deps.appLogger.error(
            `Failed to start transcription server: ${errorMessage}`,
            'electron-backend',
          )
          return { success: false, error: errorMessage }
        }
      }

      return { success: false, error: 'Transcription server not supported' }
    },

    stopTranscriptionServer: async (_event: IpcMainInvokeEvent): Promise<IpcMutationResult> => {
      const serviceRegistry = deps.getServiceRegistry()
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
          const errorMessage = ipcErrorText(error)
          deps.appLogger.error(
            `Failed to stop transcription server: ${errorMessage}`,
            'electron-backend',
          )
          return { success: false, error: errorMessage }
        }
      }

      return { success: false, error: 'Transcription server not supported' }
    },

    getTranscriptionServerUrl: async (
      _event: IpcMainInvokeEvent,
    ): Promise<IpcOkWith<{ url: string }>> => {
      const serviceRegistry = deps.getServiceRegistry()
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
    },

    startSpeechServer: async (
      _event: IpcMainInvokeEvent,
      modelName: string,
    ): Promise<IpcMutationResult> => {
      const serviceRegistry = deps.getServiceRegistry()
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
          const errorMessage = ipcErrorText(error)
          deps.appLogger.error(`Failed to start speech server: ${errorMessage}`, 'electron-backend')
          return { success: false, error: errorMessage }
        }
      }

      return { success: false, error: 'Speech server not supported' }
    },

    stopSpeechServer: async (_event: IpcMainInvokeEvent): Promise<IpcMutationResult> => {
      const serviceRegistry = deps.getServiceRegistry()
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
          const errorMessage = ipcErrorText(error)
          deps.appLogger.error(`Failed to stop speech server: ${errorMessage}`, 'electron-backend')
          return { success: false, error: errorMessage }
        }
      }

      return { success: false, error: 'Speech server not supported' }
    },

    getSpeechServerUrl: async (_event: IpcMainInvokeEvent): Promise<IpcOkWith<{ url: string }>> => {
      const serviceRegistry = deps.getServiceRegistry()
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
    },

    // Synthesize speech in the main process so it is not subject to the
    // renderer's CORS policy. Many OpenAI-compatible `/audio/speech` servers
    // (e.g. local TTS fallbacks) do not answer the CORS preflight that an
    // `application/json` POST triggers, which blocks a direct renderer fetch.
    synthesizeSpeech: async (
      _event: IpcMainInvokeEvent,
      options: SpeechSynthesisRequest,
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
        const errorMessage = ipcErrorText(error)
        deps.appLogger.error(`Failed to synthesize speech: ${errorMessage}`, 'electron-backend')
        return { success: false, error: errorMessage }
      }
    },

    ensureOvmsImageReady: async (
      _event: IpcMainInvokeEvent,
      serviceName: string,
      modelName: string,
      keepModelsLoaded?: boolean,
      resolution?: string,
    ) => deps.ensureOvmsImageServerReady(serviceName, modelName, keepModelsLoaded, resolution),

    stopOvmsChatServers: async (_event: IpcMainInvokeEvent): Promise<IpcMutationResult> => {
      const serviceRegistry = deps.getServiceRegistry()
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
          const errorMessage = ipcErrorText(error)
          deps.appLogger.error(
            `Failed to stop OVMS chat servers: ${errorMessage}`,
            'electron-backend',
          )
          return { success: false, error: errorMessage }
        }
      }

      return { success: false, error: 'Chat servers not supported' }
    },

    getOvmsImageServerUrl: async (
      _event: IpcMainInvokeEvent,
    ): Promise<IpcOkWith<{ url: string }>> => {
      const serviceRegistry = deps.getServiceRegistry()
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
    },

    updatePresetsFromIntelRepo: () => {
      const mode = deps.resolveProductMode(deps.settings)
      const variant = deps.settings.isDemoModeEnabled ? 'demo' : 'presets'
      const config = deps.getPresetLoadConfig(deps.settings)
      const result = deps.updateIntelPresets(
        deps.settings.remoteRepository,
        mode,
        variant,
        config.baseDir,
        config.modeDir,
      )
      if (result instanceof Promise) result.then(() => deps.invalidatePresetCatalog())
      else deps.invalidatePresetCatalog()
      return result
    },

    reloadPresets: async () => {
      const config = deps.getPresetLoadConfig(deps.settings)
      try {
        await deps.filterPartnerPresets(config.baseDir)
      } catch (error) {
        deps.appLogger.error(`Failed to filter partner presets: ${error}`, 'electron-backend')
      }
      deps.invalidatePresetCatalog()
      try {
        return await deps.loadPresetFiles(config)
      } catch (error) {
        deps.appLogger.error(`Failed to load presets: ${error}`, 'electron-backend')
        return []
      }
    },

    getUserPresetsPath: async () => {
      const userDataPath = app.getPath('documents')
      const presetsPath = path.join(userDataPath, 'AI Playground', 'presets')
      // Ensure directory exists
      await fs.promises.mkdir(presetsPath, { recursive: true })
      return presetsPath
    },

    loadUserPresets: async () => {
      try {
        const userDataPath = app.getPath('documents')
        const presetsPath = path.join(userDataPath, 'AI Playground', 'presets')
        const presets = await deps.readPresetsFromDir(presetsPath)
        return [...presets.values()]
      } catch (error) {
        deps.appLogger.error(`Failed to load user presets: ${error}`, 'electron-backend')
        return []
      }
    },

    saveUserPreset: async (_event, presetContent: string) => {
      try {
        const userDataPath = app.getPath('documents')
        const presetsPath = path.join(userDataPath, 'AI Playground', 'presets')
        await fs.promises.mkdir(presetsPath, { recursive: true })

        // Parse to get preset name for filename
        const preset = JSON.parse(presetContent)
        const filename = `${preset.name.replace(/[^a-z0-9]/gi, '_')}.json`
        const filePath = path.join(presetsPath, filename)

        await fs.promises.writeFile(filePath, presetContent, { encoding: 'utf-8' })
        deps.appLogger.info(`Saved user preset to ${filePath}`, 'electron-backend')
        deps.invalidatePresetCatalog()
        return true
      } catch (error) {
        deps.appLogger.error(`Failed to save user preset: ${error}`, 'electron-backend')
        return false
      }
    },

    // Version management IPC handlers for frontend store integration
    resolveBackendVersion: async (_event, serviceName: BackendServiceName) => {
      return await deps.resolveBackendVersion(serviceName, deps.settings)
    },

    getGitHubRepoUrl: () => {
      return deps.getGitHubRepoUrl(deps.settings)
    },

    getInstalledBackendVersion: async (_event, serviceName: BackendServiceName) => {
      const serviceRegistry = deps.getServiceRegistry()
      if (!serviceRegistry) {
        deps.appLogger.warn('Service registry not ready', 'electron-backend')
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
        deps.appLogger.error(
          `Failed to get installed version for ${serviceName}: ${error}`,
          'electron-backend',
        )
        return undefined
      }
    },

    showSaveDialog: async (_event, options) => {
      return dialog.showSaveDialog(options).catch((error) => {
        deps.appLogger.error(
          `${JSON.stringify(error, Object.getOwnPropertyNames, 2)}`,
          'electron-backend',
        )
        return undefined
      })
    },
  } satisfies InvokeHandlerMap<CoreInvokeName>
}

/**
 * What the flat send listeners close over — the same late-bound accessors
 * CoreDeps uses for the window and registry, plus the main.ts-only seams that
 * have no reason to live here (the telemetry and verbose-log entry points and
 * the packaged-resources root for the drag-thumbnail fallback).
 */
export type CoreSendDeps = Pick<
  CoreDeps,
  'getWin' | 'getServiceRegistry' | 'appLogger' | 'mediaDir' | 'getLocalPathFromAipgMediaUrl'
> & {
  externalRes: string
  handleChatTelemetryEvent: typeof handleChatTelemetryEvent
  setVerboseAgentLogging: typeof setVerboseLogging
}

export function buildCoreSendRegistry(deps: CoreSendDeps) {
  return {
    // Start an OS drag of a generated file (history rows, image results).
    ondragstart: async (event, filePath) => {
      const imagePath = getAssetPathFromUrl(filePath, deps)
      if (!imagePath) return
      let thumbnail: Electron.NativeImage
      try {
        thumbnail = await nativeImage.createThumbnailFromPath(imagePath, {
          height: 128,
          width: 128,
        })
      } catch (_e: unknown) {
        thumbnail = await nativeImage.createThumbnailFromPath(
          path.join(deps.externalRes, 'cam.png'),
          {
            height: 128,
            width: 128,
          },
        )
      }
      event.sender.startDrag({
        file: imagePath,
        icon: thumbnail,
      })
    },

    // Detach the main window's DevTools window.
    openDevTools: () => {
      deps.getWin()?.webContents.openDevTools({ mode: 'detach', activate: true })
    },

    // Flip the Pi harness's verbose agent log switch.
    setVerboseAgentLogging: (_event, enabled) => {
      deps.setVerboseAgentLogging(enabled)
    },

    // Open an external URL in the OS browser.
    openUrl: (_event, url) => {
      return shell.openExternal(url)
    },

    // Minimize the main window.
    miniWindow: () => {
      const win = deps.getWin()
      if (win) {
        win.minimize()
      }
    },

    // Quit outright instead of closing the window and hoping that cascades into a
    // quit: `app.quit()` always reaches the gated teardown in `before-quit`.
    exitApp: async () => {
      app.quit()
    },

    // Save a generated image to a file the user picks in a save dialog.
    saveImage: async (event, url) => {
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
            deps.appLogger.info(`File downloaded and saved: ${result.filePath}`, 'electron-backend')
          } catch (error) {
            deps.appLogger.error(
              `Download and save error: ${JSON.stringify(error, Object.getOwnPropertyNames, 2)}`,
              'electron-backend',
            )
          }
        }
      } catch (error) {
        deps.appLogger.error(
          `${JSON.stringify(error, Object.getOwnPropertyNames, 2)}`,
          'electron-backend',
        )
      }
    },

    // Open a generated image in its own viewer window.
    openImageWin: (_event, url, title, width, height) => {
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
        parent: deps.getWin() || undefined,
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

    // Open a media URL's file with the OS default image viewer.
    openImageWithSystem: (_event, url) => {
      const imagePath = getAssetPathFromUrl(url, deps)
      if (!imagePath) return
      shell.openPath(imagePath)
    },

    // Reveal a media URL's file in the OS file manager.
    openImageInFolder: (_event, url) => {
      const imagePath = getAssetPathFromUrl(url, deps)
      if (!imagePath) return

      if (process.platform === 'win32') {
        // `execFile`, not `exec`: the path is passed as an argument rather than
        // spliced into a shell command line, so a media path containing a
        // quote or an `&` opens the folder instead of running as a command.
        execFile('explorer.exe', ['/select,', imagePath])
      } else {
        shell.showItemInFolder(imagePath)
      }
    },

    // Enter or leave full screen on the main window.
    setFullScreen: (_event, enable) => {
      const win = deps.getWin()
      if (win) {
        win.setFullScreen(enable)
      }
    },

    // Forward one serialized Laminar telemetry event to main's tracing half.
    laminarTelemetryEvent: (_event, name, payload) => {
      void deps.handleChatTelemetryEvent(name, payload)
    },
  } satisfies SendHandlerMap<CoreSendName>
}

/**
 * Resolve a media URL (aipg-media://, a ComfyUI view URL or a service URL) to
 * a local file path. Serves the core send listeners (drag start,
 * open-with-system, reveal-in-folder).
 */
export function getAssetPathFromUrl(
  url: string,
  deps: Pick<CoreDeps, 'mediaDir' | 'getLocalPathFromAipgMediaUrl' | 'getServiceRegistry'>,
) {
  // Handle aipg-media:// URLs
  if (url.startsWith('aipg-media://')) {
    return deps.getLocalPathFromAipgMediaUrl(url)
  }

  // Existing logic for HTTP URLs
  const imageUrl = URL.parse(url)
  if (!imageUrl) {
    console.error('Could not find image for URL', { url })
    return
  }

  const comfyBackendUrl = deps.getServiceRegistry()?.getService('comfyui-backend')?.baseUrl
  const backend = comfyBackendUrl && url.includes(comfyBackendUrl) ? 'comfyui' : 'service'

  const imageSubPath =
    backend === 'comfyui'
      ? path.join(
          imageUrl.searchParams.get('subfolder') ?? '',
          imageUrl.searchParams.get('filename') ?? '',
        )
      : imageUrl.pathname
  return path.join(deps.mediaDir, imageSubPath)
}
