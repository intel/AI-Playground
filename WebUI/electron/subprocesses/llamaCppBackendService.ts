import { exec, execFile, spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import * as filesystem from 'fs-extra'
import { app, net, type BrowserWindow } from 'electron'
import { appLoggerInstance } from '../logging/logger.ts'
import { createEnhancedErrorDetails, type ApiService, type ErrorDetails } from './service.ts'
import { vulkanDeviceSelectorEnv, withSelectedDevice } from './deviceDetection.ts'
import type { LocalSettings } from '../main.ts'
import getPort, { portNumbers } from 'get-port'
import { binary, extract } from './tools.ts'
import * as llamaCppPhison from './llamaCppPhison.ts'
import type { LlamaCppBuildVariant } from './llamaCppPhison.ts'

const execAsync = promisify(exec)

export const LLAMACPP_DEFAULT_PARAMETERS = '--gpu-layers 999 --log-prefix --jinja --no-mmap -fa off'
const platformExtension = process.platform === 'win32' ? 'zip' : 'tar.gz'
type StorageTarget = {
  id: string
  name: string
  path: string
  selected: boolean
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Sanitize the user-supplied LlamaCPP parameter string from settings so a
 * malicious or accidental value cannot widen the attack surface:
 *
 * - drop any `--host <addr>` / `--host=<addr>` whose address is not a loopback
 *   host (`127.0.0.1`, `localhost`, `::1`),
 * - drop any bare `--host` (which would consume the next token as the host),
 * - drop any flag value of `0.0.0.0`.
 *
 * The caller is expected to also append a trailing `--host 127.0.0.1` so even
 * a future llama-server default change cannot expose the port.
 */
export function sanitizeUserLlamaCppParameters(
  raw: string,
  warn?: (msg: string) => void,
): string[] {
  const tokens = raw.split(/\s+/).filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith('--host=')) {
      const value = t.slice('--host='.length)
      if (!LOOPBACK_HOSTS.has(value)) {
        warn?.(`Refusing user-supplied --host=${value}; only loopback addresses are allowed`)
        continue
      }
      out.push(t)
      continue
    }
    if (t === '--host') {
      const value = tokens[i + 1]
      if (value === undefined || value.startsWith('--')) {
        warn?.('Refusing bare --host; only loopback addresses are allowed')
        continue
      }
      if (!LOOPBACK_HOSTS.has(value)) {
        warn?.(`Refusing user-supplied --host ${value}; only loopback addresses are allowed`)
        i++
        continue
      }
      out.push(t, value)
      i++
      continue
    }
    if (t === '0.0.0.0' || t === '--host=0.0.0.0') {
      warn?.(`Refusing user-supplied non-loopback bind value: ${t}`)
      continue
    }
    out.push(t)
  }
  return out
}

interface LlamaServerProcess {
  process: ChildProcess
  port: number
  modelPath: string
  modelRepoId: string
  type: 'llm' | 'embedding'
  contextSize?: number
  isReady: boolean
}

const execFileAsync = promisify(execFile)

export class LlamaCppBackendService implements ApiService {
  readonly name = 'llama-cpp-backend' as BackendServiceName
  baseUrl: string
  port: number
  readonly isRequired: boolean = false
  readonly win: BrowserWindow
  readonly settings: LocalSettings

  // Service directories
  readonly baseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../../')
  readonly serviceDir: string
  readonly llamaCppSsdOffloadConfigPath: string
  devices: InferenceDevice[] = [{ id: '0', name: 'Auto select device', selected: true }]
  storageTargets: StorageTarget[] = []

  // Health endpoint
  healthEndpointUrl: string

  // Status tracking
  currentStatus: BackendStatus = 'uninitializedStatus'
  isSetUp: boolean = false
  desiredStatus: BackendStatus = 'uninitializedStatus'

  // Model server processes
  private llamaLlmProcess: LlamaServerProcess | null = null
  private llamaEmbeddingProcess: LlamaServerProcess | null = null
  private currentLlmModel: string | null = null
  private currentContextSize: number | null = null
  private currentEmbeddingModel: string | null = null

  // Store last startup error details for persistence
  private lastStartupErrorDetails: ErrorDetails | null = null

  // Cached installed version for inclusion in service info updates (active variant)
  private cachedInstalledVersion: { version: string; releaseTag?: string } | undefined = undefined
  /** Standard-tree llama-cpp/ — independent of active variant (UI shows both rows). */
  private cachedStandardInstallVersion: { version: string; releaseTag?: string } | undefined =
    undefined
  /** Phison-tree llama-cpp-phison/ */
  private cachedPhisonInstallVersion: { version: string; releaseTag?: string } | undefined =
    undefined

  // Logger
  readonly appLogger = appLoggerInstance

  private version = 'b7278'

  private llamaCppParametersString: string = LLAMACPP_DEFAULT_PARAMETERS
  private llamaCppBuildVariant: LlamaCppBuildVariant = 'standard'
  private llamaCppOffloadDrive: string | null = null

  updatePort(newPort: number) {
    this.port = newPort
    this.baseUrl = `http://127.0.0.1:${newPort}`
    this.healthEndpointUrl = `${this.baseUrl}/health`
  }

  private llamaCppDirForVariant(variant: LlamaCppBuildVariant): string {
    return llamaCppPhison.getLlamaCppDirForVariant(this.serviceDir, variant)
  }

  /** Directory for the currently selected build variant (standard vs Phison use separate trees). */
  private getActiveLlamaCppDir(): string {
    return this.llamaCppDirForVariant(this.llamaCppBuildVariant)
  }

  private getActiveLlamaCppExePath(): string {
    return llamaCppPhison.getActiveLlamaCppExePath(this.serviceDir, this.llamaCppBuildVariant)
  }

  private getZipPathForVariant(variant: LlamaCppBuildVariant): string {
    return llamaCppPhison.getZipPathForVariant(this.serviceDir, variant, platformExtension)
  }

  constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
    this.name = name
    this.port = port
    this.win = win
    this.settings = settings
    this.baseUrl = `http://127.0.0.1:${port}`
    this.healthEndpointUrl = `${this.baseUrl}/health`

    // Set up paths (binaries live under getActiveLlamaCppDir() — standard vs Phison use different folders)
    this.serviceDir = path.resolve(path.join(this.baseDir, 'LlamaCPP'))
    this.llamaCppSsdOffloadConfigPath = llamaCppPhison.getSsdOffloadConfigPath(this.serviceDir)
    this.migrateLegacySsdOffloadConfigFile()
    this.ensureSsdOffloadConfigFileSync()
    this.migrateLegacyPhisonIntoSeparateDirectory()

    this.syncSetupFlagsFromDisk()
    this.appLogger.info(`Service ${this.name} isSetUp: ${this.isSetUp}`, this.name)

    this.detectStorageTargets()
      .then(() => {
        this.updateStatus()
      })
      .catch((error) => {
        this.appLogger.warn(`Failed to detect storage targets on startup: ${error}`, this.name)
      })
  }

  async ensureBackendReadiness(
    llmModelName: string,
    embeddingModelName?: string,
    contextSize?: number,
  ): Promise<void> {
    this.appLogger.info(
      `Ensuring LlamaCPP backend readiness for LLM: ${llmModelName}, Embedding: ${embeddingModelName ?? 'none'}, Context: ${contextSize ?? 'default'}`,
      this.name,
    )

    try {
      // Handle LLM model
      // A running server is only ever torn down by its `exit` handler, so a
      // process that wedged without exiting (GPU stall, hung worker) would keep
      // its stale `isReady === true` and we'd route requests at a dead server
      // forever. Re-probe `/health` so an unresponsive-but-alive server is
      // treated as needing a relaunch, not reused.
      const llmServerResponsive = await this.isLlmServerResponsive()
      const needsLlmRestart =
        this.currentLlmModel !== llmModelName ||
        (contextSize && contextSize !== this.currentContextSize) ||
        !llmServerResponsive

      if (needsLlmRestart) {
        await this.stopLlamaLlmServer()
        await this.startLlamaLlmServer(llmModelName, contextSize)
        this.appLogger.info(`LLM server ready with model: ${llmModelName}`, this.name)
      } else {
        this.appLogger.info(`LLM server already running with model: ${llmModelName}`, this.name)
      }

      // Handle embedding model if provided
      if (embeddingModelName) {
        const needsEmbeddingRestart =
          this.currentEmbeddingModel !== embeddingModelName || !this.llamaEmbeddingProcess?.isReady

        if (needsEmbeddingRestart) {
          await this.stopLlamaEmbeddingServer()
          await this.startLlamaEmbeddingServer(embeddingModelName)
          this.appLogger.info(`Embedding server ready with model: ${embeddingModelName}`, this.name)
        } else {
          this.appLogger.info(
            `Embedding server already running with model: ${embeddingModelName}`,
            this.name,
          )
        }
      }

      this.appLogger.info(
        `LlamaCPP backend fully ready - LLM: ${llmModelName}, Embedding: ${embeddingModelName ?? 'none'}`,
        this.name,
      )

      // we still need to communicate status 'running' to backendServices and UI
      this.start()
    } catch (error) {
      this.appLogger.error(
        `Failed to ensure backend readiness - LLM: ${llmModelName}, Embedding: ${embeddingModelName ?? 'none'}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  /**
   * Get the embedding server URL if an embedding server is running
   * @returns The embedding server base URL, or null if no embedding server is running
   */
  getEmbeddingServerUrl(): string | null {
    if (this.llamaEmbeddingProcess?.isReady) {
      return `http://127.0.0.1:${this.llamaEmbeddingProcess.port}`
    }
    return null
  }

  async selectDevice(deviceId: string): Promise<void> {
    if (!this.devices.find((d) => d.id === deviceId)) return
    this.devices = this.devices.map((d) => ({ ...d, selected: d.id === deviceId }))
    this.updateStatus()
  }

  /**
   * Bootstrap check used by apiServiceRegistry to decide whether to auto-start at app launch.
   * Main process has no persistence of the active variant, so it cold-starts with
   * `llamaCppBuildVariant === 'standard'`; the renderer pushes the persisted Phison variant only
   * after Pinia hydrates. To avoid skipping auto-start when the user has a Phison-only install,
   * consider the service "set up" if either variant's artifacts are on disk. The active-variant
   * spawn happens later in ensureBackendReadiness, by which time the renderer has synced settings.
   *
   * NOTE: distinct from `this.isSetUp` (UI-facing, variant-specific) on purpose.
   */
  serviceIsSetUp(): boolean {
    return this.computeStandardArtifactsReady() || this.computePhisonArtifactsReady()
  }

  /**
   * Setup depends on the active variant directory. Standard and Phison installs are separate trees
   * under LlamaCPP/ so switching variants does not delete the other build.
   */
  private computeStandardArtifactsReady(): boolean {
    return llamaCppPhison.computeStandardArtifactsReady(this.serviceDir)
  }

  private computePhisonArtifactsReady(): boolean {
    return llamaCppPhison.computePhisonArtifactsReady(this.serviceDir)
  }

  private computeIsSetUp(): boolean {
    return llamaCppPhison.computeVariantArtifactsReady(this.serviceDir, this.llamaCppBuildVariant)
  }

  private syncSetupFlagsFromDisk(): void {
    const wasSetUp = this.isSetUp
    this.isSetUp = this.computeIsSetUp()
    if (!this.isSetUp) {
      if (
        wasSetUp &&
        this.currentStatus !== 'installing' &&
        this.currentStatus !== 'running' &&
        this.currentStatus !== 'starting'
      ) {
        this.currentStatus = 'notInstalled'
      }
    } else {
      if (
        !wasSetUp &&
        (this.currentStatus === 'notInstalled' || this.currentStatus === 'uninitializedStatus')
      ) {
        this.currentStatus = 'notYetStarted'
      }
    }
    if (this.currentStatus === 'uninitializedStatus') {
      this.currentStatus = 'notInstalled'
    }
    void this.refreshDualVariantVersionCaches().then(() => this.updateStatus())
  }

  async detectDevices() {
    try {
      await this.detectStorageTargets()

      // Check if llama-server.exe exists
      if (!filesystem.existsSync(this.getActiveLlamaCppExePath())) {
        this.appLogger.warn('llama-server.exe not found, using default device', this.name)
        this.devices = [{ id: '0', name: 'Auto select device', selected: true }]
        return
      }

      this.appLogger.info('Detecting devices using llama-server --list-devices', this.name)

      const { stdout, stderr } = await execAsync(
        `"${this.getActiveLlamaCppExePath()}" --list-devices`,
        {
          cwd: this.getActiveLlamaCppDir(),
          env: {
            ...process.env,
          },
          timeout: 10000, // 10 second timeout
        },
      )

      const availableDevices: Array<{ id: string; name: string }> = []
      // Phison's llama-server fork (and recent upstream builds) write "Available devices:" + entries
      // to stderr, not stdout. Parse both streams so detection is robust across build flavors.
      // Device entries always end with a memory tuple like `(<N> MiB, <N> MiB free)` — log lines
      // emitted on stderr after the header (`build:`, `load_backend:`, etc.) don't, so use that
      // as the device-row discriminator. Works across Vulkan / CUDA / SYCL / HIP / MTL / BLAS / etc.
      const lines = `${stdout}\n${stderr}`
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')

      let foundDevicesSection = false
      for (const line of lines) {
        if (line.startsWith('Available devices:')) {
          foundDevicesSection = true
          continue
        }

        if (foundDevicesSection && line.includes(':')) {
          const colonIndex = line.indexOf(':')
          if (colonIndex <= 0) continue

          const deviceInfo = line.substring(colonIndex + 1).trim()
          const lastParenIndex = deviceInfo.lastIndexOf('(')
          if (lastParenIndex <= 0) continue
          const memoryInfo = deviceInfo.substring(lastParenIndex)
          if (
            !memoryInfo.includes('MiB') &&
            !memoryInfo.includes('GiB') &&
            !memoryInfo.includes('free')
          ) {
            continue
          }

          let deviceId = line.substring(0, colonIndex).trim()
          // Strip the alpha backend prefix when followed by a numeric suffix so id stays consistent
          // with the prior Vulkan-only behavior (`Vulkan0` → `0`, `MTL0` → `0`, `CUDA0` → `0`).
          // Backends without a numeric suffix (e.g. `BLAS`) keep their id as-is.
          const numericSuffixMatch = deviceId.match(/(\d+)$/)
          if (numericSuffixMatch && /^[A-Za-z]+\d+$/.test(deviceId)) {
            deviceId = numericSuffixMatch[1]
          }

          const deviceName = deviceInfo.substring(0, lastParenIndex).trim()
          availableDevices.push({ id: deviceId, name: deviceName })
        }
      }

      this.appLogger.info(
        `detected devices: ${JSON.stringify(availableDevices, null, 2)}`,
        this.name,
      )

      this.devices = withSelectedDevice(
        availableDevices.map((d) => ({ ...d, selected: false })),
        this.settings.lastSelectedDevicePerBackend[this.name],
        (ds) => ds[0],
      )
    } catch (error) {
      this.appLogger.error(`Failed to detect devices: ${error}`, this.name)
      this.devices = [{ id: '0', name: 'Auto select device', selected: true }]
    }
    this.updateStatus()
  }

  get_info(): ApiServiceInformation {
    if (this.currentStatus === 'uninitializedStatus') {
      this.currentStatus = this.isSetUp ? 'notYetStarted' : 'notInstalled'
    }
    return {
      serviceName: this.name,
      status: this.currentStatus,
      baseUrl: this.baseUrl,
      port: this.port,
      isSetUp: this.isSetUp,
      isRequired: this.isRequired,
      devices: this.devices,
      storageTargets: this.storageTargets,
      llamaCppSsdOffloadConfigPath: this.getRelativeSsdOffloadConfigPath(),
      errorDetails: this.lastStartupErrorDetails,
      installedVersion: this.cachedInstalledVersion,
      llamaCppStandardArtifactReady: this.computeStandardArtifactsReady(),
      llamaCppPhisonArtifactReady: this.computePhisonArtifactsReady(),
      llamaCppStandardInstalledVersion: this.cachedStandardInstallVersion,
      llamaCppPhisonInstalledVersion: this.cachedPhisonInstallVersion,
    }
  }

  setStatus(status: BackendStatus) {
    this.currentStatus = status
    this.updateStatus()
  }

  updateStatus() {
    this.win.webContents.send('serviceInfoUpdate', this.get_info())
  }

  async updateSettings(settings: ServiceSettings): Promise<void> {
    if (settings.version) {
      this.version = settings.version
      this.appLogger.info(`applied new LlamaCPP version ${this.version}`, this.name)
    }
    if (typeof settings.llamaCppParameters === 'string') {
      this.llamaCppParametersString = settings.llamaCppParameters
      this.appLogger.info(
        `applied new LlamaCPP startup parameters: ${this.llamaCppParametersString}`,
        this.name,
      )
    }
    if (
      settings.llamaCppBuildVariant === 'standard' ||
      settings.llamaCppBuildVariant === 'ssd-offload'
    ) {
      const variantChanged = this.llamaCppBuildVariant !== settings.llamaCppBuildVariant
      this.llamaCppBuildVariant = settings.llamaCppBuildVariant
      this.appLogger.info(
        `applied new LlamaCPP build variant: ${this.llamaCppBuildVariant}`,
        this.name,
      )
      // The standard and ssd-offload variants live in different binary trees
      // (`getActiveLlamaCppDir()` resolves them per-variant). If a server is
      // already running, it is still using the previous variant's executable —
      // tear it down so the next `ensureBackendReadiness` call boots the new
      // binary instead of silently keeping the old one alive.
      if (variantChanged) {
        await this.stopLlamaLlmServer()
        await this.stopLlamaEmbeddingServer()
      }
    }
    if (
      typeof settings.llamaCppOffloadDrive === 'string' ||
      settings.llamaCppOffloadDrive === null
    ) {
      this.llamaCppOffloadDrive = this.normalizeOffloadDrivePath(settings.llamaCppOffloadDrive)
      this.storageTargets = this.storageTargets.map((target) => ({
        ...target,
        selected: target.path === this.llamaCppOffloadDrive,
      }))
      this.appLogger.info(
        `applied new LlamaCPP SSD offload drive: ${this.llamaCppOffloadDrive ?? 'none'}`,
        this.name,
      )
      await this.updateSsdOffloadConfig()
    }
    this.syncSetupFlagsFromDisk()
  }

  async getInstalledVersion(): Promise<{ version?: string; releaseTag?: string } | undefined> {
    if (!this.isSetUp) return undefined
    return this.probeInstalledVersionInDir(this.getActiveLlamaCppDir())
  }

  private async probeInstalledVersionInDir(
    binDir: string,
  ): Promise<{ version: string; releaseTag?: string } | undefined> {
    const exe = path.join(binDir, binary('llama-server'))
    if (!filesystem.existsSync(exe)) return undefined
    try {
      const result = await execAsync(`"${exe}" --version`, {
        cwd: binDir,
        env: {
          ...process.env,
        },
        timeout: 10000,
      })
      const versionMatch = result.stderr.match(/version:\s*(\d+)\s*\([^)]+\)/m)
      this.appLogger.info(
        `probeInstalledVersionInDir: ${result.stdout}, ${result.stderr}, ${versionMatch}`,
        this.name,
      )
      if (versionMatch && versionMatch[1]) {
        return { version: `b${versionMatch[1]}` }
      }
    } catch (e) {
      this.appLogger.warn(`probeInstalledVersionInDir failed: ${e}`, this.name)
    }
    return undefined
  }

  /** Refreshes per-directory version caches and `cachedInstalledVersion` for the active variant. */
  private async refreshDualVariantVersionCaches(): Promise<void> {
    try {
      const standardVer = this.computeStandardArtifactsReady()
        ? await this.probeInstalledVersionInDir(this.llamaCppDirForVariant('standard'))
        : undefined
      this.cachedStandardInstallVersion =
        standardVer?.version !== undefined
          ? {
              version: standardVer.version,
              ...(standardVer.releaseTag && { releaseTag: standardVer.releaseTag }),
            }
          : undefined

      const phisonVer = this.computePhisonArtifactsReady()
        ? await this.probeInstalledVersionInDir(this.llamaCppDirForVariant('ssd-offload'))
        : undefined
      this.cachedPhisonInstallVersion =
        phisonVer?.version !== undefined
          ? {
              version: phisonVer.version,
              ...(phisonVer.releaseTag && { releaseTag: phisonVer.releaseTag }),
            }
          : undefined

      this.cachedInstalledVersion =
        this.llamaCppBuildVariant === 'ssd-offload'
          ? this.cachedPhisonInstallVersion
          : this.cachedStandardInstallVersion
    } catch (error) {
      this.appLogger.warn(`refreshDualVariantVersionCaches: ${error}`, this.name)
      this.cachedStandardInstallVersion = undefined
      this.cachedPhisonInstallVersion = undefined
      this.cachedInstalledVersion = undefined
    }
  }

  async *set_up(): AsyncIterable<SetupProgress> {
    this.setStatus('installing')
    this.appLogger.info('setting up service', this.name)

    let currentStep = 'start'

    try {
      currentStep = 'start'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'starting to set up LlamaCPP service',
      }

      // Create service directory if it doesn't exist
      if (!filesystem.existsSync(this.serviceDir)) {
        filesystem.mkdirSync(this.serviceDir, { recursive: true })
      }
      await this.ensureSsdOffloadConfigFile()

      currentStep = 'download'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `downloading LlamaCPP`,
      }

      await this.downloadLlamacpp()

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'download complete',
      }

      // Extract Llamacpp ZIP file
      currentStep = 'extract'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'extracting LlamaCPP',
      }

      await this.extractLlamacpp()
      await this.ensureSsdOffloadConfigFile()

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'extraction complete',
      }

      if (this.llamaCppBuildVariant === 'ssd-offload') {
        currentStep = 'configure-service'
        yield {
          serviceName: this.name,
          step: currentStep,
          status: 'executing',
          debugMessage: 'requesting permission to configure SSD offload Windows service',
        }

        await this.ensureSsdOffloadWindowsService()

        yield {
          serviceName: this.name,
          step: currentStep,
          status: 'executing',
          debugMessage: 'SSD offload Windows service configured',
        }
      }

      await this.updateSsdOffloadConfig()
      this.syncSetupFlagsFromDisk()
      this.setStatus('notYetStarted')

      currentStep = 'end'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'success',
        debugMessage: 'service set up completely',
      }
    } catch (e) {
      this.appLogger.warn(`Set up of service failed due to ${e}`, this.name, true)
      this.setStatus('installationFailed')

      const errorDetails = await createEnhancedErrorDetails(e, `${currentStep} operation`)

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'failed',
        debugMessage: `Failed to setup LlamaCPP service due to ${e}`,
        errorDetails,
      }
    }
  }

  private async downloadLlamacpp(): Promise<void> {
    const zipPath = this.getZipPathForVariant(this.llamaCppBuildVariant)
    const downloadUrl = this.resolveDownloadUrl()
    this.appLogger.info(`Downloading Llamacpp from ${downloadUrl}`, this.name)

    // Delete existing zip if it exists
    if (filesystem.existsSync(zipPath)) {
      this.appLogger.info(`Removing existing Llamacpp zip file`, this.name)
      filesystem.removeSync(zipPath)
    }

    // Using electron net for better proxy support
    const response = await net.fetch(downloadUrl)
    if (!response.ok || response.status !== 200 || !response.body) {
      throw new Error(`Failed to download Llamacpp: ${response.statusText}`)
    }

    const buffer = await response.arrayBuffer()
    await filesystem.writeFile(zipPath, Buffer.from(buffer))

    this.appLogger.info(`Llamacpp zip file downloaded successfully`, this.name)
  }

  private resolveDownloadUrl(): string {
    const platformArchMap: Record<string, string> = {
      darwin: 'macos-arm64',
      linux: 'ubuntu-x64',
      win32: 'win-vulkan-x64',
    }
    const platformArch = platformArchMap[process.platform] ?? 'win-vulkan-x64'
    return llamaCppPhison.resolveLlamaCppDownloadUrl(
      this.version,
      this.llamaCppBuildVariant,
      platformExtension,
      platformArch,
    )
  }

  private async extractLlamacpp(): Promise<void> {
    const zipPath = this.getZipPathForVariant(this.llamaCppBuildVariant)
    const targetDir = this.getActiveLlamaCppDir()
    this.appLogger.info(`Extracting LlamaCPP to ${targetDir}`, this.name)

    // Delete existing variant directory only (other variant folder is left intact).
    // Phison-only: stop Windows service scripts + ada.exe before removing llama-cpp-phison/.
    // Standard GGUF reinstall must not touch ada/Phison — same as pre–SSD-offload behavior.
    if (filesystem.existsSync(targetDir)) {
      if (this.llamaCppBuildVariant === 'ssd-offload') {
        await this.stopSsdOffloadArtifactsForCleanup()
      }
      this.appLogger.info(`Removing existing LlamaCPP directory`, this.name)
      await this.removeDirectoryWithRetries(targetDir)
    }

    filesystem.mkdirSync(targetDir, { recursive: true })

    try {
      await extract(zipPath, targetDir)
      const llamaServerBinary = binary('llama-server')
      if (!filesystem.existsSync(path.join(targetDir, llamaServerBinary))) {
        const sourceDir = this.findParentOfBinary(targetDir, llamaServerBinary)
        if (!sourceDir) {
          throw new Error(`Could not find ${llamaServerBinary} in extracted LlamaCPP archive`)
        }

        this.flattenExtractedArchive(sourceDir, targetDir)
      }

      this.appLogger.info(`LlamaCPP extracted successfully`, this.name)
    } catch (error) {
      this.appLogger.error(`Failed to extract LlamaCPP: ${error}`, this.name)
      throw error
    }
  }

  private findParentOfBinary(dir: string, binaryName: string): string | undefined {
    for (const entry of filesystem.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isFile() && entry.name === binaryName) return dir
      if (entry.isDirectory()) {
        const found = this.findParentOfBinary(fullPath, binaryName)
        if (found) return found
      }
    }
    return undefined
  }

  private flattenExtractedArchive(sourceDir: string, targetDir: string): void {
    if (path.resolve(sourceDir) === path.resolve(targetDir)) {
      return
    }

    for (const file of filesystem.readdirSync(sourceDir)) {
      const sourcePath = path.join(sourceDir, file)
      const targetPath = path.join(targetDir, file)

      if (path.resolve(sourcePath) === path.resolve(targetPath)) {
        continue
      }

      filesystem.moveSync(sourcePath, targetPath, { overwrite: true })
    }
  }

  private getRelativeSsdOffloadConfigPath(): string {
    return llamaCppPhison.getRelativeSsdOffloadConfigPath(
      this.serviceDir,
      this.llamaCppBuildVariant,
      this.llamaCppSsdOffloadConfigPath,
    )
  }

  private normalizeOffloadDrivePath(offloadDrive?: string | null): string | null {
    return llamaCppPhison.normalizeOffloadDrivePath(offloadDrive)
  }

  private async updateSsdOffloadConfig(): Promise<void> {
    await this.ensureSsdOffloadConfigFile()
    await llamaCppPhison.updateSsdOffloadConfig(
      this.llamaCppSsdOffloadConfigPath,
      this.llamaCppOffloadDrive,
      {
        info: (message) => this.appLogger.info(message, this.name),
        warn: (message) => this.appLogger.warn(message, this.name),
      },
    )
  }

  /**
   * Older builds extracted Phison into `llama-cpp/`. Move that tree to `llama-cpp-phison/` once so
   * standard GGUF can use `llama-cpp/` again without overwriting Phison.
   */
  private migrateLegacyPhisonIntoSeparateDirectory(): void {
    llamaCppPhison.migrateLegacyPhisonIntoSeparateDirectory(this.serviceDir, {
      info: (message) => this.appLogger.info(message, this.name),
      warn: (message) => this.appLogger.warn(message, this.name),
    })
  }

  private migrateLegacySsdOffloadConfigFile(): void {
    llamaCppPhison.migrateLegacySsdOffloadConfigFile(
      this.serviceDir,
      this.llamaCppSsdOffloadConfigPath,
    )
  }

  private ensureSsdOffloadConfigFileSync(): void {
    llamaCppPhison.ensureSsdOffloadConfigFileSync(
      this.serviceDir,
      this.llamaCppSsdOffloadConfigPath,
    )
  }

  private async ensureSsdOffloadConfigFile(): Promise<void> {
    await llamaCppPhison.ensureSsdOffloadConfigFile(
      this.serviceDir,
      this.llamaCppSsdOffloadConfigPath,
    )
  }

  private async ensureSsdOffloadWindowsService(): Promise<void> {
    if (process.platform !== 'win32' || this.llamaCppBuildVariant !== 'ssd-offload') {
      return
    }

    const activeDir = this.getActiveLlamaCppDir()
    const deleteScriptPath = path.join(
      activeDir,
      llamaCppPhison.LLAMACPP_SSD_OFFLOAD_DELETE_SERVICE_SCRIPT,
    )
    const createScriptPath = path.join(
      activeDir,
      llamaCppPhison.LLAMACPP_SSD_OFFLOAD_CREATE_SERVICE_SCRIPT,
    )

    for (const scriptPath of [deleteScriptPath, createScriptPath]) {
      if (!filesystem.existsSync(scriptPath)) {
        throw new Error(`Required SSD offload setup script not found: ${scriptPath}`)
      }
    }

    // Run the delete + create service scripts inside a single elevated session so the user
    // only sees one UAC prompt for the whole configure step instead of one prompt per script.
    await this.runElevatedBatch(
      [`call "${deleteScriptPath}"`, `call "${createScriptPath}"`],
      activeDir,
    )
  }

  private async stopSsdOffloadArtifactsForCleanup(): Promise<void> {
    if (process.platform !== 'win32') {
      return
    }

    const activeDir = this.getActiveLlamaCppDir()
    const deleteScriptPath = path.join(
      activeDir,
      llamaCppPhison.LLAMACPP_SSD_OFFLOAD_DELETE_SERVICE_SCRIPT,
    )

    // Batch the service teardown and the ada.exe kill into a single elevated session so the
    // user sees one UAC prompt rather than one for the delete script plus one for taskkill.
    const commands: string[] = []
    if (filesystem.existsSync(deleteScriptPath)) {
      commands.push(`call "${deleteScriptPath}"`)
    }
    // taskkill returns a non-zero exit code when the process is not running; the batch script
    // intentionally runs every line (no early exit) so best-effort teardown always completes.
    commands.push(`taskkill /F /IM "${llamaCppPhison.LLAMACPP_SSD_OFFLOAD_PROCESS_NAME}" /T`)

    try {
      this.appLogger.info(
        `Stopping SSD offload Windows service and ${llamaCppPhison.LLAMACPP_SSD_OFFLOAD_PROCESS_NAME} before cleanup`,
        this.name,
      )
      await this.runElevatedBatch(commands, activeDir)
    } catch (error) {
      this.appLogger.warn(
        `Failed to stop SSD offload artifacts before cleanup: ${error}`,
        this.name,
      )
    }
  }

  /**
   * Runs one or more shell commands inside a single elevated (UAC) session.
   *
   * All steps are written to a temporary `.cmd` script launched once via
   * `Start-Process -Verb RunAs -Wait`, so a multi-step elevated operation triggers a single
   * UAC prompt instead of one prompt per step. Individual command failures do not abort the
   * batch — the script runs every line so best-effort teardown steps (e.g. `taskkill` when
   * nothing is running) cannot block the remaining work.
   */
  private async runElevatedBatch(commands: string[], workingDirectory: string): Promise<void> {
    const steps = commands.filter((command) => command.trim().length > 0)
    if (steps.length === 0) {
      return
    }

    this.appLogger.info(
      `Running ${steps.length} elevated command(s) in a single UAC prompt`,
      this.name,
    )

    const scriptPath = path.join(os.tmpdir(), `aipg-phison-elevated-${Date.now()}.cmd`)
    const scriptBody = ['@echo off', ...steps].join('\r\n')
    await filesystem.writeFile(scriptPath, scriptBody, 'utf8')

    const escapedScriptPath = scriptPath.replaceAll("'", "''")
    const escapedWorkingDirectory = workingDirectory.replaceAll("'", "''")
    const powershellArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process -FilePath '${escapedScriptPath}' -WorkingDirectory '${escapedWorkingDirectory}' -Verb RunAs -Wait`,
    ]

    try {
      const { stdout, stderr } = await execFileAsync('powershell.exe', powershellArgs, {
        windowsHide: true,
      })

      if (stdout) {
        this.appLogger.info(stdout, this.name)
      }
      if (stderr) {
        this.appLogger.warn(stderr, this.name)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to run elevated batch: ${message}`)
    } finally {
      try {
        await filesystem.remove(scriptPath)
      } catch (cleanupError) {
        this.appLogger.warn(
          `Failed to remove temporary elevated script ${scriptPath}: ${cleanupError}`,
          this.name,
        )
      }
    }
  }

  private async removeDirectoryWithRetries(targetDir: string): Promise<void> {
    const maxAttempts = 5

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        filesystem.removeSync(targetDir)
        return
      } catch (error) {
        if (attempt === maxAttempts) {
          throw error
        }

        const message = error instanceof Error ? error.message : String(error)
        this.appLogger.warn(
          `Failed to remove ${targetDir} on attempt ${attempt}/${maxAttempts}: ${message}`,
          this.name,
        )
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }

  async start(): Promise<BackendStatus> {
    // In this architecture, model servers are started on-demand via ensureBackendReadiness
    // This method is kept for ApiService interface compatibility
    if (this.currentStatus === 'running') {
      this.clearLastStartupError()
      return 'running'
    }

    this.appLogger.info(
      `${this.name} service ready - model servers will start on-demand`,
      this.name,
    )
    this.desiredStatus = 'running'
    this.currentStatus = 'running'
    this.clearLastStartupError()
    this.updateStatus()
    return 'running'
  }

  async stop(): Promise<BackendStatus> {
    this.appLogger.info(
      `Stopping backend ${this.name}. It was in state ${this.currentStatus}`,
      this.name,
    )
    this.desiredStatus = 'stopped'
    this.setStatus('stopping')

    // Stop all model servers
    await this.stopLlamaLlmServer()
    await this.stopLlamaEmbeddingServer()

    this.setStatus('stopped')
    return 'stopped'
  }

  /** Env only for on-demand llama-server processes (LLM / embedding). Phison build uses GGML_VK_DISABLE_F16. */
  private llamaModelServerEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...vulkanDeviceSelectorEnv(this.devices.find((d) => d.selected)?.id),
      ...llamaCppPhison.getModelServerEnvAdditions(this.llamaCppBuildVariant),
    }
  }

  /**
   * Liveness probe for the currently-tracked LLM server. Returns false when no
   * server is tracked, the process has died, or `/health` does not answer within
   * a short timeout (wedged/hung server). llama-server's `/health` is a trivial
   * handler that stays responsive even mid-generation, so a short timeout will
   * not produce false negatives for a merely-busy server.
   */
  private async isLlmServerResponsive(): Promise<boolean> {
    const proc = this.llamaLlmProcess
    if (!proc?.isReady || proc.process.killed) {
      return false
    }
    try {
      const response = await fetch(`http://127.0.0.1:${proc.port}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      })
      return response.ok
    } catch {
      this.appLogger.warn(
        `LLM server on port ${proc.port} failed health probe; will relaunch`,
        this.name,
      )
      return false
    }
  }

  // Model server management methods
  private async startLlamaLlmServer(
    modelRepoId: string,
    contextSize?: number,
  ): Promise<LlamaServerProcess> {
    try {
      const modelPath = this.resolveModelPath(modelRepoId)

      const port = await getPort({ port: portNumbers(39100, 39199) })
      this.updatePort(port)
      this.updateStatus()
      const ctxSize = contextSize ?? 8192

      this.appLogger.info(
        `Starting LLM server for model: ${modelRepoId} on port ${port} with context size ${ctxSize}`,
        this.name,
      )

      const userParameters = sanitizeUserLlamaCppParameters(this.llamaCppParametersString, (msg) =>
        this.appLogger.warn(msg, this.name, true),
      )
      const args = [
        '--model',
        modelPath,
        '--port',
        port.toString(),
        '--ctx-size',
        ctxSize.toString(),
        ...userParameters,
        // Force-append --host AFTER user params so we always win, even if
        // the user tried to inject their own --host. Defense in depth on
        // top of llama-server's documented default (127.0.0.1).
        '--host',
        '127.0.0.1',
      ]

      const modelFolder = path.dirname(modelPath)
      // find mmproj*.gguf file in the same folder
      const files = await filesystem.readdir(modelFolder)
      const mmprojFiles = files.filter(
        (file) => file.startsWith('mmproj') && file.endsWith('.gguf'),
      )
      const mmprojFile = mmprojFiles.at(0)
      if (mmprojFile) {
        const mmprojPath = path.join(modelFolder, mmprojFile)
        args.push('--mmproj', mmprojPath)
        this.appLogger.info(`Using mmproj file ${mmprojFile} for model ${modelRepoId}`, this.name)
      }

      const childProcess = spawn(this.getActiveLlamaCppExePath(), args, {
        cwd: this.getActiveLlamaCppDir(),
        windowsHide: true,
        env: this.llamaModelServerEnv(),
      })

      const llamaProcess: LlamaServerProcess = {
        process: childProcess,
        port,
        modelPath,
        modelRepoId,
        type: 'llm',
        contextSize: ctxSize,
        isReady: false,
      }

      // Track startup failures so we can surface an actionable error to the
      // user instead of silently waiting out the full health-check timeout.
      // The most common failure is the GPU running out of memory for the
      // requested context size (KV cache + compute buffers), which makes
      // llama-server abort during init.
      let memoryFailureDetected = false
      let processExited = false
      let exitCode: number | null = null

      const memoryFailureMarkers = [
        'failed to allocate',
        'out of memory',
        'cannot meet free memory target',
        'failed to create context',
      ]
      const scanForMemoryFailure = (msg: string) => {
        const lower = msg.toLowerCase()
        if (memoryFailureMarkers.some((marker) => lower.includes(marker))) {
          memoryFailureDetected = true
        }
      }

      const handleServerOutput = (message: Buffer | string) => {
        const msg = message.toString()
        // Once a failure is detected the flag never flips back, so there's no
        // need to keep scanning the (high-volume) startup output.
        if (!memoryFailureDetected) {
          scanForMemoryFailure(msg)
        }
        if (msg.startsWith('I ')) {
          this.appLogger.info(`[LLM] ${message}`, this.name)
        } else if (msg.startsWith('W ')) {
          this.appLogger.warn(`[LLM] ${message}`, this.name)
        } else if (msg.startsWith('E ')) {
          this.appLogger.error(`[LLM] ${message}`, this.name)
        }
      }

      // Returns an actionable error message if the server has failed to start,
      // otherwise null. Consumed by waitForServerReady to abort the wait early.
      const getStartupError = (): string | null => {
        if (memoryFailureDetected) {
          return `Model failed to load: not enough memory to run "${modelRepoId}" with a context size of ${ctxSize}. Try reducing the context size and load the model again.`
        }
        if (processExited) {
          return `Model failed to load: the server for "${modelRepoId}" exited unexpectedly (code ${exitCode}). This is often caused by running out of memory — try reducing the context size and load the model again.`
        }
        return null
      }

      // Set up process event handlers
      childProcess.stdout!.on('data', handleServerOutput)

      childProcess.stderr!.on('data', handleServerOutput)

      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`LLM server process error: ${error}`, this.name)
      })

      childProcess.on('exit', (code: number | null) => {
        this.appLogger.info(`LLM server process exited with code: ${code}`, this.name)
        processExited = true
        exitCode = code
        if (this.llamaLlmProcess === llamaProcess) {
          this.llamaLlmProcess = null
          this.currentLlmModel = null
          this.currentContextSize = null
        }
      })

      // Wait for server to be ready
      await this.waitForServerReady(
        `http://127.0.0.1:${port}/health`,
        childProcess,
        getStartupError,
      )
      llamaProcess.isReady = true

      this.llamaLlmProcess = llamaProcess
      this.currentLlmModel = modelRepoId
      this.currentContextSize = ctxSize

      this.appLogger.info(`LLM server ready for model: ${modelRepoId}`, this.name)
      return llamaProcess
    } catch (error) {
      this.appLogger.error(
        `Failed to start LLM server for model ${modelRepoId}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  private async startLlamaEmbeddingServer(modelRepoId: string): Promise<LlamaServerProcess> {
    try {
      const modelPath = this.resolveEmbeddingModelPath(modelRepoId)
      const port = await getPort({ port: portNumbers(39200, 39299) })

      this.appLogger.info(
        `Starting embedding server for model: ${modelRepoId} on port ${port}`,
        this.name,
      )

      const userParameters = sanitizeUserLlamaCppParameters(this.llamaCppParametersString, (msg) =>
        this.appLogger.warn(msg, this.name, true),
      )
      const args = [
        '--embedding',
        '--model',
        modelPath,
        '--port',
        port.toString(),
        '--log-prefix',
        '-b',
        '1024',
        '-ub',
        '1024',
        ...userParameters,
        // Force-append --host AFTER user params so we always win, even if
        // the user tried to inject their own --host. Defense in depth on
        // top of llama-server's documented default (127.0.0.1).
        '--host',
        '127.0.0.1',
      ]

      const childProcess = spawn(this.getActiveLlamaCppExePath(), args, {
        cwd: this.getActiveLlamaCppDir(),
        windowsHide: true,
        env: this.llamaModelServerEnv(),
      })

      const llamaProcess: LlamaServerProcess = {
        process: childProcess,
        port,
        modelPath,
        modelRepoId,
        type: 'embedding',
        isReady: false,
      }

      // Set up process event handlers
      childProcess.stdout!.on('data', (message) => {
        const msg = message.toString()
        if (msg.startsWith('I ')) {
          this.appLogger.info(`[Embedding] ${message}`, this.name)
        } else if (msg.startsWith('W ')) {
          this.appLogger.warn(`[Embedding] ${message}`, this.name)
        } else if (msg.startsWith('E ')) {
          this.appLogger.error(`[Embedding] ${message}`, this.name)
        }
      })

      childProcess.stderr!.on('data', (message) => {
        const msg = message.toString()
        if (msg.startsWith('I ')) {
          this.appLogger.info(`[Embedding] ${message}`, this.name)
        } else if (msg.startsWith('W ')) {
          this.appLogger.warn(`[Embedding] ${message}`, this.name)
        } else if (msg.startsWith('E ')) {
          this.appLogger.error(`[Embedding] ${message}`, this.name)
        }
      })

      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`Embedding server process error: ${error}`, this.name)
      })

      childProcess.on('exit', (code: number | null) => {
        this.appLogger.info(`Embedding server process exited with code: ${code}`, this.name)
        if (this.llamaEmbeddingProcess === llamaProcess) {
          this.llamaEmbeddingProcess = null
          this.currentEmbeddingModel = null
        }
      })

      // Wait for server to be ready
      await this.waitForServerReady(`http://127.0.0.1:${port}/health`, childProcess)
      llamaProcess.isReady = true

      this.llamaEmbeddingProcess = llamaProcess
      this.currentEmbeddingModel = modelRepoId

      this.appLogger.info(`Embedding server ready for model: ${modelRepoId}`, this.name)
      return llamaProcess
    } catch (error) {
      this.appLogger.error(
        `Failed to start embedding server for model ${modelRepoId}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  private async stopLlamaLlmServer(): Promise<void> {
    if (this.llamaLlmProcess) {
      this.appLogger.info(`Stopping LLM server for model: ${this.currentLlmModel}`, this.name)
      this.llamaLlmProcess.process.kill('SIGTERM')

      // Wait a bit for graceful shutdown, then force kill if needed
      await new Promise<void>((resolve) => {
        const currentProcess = this.llamaLlmProcess
        const timeout = setTimeout(() => {
          if (currentProcess) {
            this.appLogger.warn(`Force killing LLM server process`, this.name)
            currentProcess.process.kill('SIGKILL')
          }
          resolve()
        }, 5000)

        if (currentProcess) {
          currentProcess.process.on('exit', () => {
            clearTimeout(timeout)
            resolve()
          })
        } else {
          clearTimeout(timeout)
          resolve()
        }
      })

      this.llamaLlmProcess = null
      this.currentLlmModel = null
      this.currentContextSize = null
    }
  }

  private async stopLlamaEmbeddingServer(): Promise<void> {
    if (this.llamaEmbeddingProcess) {
      this.appLogger.info(
        `Stopping embedding server for model: ${this.currentEmbeddingModel}`,
        this.name,
      )
      this.llamaEmbeddingProcess.process.kill('SIGTERM')

      // Wait a bit for graceful shutdown, then force kill if needed
      await new Promise<void>((resolve) => {
        const currentProcess = this.llamaEmbeddingProcess
        const timeout = setTimeout(() => {
          if (currentProcess) {
            this.appLogger.warn(`Force killing embedding server process`, this.name)
            currentProcess.process.kill('SIGKILL')
          }
          resolve()
        }, 5000)

        if (currentProcess) {
          currentProcess.process.on('exit', () => {
            clearTimeout(timeout)
            resolve()
          })
        } else {
          clearTimeout(timeout)
          resolve()
        }
      })

      this.llamaEmbeddingProcess = null
      this.currentEmbeddingModel = null
    }
  }

  private resolveModelPath(modelRepoId: string): string {
    // Use the same logic as the Python backend
    const modelBasePath = 'models/LLM/ggufLLM'
    const [namespace, repo, ...model] = modelRepoId.split('/')
    const modelPath = path.resolve(
      path.join(this.baseDir, modelBasePath, `${namespace}---${repo}`, model.join('/')),
    )

    if (!filesystem.existsSync(modelPath)) {
      throw new Error(`Model file not found: ${modelPath}`)
    }

    return modelPath
  }

  private resolveEmbeddingModelPath(modelRepoId: string): string {
    // Use the same logic as resolveModelPath but with embedding model path
    const modelBasePath = 'models/LLM/embedding/llamaCPP'
    const [namespace, repo, ...model] = modelRepoId.split('/')
    const modelPath = path.resolve(
      path.join(this.baseDir, modelBasePath, `${namespace}---${repo}`, model.join('/')),
    )

    if (!filesystem.existsSync(modelPath)) {
      throw new Error(`Embedding model file not found: ${modelPath}`)
    }

    return modelPath
  }

  private async waitForServerReady(
    healthUrl: string,
    process: ChildProcess,
    getStartupError?: () => string | null,
  ): Promise<void> {
    const maxAttempts = this.llamaCppBuildVariant === 'ssd-offload' ? 500 : 120
    const delayMs = 1000

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Abort early with an actionable message if the server has reported a
      // fatal startup error (e.g. ran out of memory for the context size).
      const startupError = getStartupError?.()
      if (startupError) {
        this.appLogger.error(startupError, this.name)
        throw new Error(startupError)
      }

      // Check if process has exited before attempting health check
      if (!process || process.killed) {
        this.appLogger.warn(
          `Process for ${this.name} is not alive, aborting health check`,
          this.name,
        )
        throw new Error(`Process exited before server became ready`)
      }

      try {
        const response = await fetch(healthUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(1000),
        })

        if (response.ok) {
          // Double-check process is still alive before accepting success
          if (!process || process.killed) {
            this.appLogger.warn(
              `Process for ${this.name} exited after health check succeeded, marking as failed`,
              this.name,
            )
            throw new Error(`Process exited after health check succeeded`)
          }
          this.appLogger.info(`Server ready at ${healthUrl}`, this.name)
          return
        }
      } catch (_error) {
        // Server not ready yet, continue waiting
        // But check if process is still alive
        if (!process || process.killed) {
          this.appLogger.warn(`Process for ${this.name} exited during health check wait`, this.name)
          throw new Error(`Process exited during server startup`)
        }
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    throw new Error(`Server failed to start within ${(maxAttempts * delayMs) / 1000} seconds`)
  }

  private async detectStorageTargets(): Promise<void> {
    if (process.platform !== 'win32') {
      this.storageTargets = []
      return
    }

    try {
      const command =
        'powershell -NoProfile -Command "Get-Volume | Where-Object { $_.DriveLetter -and $_.DriveType -eq \'Fixed\' } | Select-Object DriveLetter, FileSystemLabel, FileSystem | ConvertTo-Json -Compress"'
      const { stdout } = await execAsync(command, {
        timeout: 10000,
      })
      const rawTargets = stdout.trim()
      if (!rawTargets) {
        this.storageTargets = []
        return
      }

      const parsedTargets = JSON.parse(rawTargets) as
        | Array<{ DriveLetter?: string; FileSystemLabel?: string; FileSystem?: string }>
        | { DriveLetter?: string; FileSystemLabel?: string; FileSystem?: string }
      const normalizedTargets = Array.isArray(parsedTargets) ? parsedTargets : [parsedTargets]

      this.storageTargets = normalizedTargets
        .filter((target) => typeof target.DriveLetter === 'string' && target.DriveLetter.length > 0)
        .map((target) => {
          const path = `${target.DriveLetter}:\\`
          const labelParts = [`${target.DriveLetter}:`]
          if (target.FileSystemLabel) {
            labelParts.push(target.FileSystemLabel)
          }
          if (target.FileSystem) {
            labelParts.push(`(${target.FileSystem})`)
          }

          return {
            id: path,
            name: labelParts.join(' '),
            path,
            selected: path === this.llamaCppOffloadDrive,
          }
        })
    } catch (error) {
      this.appLogger.warn(`Failed to detect storage targets: ${error}`, this.name)
      this.storageTargets = []
    }
  }

  // Error management methods for startup failures
  setLastStartupError(errorDetails: ErrorDetails): void {
    this.lastStartupErrorDetails = errorDetails
  }

  getLastStartupError(): ErrorDetails | null {
    return this.lastStartupErrorDetails
  }

  clearLastStartupError(): void {
    this.lastStartupErrorDetails = null
  }

  async uninstall(): Promise<void> {
    await this.stop()
    // Phison / ada.exe teardown uses elevated batch + taskkill — only when replacing SSD-offload.
    // Standard GGUF reinstall goes through uninstall()+set_up(); variant standard must not prompt UAC.
    if (this.llamaCppBuildVariant === 'ssd-offload') {
      await this.stopSsdOffloadArtifactsForCleanup()
    }
    this.appLogger.info(`removing LlamaCPP service directory`, this.name)
    await this.removeDirectoryWithRetries(this.serviceDir)
    this.appLogger.info(`removed LlamaCPP service directory`, this.name)
    this.setStatus('notInstalled')
    this.isSetUp = false
    // Clear startup errors when uninstalling
    this.clearLastStartupError()
  }
}
