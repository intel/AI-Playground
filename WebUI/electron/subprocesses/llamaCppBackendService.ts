import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import * as filesystem from 'fs-extra'
import { app, BrowserWindow, net } from 'electron'
import { appLoggerInstance } from '../logging/logger.ts'
import { ApiService, createEnhancedErrorDetails, ErrorDetails } from './service.ts'
import { promisify } from 'util'
import { exec } from 'child_process'
import { LocalSettings } from '../main.ts'
import getPort, { portNumbers } from 'get-port'
import { binary, extract } from './tools.ts'
import { detectNvidiaGpus, checkNvidiaDrivers, isNvidiaDevice } from './deviceNvidia.ts'
import type { GpuVendor } from './deviceUtils.ts'

const execAsync = promisify(exec)

interface LlamaServerProcess {
  process: ChildProcess
  port: number
  modelPath: string
  modelRepoId: string
  type: 'llm' | 'embedding'
  contextSize?: number
  isReady: boolean
}

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
  readonly llamaCppDir: string
  readonly llamaCppExePath: string

  readonly zipPath: string
  devices: InferenceDevice[] = [{ id: '0', name: 'Auto select device', selected: true }]

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

  // Cached installed version for inclusion in service info updates
  private cachedInstalledVersion: { version: string; releaseTag?: string } | undefined = undefined

  // Logger
  readonly appLogger = appLoggerInstance

  private version = 'b7278'

  updatePort(newPort: number) {
    this.port = newPort
    this.baseUrl = `http://127.0.0.1:${newPort}`
    this.healthEndpointUrl = `${this.baseUrl}/health`
  }

  constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
    this.name = name
    this.port = port
    this.win = win
    this.settings = settings
    this.baseUrl = `http://127.0.0.1:${port}`
    this.healthEndpointUrl = `${this.baseUrl}/health`

    // Set up paths
    this.serviceDir = path.resolve(path.join(this.baseDir, 'LlamaCPP'))
    this.llamaCppDir = path.resolve(path.join(this.serviceDir, 'llama-cpp'))
    this.llamaCppExePath = path.resolve(path.join(this.llamaCppDir, binary('llama-server')))
    this.zipPath = path.resolve(path.join(this.serviceDir, 'llama-cpp.zip'))

    // Check if already set up
    this.isSetUp = this.serviceIsSetUp()
    this.appLogger.info(`Service ${this.name} isSetUp: ${this.isSetUp}`, this.name)

    // Cache version on startup if already set up
    if (this.isSetUp) {
      this.updateCachedVersion().then(() => {
        this.updateStatus()
      })
    }
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

    // Check if the backend is installed before attempting to start
    if (!this.isSetUp || !this.serviceIsSetUp()) {
      const errorMsg =
        'LlamaCPP backend is not installed. Please install it first from the Settings page.'
      this.appLogger.error(errorMsg, this.name)
      throw new Error(errorMsg)
    }

    try {
      // Handle LLM model
      const needsLlmRestart =
        this.currentLlmModel !== llmModelName ||
        (contextSize && contextSize !== this.currentContextSize) ||
        !this.llamaLlmProcess?.isReady

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

  serviceIsSetUp(): boolean {
    return filesystem.existsSync(this.llamaCppExePath)
  }

  async detectDevices() {
    try {
      // Check if llama-server.exe exists
      if (!filesystem.existsSync(this.llamaCppExePath)) {
        this.appLogger.warn('llama-server.exe not found, using default device', this.name)
        this.devices = [{ id: 'cpu', name: 'CPU', selected: true }]
        return
      }

      this.appLogger.info('Detecting NVIDIA GPUs for CUDA build', this.name)

      // For CUDA build, detect NVIDIA GPUs using shared detection
      const availableDevices = await detectNvidiaGpus(this.name)

      this.appLogger.info(
        `detected devices: ${JSON.stringify(availableDevices, null, 2)}`,
        this.name,
      )

      // Add CPU device as an option (not default)
      const devicesWithCpu = [
        ...availableDevices.map((d, index) => ({
          ...d,
          selected: index === 0 && availableDevices.length > 0,
        })),
        { id: 'cpu', name: 'CPU', selected: false },
      ]

      // If no GPU devices found, select CPU by default
      if (availableDevices.length === 0) {
        devicesWithCpu[devicesWithCpu.length - 1].selected = true
      }

      this.devices = devicesWithCpu
    } catch (error) {
      this.appLogger.error(`Failed to detect devices: ${error}`, this.name)
      // Fallback to CPU device on error
      this.devices = [{ id: 'cpu', name: 'CPU', selected: true }]
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
      errorDetails: this.lastStartupErrorDetails,
      installedVersion: this.cachedInstalledVersion,
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
  }

  async getSettings(): Promise<ServiceSettings> {
    this.appLogger.info(`getting LlamaCPP settings`, this.name)
    return {
      version: this.version,
      serviceName: this.name,
    }
  }

  async getInstalledVersion(): Promise<{ version?: string; releaseTag?: string } | undefined> {
    if (!this.isSetUp) return undefined
    try {
      const result = await execAsync(`"${this.llamaCppExePath}" --version`, {
        cwd: this.llamaCppDir,
        env: {
          ...process.env,
        },
        timeout: 10000, // 10 second timeout
      })
      // Parse output like "version: 7278 (03d9a77b8)"
      const versionMatch = result.stderr.match(/version:\s*(\d+)\s*\([^)]+\)/m)
      this.appLogger.info(
        `getInstalledVersion: ${result.stdout}, ${result.stderr}, ${versionMatch}`,
        this.name,
      )
      if (versionMatch && versionMatch[1]) {
        return { version: `b${versionMatch[1]}` }
      }
    } catch (e) {
      this.appLogger.error(`failed to get installed LlamaCPP version: ${e}`, this.name)
    }
    return undefined
  }

  /**
   * Updates the cached installed version for inclusion in service info updates.
   */
  private async updateCachedVersion(): Promise<void> {
    try {
      const version = await this.getInstalledVersion()
      if (version && version.version) {
        this.cachedInstalledVersion = {
          version: version.version,
          ...(version.releaseTag && { releaseTag: version.releaseTag }),
        }
      } else {
        this.cachedInstalledVersion = undefined
      }
    } catch (error) {
      this.appLogger.warn(`Failed to get installed version: ${error}`, this.name)
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

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'extraction complete',
      }

      // Check and install Vulkan Runtime if missing (Windows only)
      if (process.platform === 'win32') {
        currentStep = 'vulkan'
        yield {
          serviceName: this.name,
          step: currentStep,
          status: 'executing',
          debugMessage: 'checking Vulkan Runtime',
        }

        const vulkanInstalled = await this.checkVulkanRuntime()
        if (!vulkanInstalled) {
          this.appLogger.info('Vulkan Runtime not found, installing...', this.name)
          yield {
            serviceName: this.name,
            step: currentStep,
            status: 'executing',
            debugMessage: 'downloading Vulkan Runtime',
          }

          await this.installVulkanRuntime()

          yield {
            serviceName: this.name,
            step: currentStep,
            status: 'executing',
            debugMessage: 'Vulkan Runtime installed successfully',
          }
        } else {
          this.appLogger.info('Vulkan Runtime already installed', this.name)
          yield {
            serviceName: this.name,
            step: currentStep,
            status: 'executing',
            debugMessage: 'Vulkan Runtime already installed',
          }
        }
      }

      this.isSetUp = true
      await this.updateCachedVersion()
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
    const platformArch = process.platform === 'darwin' ? 'macos-arm64' : 'win-vulkan-x64'
    const downloadUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${this.version}/llama-${this.version}-bin-${platformArch}.zip`
    this.appLogger.info(`Downloading Llamacpp from ${downloadUrl}`, this.name)

    // Delete existing zip if it exists
    if (filesystem.existsSync(this.zipPath)) {
      this.appLogger.info(`Removing existing Llamacpp zip file`, this.name)
      filesystem.removeSync(this.zipPath)
    }

    // Using electron net for better proxy support
    const response = await net.fetch(downloadUrl)
    if (!response.ok || response.status !== 200 || !response.body) {
      throw new Error(`Failed to download Llamacpp: ${response.statusText}`)
    }

    const buffer = await response.arrayBuffer()
    await filesystem.writeFile(this.zipPath, Buffer.from(buffer))

    this.appLogger.info(`Llamacpp zip file downloaded successfully`, this.name)
  }

  private async extractLlamacpp(): Promise<void> {
    this.appLogger.info(`Extracting LlamaCPP to ${this.llamaCppDir}`, this.name)

    // Delete existing llamacpp directory if it exists
    if (filesystem.existsSync(this.llamaCppDir)) {
      this.appLogger.info(`Removing existing LlamaCPP directory`, this.name)
      filesystem.removeSync(this.llamaCppDir)
    }

    // Create llamacpp directory
    filesystem.mkdirSync(this.llamaCppDir, { recursive: true })

    // Extract zip file using PowerShell's Expand-Archive
    try {
      await extract(this.zipPath, this.llamaCppDir)
      if (process.platform !== 'win32') {
        filesystem.readdirSync(path.join(this.llamaCppDir, 'build/bin')).forEach((file) => {
          filesystem.renameSync(
            path.join(this.llamaCppDir, 'build/bin', file),
            path.join(this.llamaCppDir, file),
          )
        })
      }

      this.appLogger.info(`LlamaCPP extracted successfully`, this.name)
    } catch (error) {
      this.appLogger.error(`Failed to extract LlamaCPP: ${error}`, this.name)
      throw error
    }
  }

  /**
   * Check if Vulkan Runtime is installed by looking for vulkan-1.dll
   */
  private async checkVulkanRuntime(): Promise<boolean> {
    try {
      // Check common locations for vulkan-1.dll
      const vulkanDllLocations = [
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'vulkan-1.dll'),
        path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64', 'vulkan-1.dll'),
      ]

      for (const location of vulkanDllLocations) {
        if (filesystem.existsSync(location)) {
          this.appLogger.info(`Found Vulkan Runtime at ${location}`, this.name)
          return true
        }
      }

      // Also try to run vulkaninfo to verify Vulkan is working
      try {
        const result = await execAsync('vulkaninfo --summary', { timeout: 5000 })
        if (result.stdout || result.stderr) {
          this.appLogger.info('Vulkan Runtime verified via vulkaninfo', this.name)
          return true
        }
      } catch {
        // vulkaninfo not found or failed, continue checking
      }

      this.appLogger.info('Vulkan Runtime not found on system', this.name)
      return false
    } catch (error) {
      this.appLogger.warn(`Error checking Vulkan Runtime: ${error}`, this.name)
      return false
    }
  }

  /**
   * Download and install Vulkan Runtime
   */
  private async installVulkanRuntime(): Promise<void> {
    try {
      // Use the Vulkan SDK Runtime installer
      // This is the redistributable runtime-only installer (not the full SDK)
      const vulkanVersion = '1.3.280.0' // Latest stable runtime version
      const vulkanInstallerUrl = `https://sdk.lunarg.com/sdk/download/${vulkanVersion}/windows/VulkanRT-${vulkanVersion}-Installer.exe`

      const vulkanInstallerPath = path.join(this.serviceDir, 'VulkanRT-Installer.exe')

      this.appLogger.info(`Downloading Vulkan Runtime from ${vulkanInstallerUrl}`, this.name)

      // Download the installer
      const response = await net.fetch(vulkanInstallerUrl)
      if (!response.ok || response.status !== 200 || !response.body) {
        throw new Error(`Failed to download Vulkan Runtime: ${response.statusText}`)
      }

      const buffer = await response.arrayBuffer()
      await filesystem.writeFile(vulkanInstallerPath, Buffer.from(buffer))

      this.appLogger.info(
        'Vulkan Runtime installer downloaded, running silent installation...',
        this.name,
      )

      // Run the installer silently
      // /S = silent mode, /D = install directory (optional)
      await execAsync(`"${vulkanInstallerPath}" /S`, {
        timeout: 120000, // 2 minute timeout for installation
      })

      this.appLogger.info('Vulkan Runtime installed successfully', this.name)

      // Clean up installer
      try {
        filesystem.removeSync(vulkanInstallerPath)
      } catch {
        // Ignore cleanup errors
      }
    } catch (error) {
      this.appLogger.error(`Failed to install Vulkan Runtime: ${error}`, this.name)
      this.appLogger.warn(
        'Vulkan Runtime installation failed. GPU acceleration may not work. You can manually install from: https://vulkan.lunarg.com/sdk/home',
        this.name,
      )
      // Don't throw - allow setup to continue, will fallback to CPU
    }
  }

  /**
   * Ensure GPU dependencies (CUDA for NVIDIA) are installed
   */
  private async ensureGpuDependencies(vendor: GpuVendor): Promise<void> {
    try {
      if (vendor === 'nvidia') {
        // CUDA build includes necessary runtime DLLs
        // Just verify NVIDIA GPU is present using shared utility
        this.appLogger.info('Using CUDA build - checking NVIDIA GPU availability', this.name)

        const driversAvailable = await checkNvidiaDrivers(this.name)
        if (!driversAvailable) {
          this.appLogger.warn(
            'nvidia-smi not found - ensure NVIDIA drivers are installed',
            this.name,
          )
        }
      }
    } catch (error) {
      this.appLogger.error(`Failed to verify GPU dependencies for ${vendor}: ${error}`, this.name)
      // Don't throw - allow execution to continue
      this.appLogger.warn(
        `GPU acceleration may not work optimally. Ensure NVIDIA drivers (525.x+) are installed.`,
        this.name,
      )
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

      // Check if we should use GPU or CPU
      const selectedDevice = this.devices.find((d) => d.selected)
      const useCpu = selectedDevice?.id === 'cpu'
      const useGpu = !useCpu && selectedDevice?.id !== undefined

      // Detect GPU vendor (NVIDIA and Intel supported)
      let gpuVendor: 'nvidia' | 'intel' | 'unknown' = 'unknown'
      if (useGpu && selectedDevice) {
        if (isNvidiaDevice(selectedDevice.name)) {
          gpuVendor = 'nvidia'
        } else if (
          selectedDevice.name.toLowerCase().includes('intel') ||
          selectedDevice.name.toLowerCase().includes('arc')
        ) {
          gpuVendor = 'intel'
        }
      }

      const args = [
        '--model',
        modelPath,
        '--port',
        port.toString(),
        '--ctx-size',
        ctxSize.toString(),
        '--log-prefix',
        '--jinja',
        '--verbose',
      ]

      if (useCpu) {
        args.push('--gpu-layers', '0')
        this.appLogger.info(`Using CPU mode (explicitly selected)`, this.name)
      } else if (useGpu) {
        args.push('--gpu-layers', '999')
        this.appLogger.info(
          `Using GPU acceleration with device: ${selectedDevice?.name} (${gpuVendor})`,
          this.name,
        )

        // For NVIDIA GPUs, ensure dependencies are checked
        if (gpuVendor === 'nvidia') {
          await this.ensureGpuDependencies(gpuVendor)
        }
      } else {
        // Fallback to CPU if no device selected
        args.push('--gpu-layers', '0')
        this.appLogger.warn(`No device selected, falling back to CPU mode`, this.name)
      }

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

      // Set CUDA_VISIBLE_DEVICES for GPU selection
      const envVars: Record<string, string> = { ...process.env }
      if (useGpu && selectedDevice && gpuVendor === 'nvidia') {
        envVars.CUDA_VISIBLE_DEVICES = selectedDevice.id
        this.appLogger.info(`Setting CUDA_VISIBLE_DEVICES=${selectedDevice.id}`, this.name)
      }

      const childProcess = spawn(this.llamaCppExePath, args, {
        cwd: this.llamaCppDir,
        windowsHide: true,
        env: envVars,
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

      // Set up process event handlers
      childProcess.stdout!.on('data', (message) => {
        const msg = message.toString()
        // Log ALL output for debugging
        if (msg.startsWith('I ')) {
          this.appLogger.info(`[LLM] ${msg}`, this.name)
        } else if (msg.startsWith('W ')) {
          this.appLogger.warn(`[LLM] ${msg}`, this.name)
        } else if (msg.startsWith('E ')) {
          this.appLogger.error(`[LLM] ${msg}`, this.name)
        } else {
          // Log unprefixed output (initialization messages, errors, etc.)
          this.appLogger.info(`[LLM stdout] ${msg}`, this.name)
        }
      })

      childProcess.stderr!.on('data', (message) => {
        const msg = message.toString()
        // Log ALL stderr output - this is where CUDA/Vulkan errors appear
        if (msg.startsWith('I ')) {
          this.appLogger.info(`[LLM] ${msg}`, this.name)
        } else if (msg.startsWith('W ')) {
          this.appLogger.warn(`[LLM] ${msg}`, this.name)
        } else if (msg.startsWith('E ')) {
          this.appLogger.error(`[LLM] ${msg}`, this.name)
        } else {
          // Log unprefixed stderr - critical for diagnosing CUDA/Vulkan issues
          this.appLogger.error(`[LLM stderr] ${msg}`, this.name)
        }
      })

      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`LLM server process error: ${error}`, this.name)
      })

      childProcess.on('exit', (code: number | null) => {
        this.appLogger.info(`LLM server process exited with code: ${code}`, this.name)
        if (this.llamaLlmProcess === llamaProcess) {
          this.llamaLlmProcess = null
          this.currentLlmModel = null
          this.currentContextSize = null
        }
      })

      // Wait for server to be ready
      await this.waitForServerReady(`http://127.0.0.1:${port}/health`, childProcess)
      llamaProcess.isReady = true

      this.llamaLlmProcess = llamaProcess
      this.currentLlmModel = modelRepoId
      this.currentContextSize = ctxSize

      this.appLogger.info(`LLM server ready for model: ${modelRepoId}`, this.name)
      return llamaProcess
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.appLogger.error(
        `Failed to start LLM server for model ${modelRepoId}: ${errorMessage}`,
        this.name,
      )
      // Don't fallback to CPU - throw the error so user knows GPU failed
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
        '--verbose', // Add verbose logging to capture initialization issues
      ]

      // Set CUDA_VISIBLE_DEVICES for GPU selection
      const selectedDevice = this.devices.find((d) => d.selected)
      const envVars: Record<string, string> = { ...process.env }
      if (selectedDevice && selectedDevice.id !== 'cpu') {
        envVars.CUDA_VISIBLE_DEVICES = selectedDevice.id
        this.appLogger.info(
          `[Embedding] Setting CUDA_VISIBLE_DEVICES=${selectedDevice.id}`,
          this.name,
        )
      }

      const childProcess = spawn(this.llamaCppExePath, args, {
        cwd: this.llamaCppDir,
        windowsHide: true,
        env: envVars,
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
        // Log ALL output for debugging
        if (msg.startsWith('I ')) {
          this.appLogger.info(`[Embedding] ${msg}`, this.name)
        } else if (msg.startsWith('W ')) {
          this.appLogger.warn(`[Embedding] ${msg}`, this.name)
        } else if (msg.startsWith('E ')) {
          this.appLogger.error(`[Embedding] ${msg}`, this.name)
        } else {
          // Log unprefixed output
          this.appLogger.info(`[Embedding stdout] ${msg}`, this.name)
        }
      })

      childProcess.stderr!.on('data', (message) => {
        const msg = message.toString()
        // Log ALL stderr output - critical for CUDA/Vulkan errors
        if (msg.startsWith('I ')) {
          this.appLogger.info(`[Embedding] ${msg}`, this.name)
        } else if (msg.startsWith('W ')) {
          this.appLogger.warn(`[Embedding] ${msg}`, this.name)
        } else if (msg.startsWith('E ')) {
          this.appLogger.error(`[Embedding] ${msg}`, this.name)
        } else {
          // Log unprefixed stderr
          this.appLogger.error(`[Embedding stderr] ${msg}`, this.name)
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

  private async waitForServerReady(healthUrl: string, process: ChildProcess): Promise<void> {
    const maxAttempts = 120
    const delayMs = 1000

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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

    const errorMsg =
      `Server failed to start within ${(maxAttempts * delayMs) / 1000} seconds. ` +
      `This may indicate missing dependencies. ` +
      `For NVIDIA GPUs, ensure you have: ` +
      `1) Latest NVIDIA drivers (525.x+), ` +
      `2) Visual C++ Redistributables. ` +
      `The CUDA runtime is included in the llama.cpp build. ` +
      `Check the console logs for detailed error messages.`
    this.appLogger.error(errorMsg, this.name)
    throw new Error(errorMsg)
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
    this.appLogger.info(`removing LlamaCPP service directory`, this.name)
    await filesystem.remove(this.serviceDir)
    this.appLogger.info(`removed LlamaCPP service directory`, this.name)
    this.setStatus('notInstalled')
    this.isSetUp = false
    // Clear startup errors when uninstalling
    this.clearLastStartupError()
  }
}
