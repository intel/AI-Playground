import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import * as filesystem from 'fs-extra'
import { app, BrowserWindow, net } from 'electron'
import { appLoggerInstance } from '../logging/logger.ts'
import { ApiService, DeviceService, PythonService, createEnhancedErrorDetails } from './service.ts'
import { promisify } from 'util'
import { exec } from 'child_process'
import { detectLevelZeroDevices } from './deviceDetection.ts'
import { getBestDevice } from './deviceArch.ts'

const execAsync = promisify(exec)

export class OllamaBackendService implements ApiService {
  readonly name = 'ollama-backend' as BackendServiceName
  readonly baseUrl: string
  readonly port: number
  readonly isRequired: boolean = false
  readonly win: BrowserWindow
  readonly settings: LocalSettings

  // Service directories
  readonly baseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../../')
  readonly serviceDir: string
  readonly ollamaDir: string
  readonly ollamaExePath: string

  readonly zipPath: string
  readonly aiBackend = new PythonService(
    path.resolve(path.join(this.baseDir, `ai-backend-env`)),
    path.resolve(path.join(this.baseDir, `service`)),
  )
  readonly deviceService = new DeviceService()
  devices: InferenceDevice[] = [{ id: '*', name: 'Auto select device', selected: true }]

  // Health endpoint
  healthEndpointUrl: string

  // Status tracking
  currentStatus: BackendStatus = 'notInstalled'
  isSetUp: boolean = false

  // Process management
  encapsulatedProcess: ChildProcess | null = null
  desiredStatus: BackendStatus = 'uninitializedStatus'

  // Logger
  readonly appLogger = appLoggerInstance

  private releaseTag = 'v2.3.0-nightly'
  private version = '2.3.0b20250630'

  constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
    this.name = name
    this.port = port
    this.win = win
    this.settings = settings
    this.baseUrl = `http://127.0.0.1:${port}`
    this.healthEndpointUrl = `${this.baseUrl}/api/version`

    // Set up paths
    this.serviceDir = path.resolve(path.join(this.baseDir, 'ollama-service'))
    this.ollamaDir = path.resolve(path.join(this.serviceDir, 'ollama'))
    this.ollamaExePath = path.resolve(path.join(this.ollamaDir, 'ollama-lib.exe'))
    this.zipPath = path.resolve(path.join(this.serviceDir, 'ollama.zip'))

    // Check if already set up
    this.isSetUp = this.serviceIsSetUp()
  }

  async ensureBackendReadiness(llmModelName: string, embeddingModelName?: string): Promise<void> {
    this.appLogger.info(
      `ensureBackendReadiness called for LLM: ${llmModelName}, Embedding: ${embeddingModelName ?? 'none'}`,
      this.name,
    )
  }

  async detectDevices() {
    const availableDevices = await detectLevelZeroDevices(this.aiBackend)
    this.appLogger.info(`detected devices: ${JSON.stringify(availableDevices, null, 2)}`, this.name)

    let bestDeviceId: string
    try {
      const bestDeviceName = (await this.deviceService.getDevices())[0].name
      bestDeviceId = getBestDevice(availableDevices, bestDeviceName)
      this.appLogger.info(
        `Selected ${bestDeviceName} as best device by pci id via xpu-smi. Which should correspond to deviceId ${bestDeviceId}`,
        this.name,
      )
    } catch (e: unknown) {
      this.appLogger.error(`Couldn't detect best device, selecting first. Error: ${e}`, this.name)
      bestDeviceId = availableDevices[0].name
    }
    this.devices = availableDevices.map((d) => ({ ...d, selected: d.id === bestDeviceId }))
  }

  async selectDevice(deviceId: string): Promise<void> {
    if (!this.devices.find((d) => d.id === deviceId)) return
    this.devices = this.devices.map((d) => ({ ...d, selected: d.id === deviceId }))
    this.updateStatus()
  }

  serviceIsSetUp(): boolean {
    return filesystem.existsSync(this.ollamaExePath)
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
    if (settings.releaseTag) {
      this.releaseTag = settings.releaseTag
      this.appLogger.info(`applied new Ollama release tag ${this.releaseTag}`, this.name)
    }
    if (settings.version) {
      this.version = settings.version
      this.appLogger.info(`applied new Ollama version ${this.version}`, this.name)
    }
  }

  async getSettings(): Promise<ServiceSettings> {
    this.appLogger.info(`getting Ollama settings`, this.name)
    return {
      releaseTag: this.releaseTag,
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
        debugMessage: 'starting to set up Ollama service',
      }

      // Create service directory if it doesn't exist
      if (!filesystem.existsSync(this.serviceDir)) {
        filesystem.mkdirSync(this.serviceDir, { recursive: true })
      }

      // Download Ollama ZIP file
      currentStep = 'download'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `downloading Ollama`,
      }

      await this.downloadOllama()

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'download complete',
      }

      // Extract Ollama ZIP file
      currentStep = 'extract'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'extracting Ollama',
      }

      await this.extractOllama()

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

      // Create detailed error information for any type of error
      const errorDetails = createEnhancedErrorDetails(e, `${currentStep} operation`)

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'failed',
        debugMessage: `Failed to setup Ollama service due to ${e}`,
        errorDetails,
      }
    }
  }

  private async downloadOllama(): Promise<void> {
    const downloadUrl = `https://github.com/ipex-llm/ipex-llm/releases/download/${this.releaseTag}/ollama-ipex-llm-${this.version}-win.zip`
    this.appLogger.info(`Downloading Ollama from ${downloadUrl}`, this.name)

    // Delete existing zip if it exists
    if (filesystem.existsSync(this.zipPath)) {
      this.appLogger.info(`Removing existing Ollama zip file`, this.name)
      filesystem.removeSync(this.zipPath)
    }

    // Using electron net for better proxy support
    const response = await net.fetch(downloadUrl)
    if (!response.ok || response.status !== 200 || !response.body) {
      throw new Error(`Failed to download Ollama: ${response.statusText}`)
    }

    const buffer = await response.arrayBuffer()
    await filesystem.writeFile(this.zipPath, Buffer.from(buffer))

    this.appLogger.info(`Ollama zip file downloaded successfully`, this.name)
  }

  private async extractOllama(): Promise<void> {
    this.appLogger.info(`Extracting Ollama to ${this.ollamaDir}`, this.name)

    // Delete existing ollama directory if it exists
    if (filesystem.existsSync(this.ollamaDir)) {
      this.appLogger.info(`Removing existing Ollama directory`, this.name)
      filesystem.removeSync(this.ollamaDir)
    }

    // Create ollama directory
    filesystem.mkdirSync(this.ollamaDir, { recursive: true })

    // Extract zip file using PowerShell's Expand-Archive
    try {
      const command = `powershell -Command "Expand-Archive -Path '${this.zipPath}' -DestinationPath '${this.ollamaDir}' -Force"`
      await execAsync(command)

      this.appLogger.info(`Ollama extracted successfully`, this.name)
    } catch (error) {
      this.appLogger.error(`Failed to extract Ollama: ${error}`, this.name)
      throw error
    }
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    const additionalEnvVariables = {
      // Any environment variables needed by Ollama
      OLLAMA_HOST: `127.0.0.1:${this.port}`,
      OLLAMA_ORIGINS: '*',
    }

    this.appLogger.info(`Starting Ollama service from ${this.ollamaExePath}`, this.name)

    const apiProcess = spawn(
      this.ollamaExePath,
      ['serve'], // Start Ollama in server mode
      {
        cwd: this.ollamaDir,
        windowsHide: true,
        env: Object.assign(process.env, additionalEnvVariables),
      },
    )

    // Track process exit
    const didProcessExitEarlyTracker = new Promise<boolean>((resolve, _reject) => {
      apiProcess.on('error', (error) => {
        this.appLogger.error(`encountered error of process in ${this.name} : ${error}`, this.name)
        resolve(true)
      })
      apiProcess.on('exit', () => {
        this.appLogger.error(`encountered unexpected exit in ${this.name}.`, this.name)
        resolve(true)
      })
    })

    return {
      process: apiProcess,
      didProcessExitEarlyTracker: didProcessExitEarlyTracker,
    }
  }

  async start(): Promise<BackendStatus> {
    if (
      this.desiredStatus === 'stopped' &&
      !(this.currentStatus === 'stopped' || this.currentStatus === 'notYetStarted')
    ) {
      throw new Error('Server currently stopping. Cannot start it.')
    }
    if (this.currentStatus === 'running') {
      return 'running'
    }
    if (this.desiredStatus === 'running') {
      throw new Error('Server startup already requested')
    }

    this.desiredStatus = 'running'
    this.setStatus('starting')
    try {
      this.appLogger.info(`trying to start ${this.name} service`, this.name)
      const trackedProcess = await this.spawnAPIProcess()
      this.encapsulatedProcess = trackedProcess.process
      this.pipeProcessLogs(trackedProcess.process)
      if (await this.listenServerReady(trackedProcess.didProcessExitEarlyTracker)) {
        this.currentStatus = 'running'
        this.appLogger.info(`started server ${this.name} on ${this.baseUrl}`, this.name)
        this.isSetUp = true
      } else {
        this.currentStatus = 'failed'
        this.desiredStatus = 'failed'
        this.isSetUp = false
        this.appLogger.error(`server ${this.name} failed to boot`, this.name)
        this.encapsulatedProcess?.kill()
      }
    } catch (error) {
      this.appLogger.error(`failed to start server due to ${error}`, this.name)
      this.currentStatus = 'failed'
      this.desiredStatus = 'failed'
      this.isSetUp = false
      this.encapsulatedProcess?.kill()
      this.encapsulatedProcess = null
    } finally {
      this.win.webContents.send('serviceInfoUpdate', this.get_info())
    }
    return this.currentStatus
  }

  async stop(): Promise<BackendStatus> {
    this.appLogger.info(
      `Stopping backend ${this.name}. It was in state ${this.currentStatus}`,
      this.name,
    )
    this.desiredStatus = 'stopped'
    this.setStatus('stopping')
    this.encapsulatedProcess?.kill()
    await new Promise((resolve) => {
      setTimeout(() => {
        resolve('killedprocess (hopefully)')
      }, 1000)
    })

    this.encapsulatedProcess = null
    this.setStatus('stopped')
    return 'stopped'
  }

  async uninstall(): Promise<void> {
    await this.stop()
    this.appLogger.info(`removing Ollama service directory`, this.name)
    await filesystem.remove(this.serviceDir)
    this.appLogger.info(`removed Ollama service directory`, this.name)
    this.setStatus('notInstalled')
    this.isSetUp = false
  }

  pipeProcessLogs(process: ChildProcess) {
    process.stdout!.on('data', (message) => {
      if (message.toString().startsWith('INFO')) {
        this.appLogger.info(`${message}`, this.name)
      } else if (message.toString().startsWith('WARN')) {
        this.appLogger.warn(`${message}`, this.name)
      } else {
        this.appLogger.info(`${message}`, this.name)
      }
    })

    process.stderr!.on('data', (message) => {
      this.appLogger.error(`${message}`, this.name)
    })
    process.on('error', (message) => {
      this.appLogger.error(
        `backend process ${this.name} exited abruptly due to : ${message}`,
        this.name,
      )
    })
  }

  async listenServerReady(didProcessExitEarlyTracker: Promise<boolean>): Promise<boolean> {
    const startTime = performance.now()
    const processStartupCompletePromise = new Promise<boolean>(async (resolve) => {
      const queryIntervalMs = 250
      const startupPeriodMaxMs = 300000
      while (performance.now() < startTime + startupPeriodMaxMs) {
        try {
          const serviceHealthResponse = await fetch(this.healthEndpointUrl)
          this.appLogger.info(`received response: ${serviceHealthResponse.status}`, this.name)
          if (serviceHealthResponse.status === 200) {
            const endTime = performance.now()
            this.appLogger.info(
              `${this.name} server startup complete after ${(endTime - startTime) / 1000} seconds`,
              this.name,
            )
            resolve(true)
            break
          }
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (e: unknown) {
          //fetch will simply fail while server not up
        }
        await new Promise<void>((resolve) => setTimeout(resolve, queryIntervalMs))
      }
      if (performance.now() >= startTime + startupPeriodMaxMs) {
        this.appLogger.warn(
          `Server ${this.name} did not return healthy response within ${startupPeriodMaxMs / 1000} seconds`,
          this.name,
        )
        resolve(false)
      }
    })

    const processStartupFailedDueToEarlyExit = didProcessExitEarlyTracker.then(
      (earlyExit) => !earlyExit,
    )

    return await Promise.race([processStartupFailedDueToEarlyExit, processStartupCompletePromise])
  }
}
