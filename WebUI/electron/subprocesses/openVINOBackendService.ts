import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import * as filesystem from 'fs-extra'
import { app, BrowserWindow, net } from 'electron'
import { appLoggerInstance } from '../logging/logger.ts'
import {
  ApiService,
  createEnhancedErrorDetails,
  ErrorDetails,
} from './service.ts'
import { promisify } from 'util'
import { exec } from 'child_process'
import { detectOpenVINODevices, openVinoDeviceSelectorEnv } from './deviceDetection.ts'
import { LocalSettings } from '../main.ts'

const execAsync = promisify(exec)

interface OvmsServerProcess {
  process: ChildProcess
  port: number
  modelRepoId: string
  contextSize?: number
  isReady: boolean
}

export class OpenVINOBackendService implements ApiService {
  readonly name = 'openvino-backend' as BackendServiceName
  readonly baseUrl: string
  readonly port: number
  readonly isRequired: boolean = true
  readonly win: BrowserWindow
  readonly settings: LocalSettings

  // Service directories
  readonly baseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../../')
  readonly serviceDir: string
  readonly ovmsDir: string
  readonly ovmsExePath: string

  readonly zipPath: string
  devices: InferenceDevice[] = [{ id: 'AUTO', name: 'Auto select device', selected: true }]

  // Health endpoint
  healthEndpointUrl: string

  // Status tracking
  currentStatus: BackendStatus = 'notInstalled'
  isSetUp: boolean = false
  desiredStatus: BackendStatus = 'uninitializedStatus'

  // Model server process
  private ovmsProcess: OvmsServerProcess | null = null
  private currentModel: string | null = null
  private currentContextSize: number | null = null

  // Store last startup error details for persistence
  private lastStartupErrorDetails: ErrorDetails | null = null

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
      `Ensuring OpenVINO backend readiness for LLM: ${llmModelName}, Context: ${contextSize ?? 'default'}`,
      this.name,
    )

    try {
      // Handle model and context size changes
      const needsRestart =
        this.currentModel !== llmModelName ||
        (contextSize && contextSize !== this.currentContextSize) ||
        !this.ovmsProcess?.isReady

      if (needsRestart) {
        await this.stopOvmsServer()
        await this.startOvmsServer(llmModelName, contextSize)
        this.appLogger.info(`OpenVINO server ready with model: ${llmModelName}`, this.name)
      } else {
        this.appLogger.info(`OpenVINO server already running with model: ${llmModelName}`, this.name)
      }

      this.appLogger.info(
        `OpenVINO backend fully ready - LLM: ${llmModelName}`,
        this.name,
      )
    } catch (error) {
      this.appLogger.error(
        `Failed to ensure backend readiness - LLM: ${llmModelName}: ${error}`,
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

  async detectDevices() {
    try {
      // For now, we use a simple device list. Could enhance later with ovms device detection
      this.appLogger.info('Setting up OpenVINO device options', this.name)
      this.devices = [
        { id: 'AUTO', name: 'Auto select device', selected: true },
        { id: 'GPU', name: 'GPU (Intel)', selected: false },
        { id: 'CPU', name: 'CPU', selected: false },
      ]
      this.appLogger.info(
        `Available devices: ${JSON.stringify(this.devices, null, 2)}`,
        this.name,
      )
    } catch (error) {
      this.appLogger.error(`Failed to detect devices: ${error}`, this.name)
      // Fallback to default device on error
      this.devices = [{ id: 'AUTO', name: 'Auto select device', selected: true }]
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

      this.setStatus('notYetStarted')
      this.isSetUp = true

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

      const errorDetails = await createEnhancedErrorDetails(
        e,
        `${currentStep} operation`,
      )

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
    const downloadUrl = `https://github.com/openvinotoolkit/model_server/releases/download/v2025.3/ovms_windows_python_on.zip`
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
          this.appLogger.info(`Found single top-level folder '${items[0]}', moving contents up`, this.name)
          
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

    this.appLogger.info(
      `${this.name} service ready - model server will start on-demand`,
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

    // Stop model server
    await this.stopOvmsServer()

    this.setStatus('stopped')
    return 'stopped'
  }

  // Model server management methods
  private async startOvmsServer(
    modelRepoId: string,
    contextSize?: number,
  ): Promise<OvmsServerProcess> {
    try {
      const selectedDevice = this.devices.find((d) => d.selected)?.id || 'AUTO'
      const cacheSize = contextSize ? Math.ceil(contextSize / 1024) : 2 // Convert to approximate cache size in GB

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
        modelRepoId,
        '--model_repository_path',
        'models',
        '--target_device',
        selectedDevice,
        '--cache_size',
        cacheSize.toString(),
        '--task',
        'text_generation',
      ]

this.appLogger.info(
        `OVMS launch args: ${args.join(' ')}`,
        this.name,
      )

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

      const ovmsProcess: OvmsServerProcess = {
        process: childProcess,
        port: this.port,
        modelRepoId,
        contextSize,
        isReady: false,
      }

      // Set up process event handlers
      childProcess.stdout!.on('data', (message) => {
        this.appLogger.info(`[OVMS] ${message}`, this.name)
      })

      childProcess.stderr!.on('data', (message) => {
        this.appLogger.error(`[OVMS] ${message}`, this.name)
      })

      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`OVMS server process error: ${error}`, this.name)
      })

      childProcess.on('exit', (code: number | null) => {
        this.appLogger.info(`OVMS server process exited with code: ${code}`, this.name)
        if (this.ovmsProcess === ovmsProcess) {
          this.ovmsProcess = null
          this.currentModel = null
          this.currentContextSize = null
        }
      })

      // Wait for server to be ready
      await this.waitForServerReady(this.healthEndpointUrl)
      ovmsProcess.isReady = true

      this.ovmsProcess = ovmsProcess
      this.currentModel = modelRepoId
      this.currentContextSize = contextSize ?? null

      this.appLogger.info(`OVMS server ready for model: ${modelRepoId}`, this.name)
      return ovmsProcess
    } catch (error) {
      this.appLogger.error(
        `Failed to start OVMS server for model ${modelRepoId}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  private async stopOvmsServer(): Promise<void> {
    if (this.ovmsProcess) {
      this.appLogger.info(`Stopping OVMS server for model: ${this.currentModel}`, this.name)
      this.ovmsProcess.process.kill('SIGTERM')

      // Wait a bit for graceful shutdown, then force kill if needed
      await new Promise<void>((resolve) => {
        const currentProcess = this.ovmsProcess
        const timeout = setTimeout(() => {
          if (currentProcess) {
            this.appLogger.warn(`Force killing OVMS server process`, this.name)
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

      this.ovmsProcess = null
      this.currentModel = null
      this.currentContextSize = null
    }
  }

  private async waitForServerReady(healthUrl: string): Promise<void> {
    const maxAttempts = 120
    const delayMs = 1000

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(healthUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(1000),
        })

        if (response.ok) {
          this.appLogger.info(`Server ready at ${healthUrl}`, this.name)
          return
        }
      } catch (_error) {
        // Server not ready yet, continue waiting
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
