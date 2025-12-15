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

const execAsync = promisify(exec)

interface OvmsServerProcess {
  process: ChildProcess
  port: number
  modelRepoId: string
  type: 'llm' | 'embedding' | 'transcription'
  contextSize?: number
  isReady: boolean
  healthEndpointUrl: string
}

export class OpenVINOBackendService implements ApiService {
  readonly name = 'openvino-backend' as BackendServiceName
  readonly baseUrl: string
  readonly port: number
  readonly isRequired: boolean = false
  readonly win: BrowserWindow
  readonly settings: LocalSettings

  // Service directories
  readonly baseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../../')
  readonly serviceDir: string
  readonly ovmsDir: string
  readonly ovmsExePath: string

  readonly zipPath: string
  devices: InferenceDevice[] = [{ id: 'AUTO', name: 'Auto select device', selected: true }]
  sttDevices: InferenceDevice[] = [{ id: 'AUTO', name: 'Auto select device', selected: true }]

  // Health endpoint
  healthEndpointUrl: string

  // Status tracking
  currentStatus: BackendStatus = 'notInstalled'
  isSetUp: boolean = false
  desiredStatus: BackendStatus = 'uninitializedStatus'

  // Model server processes
  private ovmsLlmProcess: OvmsServerProcess | null = null
  private ovmsEmbeddingProcess: OvmsServerProcess | null = null
  private ovmsTranscriptionProcess: OvmsServerProcess | null = null
  private currentModel: string | null = null
  private currentContextSize: number | null = null
  private currentEmbeddingModel: string | null = null
  private currentTranscriptionModel: string | null = null

  // Store last startup error details for persistence
  private lastStartupErrorDetails: ErrorDetails | null = null

  // Cached installed version for inclusion in service info updates
  private cachedInstalledVersion: { version: string; releaseTag?: string } | undefined = undefined

  // Logger
  readonly appLogger = appLoggerInstance

  private version = '2025.3'

  constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
    this.name = name
    this.port = port
    this.win = win
    this.settings = settings
    this.baseUrl = `http://127.0.0.1:${port}/v3`
    this.healthEndpointUrl = `http://127.0.0.1:${port}/v2/health/ready`

    // Set up paths
    this.serviceDir = path.resolve(path.join(this.baseDir, 'OpenVINO'))
    this.ovmsDir = path.resolve(path.join(this.serviceDir, 'ovms'))
    this.ovmsExePath = path.resolve(path.join(this.ovmsDir, 'ovms.exe'))
    this.zipPath = path.resolve(path.join(this.serviceDir, 'ovms.zip'))

    // Check if already set up
    this.isSetUp = this.serviceIsSetUp()
    console.log('OVMS isSetUp:', this.isSetUp)

    // Cache version on startup if already set up
    if (this.isSetUp) {
      this.updateCachedVersion().then(() => {
        this.updateStatus()
      })
    }
  }

  serviceIsSetUp(): boolean {
    console.log('checking', this.ovmsExePath)
    return filesystem.existsSync(this.ovmsExePath)
  }

  async ensureBackendReadiness(
    llmModelName: string,
    embeddingModelName?: string,
    contextSize?: number,
  ): Promise<void> {
    this.appLogger.info(
      `Ensuring OpenVINO backend readiness for LLM: ${llmModelName}, Embedding: ${embeddingModelName ?? 'none'}, Context: ${contextSize ?? 'default'}`,
      this.name,
    )

    try {
      // Handle LLM model
      const needsLlmRestart =
        this.currentModel !== llmModelName ||
        (contextSize && contextSize !== this.currentContextSize) ||
        !this.ovmsLlmProcess?.isReady

      if (needsLlmRestart) {
        await this.stopOvmsLlmServer()
        await this.startOvmsLlmServer(llmModelName, contextSize)
        this.appLogger.info(`LLM server ready with model: ${llmModelName}`, this.name)
      } else {
        this.appLogger.info(`LLM server already running with model: ${llmModelName}`, this.name)
      }

      // Handle embedding model if provided
      if (embeddingModelName) {
        const needsEmbeddingRestart =
          this.currentEmbeddingModel !== embeddingModelName ||
          !this.ovmsEmbeddingProcess?.isReady

        if (needsEmbeddingRestart) {
          await this.stopOvmsEmbeddingServer()
          await this.startOvmsEmbeddingServer(embeddingModelName)
          this.appLogger.info(`Embedding server ready with model: ${embeddingModelName}`, this.name)
        } else {
          this.appLogger.info(
            `Embedding server already running with model: ${embeddingModelName}`,
            this.name,
          )
        }
      }

      this.appLogger.info(
        `OpenVINO backend fully ready - LLM: ${llmModelName}, Embedding: ${embeddingModelName ?? 'none'}`,
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

  async selectDevice(deviceId: string): Promise<void> {
    if (!this.devices.find((d) => d.id === deviceId)) return
    this.devices = this.devices.map((d) => ({ ...d, selected: d.id === deviceId }))
    this.updateStatus()
  }

  async selectSttDevice(deviceId: string): Promise<void> {
    if (!this.sttDevices.find((d) => d.id === deviceId)) return
    this.sttDevices = this.sttDevices.map((d) => ({ ...d, selected: d.id === deviceId }))
    this.updateStatus()
  }

  async detectDevices() {
    const defaultDevices: InferenceDevice[] = [{ id: 'AUTO', name: 'Auto select device', selected: true }]

    if (!this.isSetUp) {
      this.appLogger.info('OpenVINO not set up, using default devices', this.name)
      this.devices = defaultDevices
      this.sttDevices = [...defaultDevices]
      this.updateStatus()
      return
    }

    try {
      this.appLogger.info('Detecting OpenVINO devices using ovms.exe', this.name)

      // Get a temporary port for device detection
      const tempPort = await getPort({ port: portNumbers(57300, 57399) })

      const detectedDevices = await new Promise<string[]>((resolve, reject) => {
        const args = ['--config_path', '.', '--rest_port', tempPort.toString()]

        this.appLogger.info(`Running device detection: ${this.ovmsExePath} ${args.join(' ')}`, this.name)

        // Set up environment variables as per setupvars.ps1
        const pythonDir = path.join(this.ovmsDir, 'python')
        const scriptsDir = path.join(this.ovmsDir, 'python', 'Scripts')

        const childProcess = spawn(this.ovmsExePath, args, {
          cwd: this.ovmsDir,
          windowsHide: true,
          env: {
            ...process.env,
            OVMS_DIR: this.ovmsDir,
            PYTHONHOME: pythonDir,
            PATH: `${this.ovmsDir};${pythonDir};${scriptsDir};${process.env.PATH}`,
          },
        })

        let resolved = false
        const devicePattern = /Available devices for Open VINO:\s*(.+)/

        const parseOutput = (data: string) => {
          if (resolved) return

          const lines = data.split('\n')
          for (const line of lines) {
            const match = line.match(devicePattern)
            if (match && match[1]) {
              resolved = true
              const devices = match[1]
                .split(',')
                .map((d) => d.trim())
                .filter((d) => d.length > 0)
              this.appLogger.info(`Detected OpenVINO devices: ${devices.join(', ')}`, this.name)

              // Kill the process since we have what we need
              childProcess.kill('SIGTERM')
              resolve(devices)
              return
            }
          }
        }

        childProcess.stdout?.on('data', (data: Buffer) => parseOutput(data.toString()))
        childProcess.stderr?.on('data', (data: Buffer) => parseOutput(data.toString()))

        childProcess.on('error', (error: Error) => {
          if (!resolved) {
            resolved = true
            this.appLogger.error(`Device detection process error: ${error}`, this.name)
            reject(error)
          }
        })

        childProcess.on('exit', (code: number | null) => {
          if (!resolved) {
            resolved = true
            this.appLogger.warn(`Device detection process exited with code ${code} before finding devices`, this.name)
            reject(new Error(`Process exited with code ${code} before detecting devices`))
          }
        })

        // Timeout after 10 seconds
        setTimeout(() => {
          if (!resolved) {
            resolved = true
            this.appLogger.warn('Device detection timed out after 10 seconds', this.name)
            childProcess.kill('SIGTERM')
            reject(new Error('Device detection timed out'))
          }
        }, 10000)
      })

      // Map detected devices to InferenceDevice format
      const deviceNameMap: Record<string, string> = {
        CPU: 'CPU',
        GPU: 'GPU (Intel)',
        NPU: 'NPU (Intel)',
      }

      const mappedDevices: InferenceDevice[] = detectedDevices.map((deviceId) => ({
        id: deviceId,
        name: deviceNameMap[deviceId] || deviceId,
        selected: false,
      }))

      // Create base device list with AUTO option
      const baseDevices: InferenceDevice[] = [
        { id: 'AUTO', name: 'Auto select device', selected: false },
        ...mappedDevices,
      ]

      // Helper function to select device by priority
      const selectByPriority = (
        devices: InferenceDevice[],
        priority: string[],
      ): InferenceDevice[] => {
        const result = devices.map((d) => ({ ...d, selected: false }))
        const selectedDevice = priority
          .map((id) => result.find((d) => d.id === id))
          .find((d) => d !== undefined)
        if (selectedDevice) {
          selectedDevice.selected = true
        } else {
          result[0].selected = true // Fallback to AUTO
        }
        return result
      }

      // LLM devices: priority GPU > AUTO
      this.devices = selectByPriority(baseDevices, ['GPU'])

      // STT devices: priority NPU > CPU > GPU > AUTO
      this.sttDevices = selectByPriority(
        baseDevices.map((d) => ({ ...d })),
        ['NPU', 'CPU', 'GPU'],
      )

      this.appLogger.info(`Available LLM devices: ${JSON.stringify(this.devices, null, 2)}`, this.name)
      this.appLogger.info(`Available STT devices: ${JSON.stringify(this.sttDevices, null, 2)}`, this.name)
    } catch (error) {
      this.appLogger.error(`Failed to detect devices: ${error}`, this.name)
      // Fallback to default device on error
      this.devices = defaultDevices
      this.sttDevices = [...defaultDevices]
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
      sttDevices: this.sttDevices,
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
      this.appLogger.info(`applied new OpenVINO Model Server version ${this.version}`, this.name)
    }
  }

  async getSettings(): Promise<ServiceSettings> {
    this.appLogger.info(`getting OpenVINO settings`, this.name)
    return {
      version: this.version,
      serviceName: this.name,
    }
  }

  async getInstalledVersion(): Promise<{ version?: string; releaseTag?: string } | undefined> {
    if (!this.isSetUp) return undefined
    try {
      const result = await execAsync(`"${this.ovmsExePath}" --version`, {
        timeout: 5000,
      })
      // Parse output like "OpenVINO backend 2025.4.0.0rc3"
      const versionMatch = result.stdout.match(/OpenVINO backend\s+([\d.]+(?:rc\d+)?)/)
      if (versionMatch && versionMatch[1]) {
        return { version: versionMatch[1] }
      }
    } catch (e) {
      this.appLogger.error(`failed to get installed OpenVINO version: ${e}`, this.name)
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
        debugMessage: 'starting to set up OpenVINO Model Server',
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
        debugMessage: `downloading OpenVINO Model Server`,
      }

      await this.downloadOvms()

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'download complete',
      }

      // Extract OVMS ZIP file
      currentStep = 'extract'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'extracting OpenVINO Model Server',
      }

      await this.extractOvms()

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'extraction complete',
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
        debugMessage: `Failed to setup OpenVINO Model Server due to ${e}`,
        errorDetails,
      }
    }
  }

  private async downloadOvms(): Promise<void> {
    const downloadUrl = `https://github.com/openvinotoolkit/model_server/releases/download/v2025.4/ovms_windows_python_on.zip`
    this.appLogger.info(`Downloading OVMS from ${downloadUrl}`, this.name)

    // Delete existing zip if it exists
    if (filesystem.existsSync(this.zipPath)) {
      this.appLogger.info(`Removing existing OVMS zip file`, this.name)
      filesystem.removeSync(this.zipPath)
    }

    // Using electron net for better proxy support
    const response = await net.fetch(downloadUrl)
    if (!response.ok || response.status !== 200 || !response.body) {
      throw new Error(`Failed to download OVMS: ${response.statusText}`)
    }

    const buffer = await response.arrayBuffer()
    await filesystem.writeFile(this.zipPath, Buffer.from(buffer))

    this.appLogger.info(`OVMS zip file downloaded successfully`, this.name)
  }

  private async extractOvms(): Promise<void> {
    this.appLogger.info(`Extracting OVMS to ${this.ovmsDir}`, this.name)

    // Delete existing ovms directory if it exists
    if (filesystem.existsSync(this.ovmsDir)) {
      this.appLogger.info(`Removing existing OVMS directory`, this.name)
      filesystem.removeSync(this.ovmsDir)
    }

    // Create ovms directory
    filesystem.mkdirSync(this.ovmsDir, { recursive: true })

    // Extract zip file using PowerShell's Expand-Archive
    try {
      const command = `powershell -Command "Expand-Archive -Path '${this.zipPath}' -DestinationPath '${this.ovmsDir}' -Force"`
      await execAsync(command)

      this.appLogger.info(`OVMS extracted successfully`, this.name)

      // Check if there's only a single top-level folder and move its contents up
      const items = filesystem.readdirSync(this.ovmsDir)
      if (items.length === 1) {
        const singleItem = path.join(this.ovmsDir, items[0])
        const stats = filesystem.statSync(singleItem)

        if (stats.isDirectory()) {
          this.appLogger.info(
            `Found single top-level folder '${items[0]}', moving contents up`,
            this.name,
          )

          // Move contents to temp directory first
          const tempDir = path.join(this.serviceDir, 'ovms-temp')
          filesystem.moveSync(singleItem, tempDir)

          // Remove the now-empty ovms directory
          filesystem.removeSync(this.ovmsDir)

          // Rename temp directory to ovms
          filesystem.moveSync(tempDir, this.ovmsDir)

          this.appLogger.info(`Moved contents of '${items[0]}' up to ovms directory`, this.name)
        }
      }
    } catch (error) {
      this.appLogger.error(`Failed to extract OVMS: ${error}`, this.name)
      throw error
    }
  }

  async start(): Promise<BackendStatus> {
    // In this architecture, model server is started on-demand via ensureBackendReadiness
    // This method is kept for ApiService interface compatibility
    if (this.currentStatus === 'running') {
      this.clearLastStartupError()
      return 'running'
    }

    this.appLogger.info(`${this.name} service ready - model server will start on-demand`, this.name)
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
    await this.stopOvmsLlmServer()
    await this.stopOvmsEmbeddingServer()
    await this.stopOvmsTranscriptionServer()

    this.setStatus('stopped')
    return 'stopped'
  }

  /**
   * Get the embedding server URL if an embedding server is running
   * @returns The embedding server base URL, or null if no embedding server is running
   */
  getEmbeddingServerUrl(): string | null {
    if (this.ovmsEmbeddingProcess?.isReady) {
      return `http://127.0.0.1:${this.ovmsEmbeddingProcess.port}/v3`
    }
    return null
  }

  /**
   * Get the transcription server URL if a transcription server is running
   * @returns The transcription server base URL, or null if no transcription server is running
   */
  getTranscriptionServerUrl(): string | null {
    if (this.ovmsTranscriptionProcess?.isReady) {
      return `http://127.0.0.1:${this.ovmsTranscriptionProcess.port}/v3`
    }
    return null
  }

  /**
   * Start transcription server independently
   * @param modelName - The transcription model name (e.g., 'OpenVINO/whisper-large-v3-int4-ov')
   */
  async startTranscriptionServer(modelName: string): Promise<void> {
    try {
      this.appLogger.info(`Starting transcription server for model: ${modelName}`, this.name)

      // Check if already running with the same model
      if (
        this.ovmsTranscriptionProcess?.isReady &&
        this.currentTranscriptionModel === modelName
      ) {
        this.appLogger.info(
          `Transcription server already running with model: ${modelName}`,
          this.name,
        )
        return
      }

      // Stop existing server if running different model
      if (this.ovmsTranscriptionProcess) {
        await this.stopOvmsTranscriptionServer()
      }

      // Start new server
      await this.startOvmsTranscriptionServer(modelName)
      this.appLogger.info(`Transcription server started successfully for model: ${modelName}`, this.name)
    } catch (error) {
      this.appLogger.error(
        `Failed to start transcription server for model ${modelName}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  /**
   * Stop transcription server independently
   */
  async stopTranscriptionServer(): Promise<void> {
    try {
      this.appLogger.info('Stopping transcription server', this.name)
      await this.stopOvmsTranscriptionServer()
      this.appLogger.info('Transcription server stopped successfully', this.name)
    } catch (error) {
      this.appLogger.error(`Failed to stop transcription server: ${error}`, this.name)
      throw error
    }
  }

  // Model server management methods
  private async startOvmsLlmServer(
    modelRepoId: string,
    contextSize?: number,
  ): Promise<OvmsServerProcess> {
    try {
      const selectedDevice = this.devices.find((d) => d.selected)?.id || 'AUTO'

      this.appLogger.info(
        `Starting OVMS server for model: ${modelRepoId} on port ${this.port} with device ${selectedDevice}`,
        this.name,
      )

      const args = [
        '--rest_bind_address',
        '127.0.0.1',
        '--rest_port',
        this.port.toString(),
        '--rest_workers',
        '4',
        '--source_model',
        modelRepoId.split('/').join('---'),
        '--model_repository_path',
        path.resolve(path.join(this.baseDir, 'models', 'LLM', 'openvino')),
        '--target_device',
        selectedDevice,
        '--cache_size',
        '2',
        '--task',
        'text_generation',
        '--tool_parser',
        'hermes3',
        '--reasoning_parser',
        'qwen3',
      ]

      this.appLogger.info(`OVMS launch args: ${args.join(' ')}`, this.name)

      // Set up environment variables as per setupvars.ps1
      const pythonDir = path.join(this.ovmsDir, 'python')
      const scriptsDir = path.join(this.ovmsDir, 'python', 'Scripts')

      const childProcess = spawn(this.ovmsExePath, args, {
        cwd: this.ovmsDir,
        windowsHide: true,
        env: {
          ...process.env,
          OVMS_DIR: this.ovmsDir,
          PYTHONHOME: pythonDir,
          PATH: `${this.ovmsDir};${pythonDir};${scriptsDir};${process.env.PATH}`,
        },
      })

      const healthUrl = `http://127.0.0.1:${this.port}/v2/health/ready`
      const ovmsProcess: OvmsServerProcess = {
        process: childProcess,
        port: this.port,
        modelRepoId,
        type: 'llm',
        contextSize,
        isReady: false,
        healthEndpointUrl: healthUrl,
      }

      // Set up process event handlers
      childProcess.stdout!.on('data', (message) => {
        this.appLogger.info(`[OVMS LLM] ${message}`, this.name)
      })

      childProcess.stderr!.on('data', (message) => {
        this.appLogger.error(`[OVMS LLM] ${message}`, this.name)
      })

      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`OVMS LLM server process error: ${error}`, this.name)
      })

      childProcess.on('exit', (code: number | null) => {
        this.appLogger.info(`OVMS LLM server process exited with code: ${code}`, this.name)
        if (this.ovmsLlmProcess === ovmsProcess) {
          this.ovmsLlmProcess = null
          this.currentModel = null
          this.currentContextSize = null
        }
      })

      // Wait for server to be ready
      await this.waitForServerReady(healthUrl, childProcess)
      ovmsProcess.isReady = true

      this.ovmsLlmProcess = ovmsProcess
      this.currentModel = modelRepoId
      this.currentContextSize = contextSize ?? null

      this.appLogger.info(`OVMS LLM server ready for model: ${modelRepoId}`, this.name)
      return ovmsProcess
    } catch (error) {
      this.appLogger.error(
        `Failed to start OVMS server for model ${modelRepoId}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  private async stopOvmsLlmServer(): Promise<void> {
    if (this.ovmsLlmProcess) {
      this.appLogger.info(`Stopping OVMS LLM server for model: ${this.currentModel}`, this.name)
      this.ovmsLlmProcess.process.kill('SIGTERM')

      // Wait a bit for graceful shutdown, then force kill if needed
      await new Promise<void>((resolve) => {
        const currentProcess = this.ovmsLlmProcess
        const timeout = setTimeout(() => {
          if (currentProcess) {
            this.appLogger.warn(`Force killing OVMS LLM server process`, this.name)
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

      this.ovmsLlmProcess = null
      this.currentModel = null
      this.currentContextSize = null
    }
  }

  private async startOvmsEmbeddingServer(modelRepoId: string): Promise<OvmsServerProcess> {
    try {
      const selectedDevice = this.devices.find((d) => d.selected)?.id || 'AUTO'
      const port = await getPort({ port: portNumbers(29100, 29199) })
      // Validate model path exists
      this.resolveEmbeddingModelPath(modelRepoId)

      this.appLogger.info(
        `Starting OVMS embedding server for model: ${modelRepoId} on port ${port} with device ${selectedDevice}`,
        this.name,
      )

      const args = [
        '--rest_bind_address',
        '127.0.0.1',
        '--rest_port',
        port.toString(),
        '--rest_workers',
        '4',
        '--source_model',
        modelRepoId.split('/').join('---'),
        '--model_repository_path',
        path.resolve(path.join(this.baseDir, 'models', 'LLM', 'embedding', 'openVINO')),
        '--target_device',
        selectedDevice,
        '--task',
        'embeddings',
        '--pooling',
        'LAST',
      ]

      this.appLogger.info(`OVMS embedding launch args: ${args.join(' ')}`, this.name)

      // Set up environment variables as per setupvars.ps1
      const pythonDir = path.join(this.ovmsDir, 'python')
      const scriptsDir = path.join(this.ovmsDir, 'python', 'Scripts')

      const childProcess = spawn(this.ovmsExePath, args, {
        cwd: this.ovmsDir,
        windowsHide: true,
        env: {
          ...process.env,
          OVMS_DIR: this.ovmsDir,
          PYTHONHOME: pythonDir,
          PATH: `${this.ovmsDir};${pythonDir};${scriptsDir};${process.env.PATH}`,
        },
      })

      const healthUrl = `http://127.0.0.1:${port}/v2/health/ready`
      const ovmsProcess: OvmsServerProcess = {
        process: childProcess,
        port,
        modelRepoId,
        type: 'embedding',
        isReady: false,
        healthEndpointUrl: healthUrl,
      }

      // Set up process event handlers
      childProcess.stdout!.on('data', (message) => {
        this.appLogger.info(`[OVMS Embedding] ${message}`, this.name)
      })

      childProcess.stderr!.on('data', (message) => {
        this.appLogger.error(`[OVMS Embedding] ${message}`, this.name)
      })

      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`OVMS embedding server process error: ${error}`, this.name)
      })

      childProcess.on('exit', (code: number | null) => {
        this.appLogger.info(`OVMS embedding server process exited with code: ${code}`, this.name)
        if (this.ovmsEmbeddingProcess === ovmsProcess) {
          this.ovmsEmbeddingProcess = null
          this.currentEmbeddingModel = null
        }
      })

      // Wait for server to be ready
      await this.waitForServerReady(healthUrl, childProcess)
      ovmsProcess.isReady = true

      this.ovmsEmbeddingProcess = ovmsProcess
      this.currentEmbeddingModel = modelRepoId

      this.appLogger.info(`OVMS embedding server ready for model: ${modelRepoId}`, this.name)
      return ovmsProcess
    } catch (error) {
      this.appLogger.error(
        `Failed to start OVMS embedding server for model ${modelRepoId}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  private async stopOvmsEmbeddingServer(): Promise<void> {
    if (this.ovmsEmbeddingProcess) {
      this.appLogger.info(
        `Stopping OVMS embedding server for model: ${this.currentEmbeddingModel}`,
        this.name,
      )
      this.ovmsEmbeddingProcess.process.kill('SIGTERM')

      // Wait a bit for graceful shutdown, then force kill if needed
      await new Promise<void>((resolve) => {
        const currentProcess = this.ovmsEmbeddingProcess
        const timeout = setTimeout(() => {
          if (currentProcess) {
            this.appLogger.warn(`Force killing OVMS embedding server process`, this.name)
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

      this.ovmsEmbeddingProcess = null
      this.currentEmbeddingModel = null
    }
  }

  private async startOvmsTranscriptionServer(modelRepoId: string): Promise<OvmsServerProcess> {
    try {
      const selectedDevice = this.sttDevices.find((d) => d.selected)?.id || 'AUTO'
      const port = await getPort({ port: portNumbers(29200, 29299) })
      // Validate model path exists
      this.resolveTranscriptionModelPath(modelRepoId)
      const modelName = modelRepoId.split('/').join('---')

      this.appLogger.info(
        `Starting OVMS transcription server for model: ${modelRepoId} on port ${port} with device ${selectedDevice}`,
        this.name,
      )

      const args = [
        '--rest_bind_address',
        '127.0.0.1',
        '--rest_port',
        port.toString(),
        '--rest_workers',
        '2',
        '--source_model',
        modelName,
        '--model_repository_path',
        path.resolve(path.join(this.baseDir, 'models', 'STT')),
        '--model_name',
        modelName,
        '--target_device',
        selectedDevice,
        // '--cache_size',
        // '2',
        '--task',
        'speech2text',
      ]

      this.appLogger.info(`OVMS transcription launch args: ${args.join(' ')}`, this.name)

      // Set up environment variables as per setupvars.ps1
      const pythonDir = path.join(this.ovmsDir, 'python')
      const scriptsDir = path.join(this.ovmsDir, 'python', 'Scripts')

      const childProcess = spawn(this.ovmsExePath, args, {
        cwd: this.ovmsDir,
        windowsHide: true,
        env: {
          ...process.env,
          OVMS_DIR: this.ovmsDir,
          PYTHONHOME: pythonDir,
          PATH: `${this.ovmsDir};${pythonDir};${scriptsDir};${process.env.PATH}`,
        },
      })

      const healthUrl = `http://127.0.0.1:${port}/v2/health/ready`
      const ovmsProcess: OvmsServerProcess = {
        process: childProcess,
        port,
        modelRepoId,
        type: 'transcription',
        isReady: false,
        healthEndpointUrl: healthUrl,
      }

      // Set up process event handlers
      childProcess.stdout!.on('data', (message) => {
        this.appLogger.info(`[OVMS Transcription] ${message}`, this.name)
      })

      childProcess.stderr!.on('data', (message) => {
        this.appLogger.error(`[OVMS Transcription] ${message}`, this.name)
      })

      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`OVMS transcription server process error: ${error}`, this.name)
      })

      childProcess.on('exit', (code: number | null) => {
        this.appLogger.info(`OVMS transcription server process exited with code: ${code}`, this.name)
        if (this.ovmsTranscriptionProcess === ovmsProcess) {
          this.ovmsTranscriptionProcess = null
          this.currentTranscriptionModel = null
        }
      })

      // Wait for server to be ready
      await this.waitForServerReady(healthUrl, childProcess)
      ovmsProcess.isReady = true

      this.ovmsTranscriptionProcess = ovmsProcess
      this.currentTranscriptionModel = modelRepoId

      this.appLogger.info(`OVMS transcription server ready for model: ${modelRepoId}`, this.name)
      return ovmsProcess
    } catch (error) {
      this.appLogger.error(
        `Failed to start OVMS transcription server for model ${modelRepoId}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  private async stopOvmsTranscriptionServer(): Promise<void> {
    if (this.ovmsTranscriptionProcess) {
      this.appLogger.info(
        `Stopping OVMS transcription server for model: ${this.currentTranscriptionModel}`,
        this.name,
      )
      this.ovmsTranscriptionProcess.process.kill('SIGTERM')

      // Wait a bit for graceful shutdown, then force kill if needed
      await new Promise<void>((resolve) => {
        const currentProcess = this.ovmsTranscriptionProcess
        const timeout = setTimeout(() => {
          if (currentProcess) {
            this.appLogger.warn(`Force killing OVMS transcription server process`, this.name)
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

      this.ovmsTranscriptionProcess = null
      this.currentTranscriptionModel = null
    }
  }

  private resolveEmbeddingModelPath(modelRepoId: string): string {
    // Use the same logic as the Python backend
    const modelBasePath = 'models/LLM/embedding/openVINO'
    const [namespace, repo, ...model] = modelRepoId.split('/')
    const modelDir = path.resolve(
      path.join(this.baseDir, modelBasePath, `${namespace}---${repo}`, model.join('/')),
    )

    if (!filesystem.existsSync(modelDir)) {
      throw new Error(`Embedding model directory not found: ${modelDir}`)
    }

    return modelDir
  }

  private resolveTranscriptionModelPath(modelRepoId: string): string {
    // Use the same logic as LLM models - transcription models are stored in the same location
    const modelBasePath = 'models/STT'
    const [namespace, repo, ...model] = modelRepoId.split('/')
    const modelDir = path.resolve(
      path.join(this.baseDir, modelBasePath, `${namespace}---${repo}`, model.join('/')),
    )

    if (!filesystem.existsSync(modelDir)) {
      throw new Error(`Transcription model directory not found: ${modelDir}`)
    }

    return modelDir
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

    throw new Error(`Server failed to start within ${(maxAttempts * delayMs) / 1000} seconds`)
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
    this.appLogger.info(`removing OpenVINO Model Server directory`, this.name)
    await filesystem.remove(this.ovmsDir)
    this.appLogger.info(`removed OpenVINO Model Server directory`, this.name)
    this.setStatus('notInstalled')
    this.isSetUp = false
    // Clear startup errors when uninstalling
    this.clearLastStartupError()
  }
}
