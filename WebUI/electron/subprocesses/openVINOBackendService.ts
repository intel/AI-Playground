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
import { installBackend } from './uvBasedBackends/uv.ts'
import { binary, extract } from './tools.ts'

const execAsync = promisify(exec)

interface OvmsServerProcess {
  process: ChildProcess
  port: number
  modelRepoId: string
  type: 'llm' | 'embedding' | 'transcription' | 'image_generation'
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
  readonly pythonEnvDir: string
  readonly detectDevicesScript: string

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
  private ovmsImageProcess: OvmsServerProcess | null = null
  private currentModel: string | null = null
  private currentContextSize: number | null = null
  private currentEmbeddingModel: string | null = null
  private currentTranscriptionModel: string | null = null
  private currentImageModel: string | null = null
  private currentImageResolution: string | null = null

  // Store last startup error details for persistence
  private lastStartupErrorDetails: ErrorDetails | null = null

  // Cached installed version for inclusion in service info updates
  private cachedInstalledVersion: { version: string; releaseTag?: string } | undefined = undefined

  // Logger
  readonly appLogger = appLoggerInstance

  private version = '2026.1.0'
  private releaseTag: string | undefined = '72cc0624'

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
    // On Windows the binary sits at the OVMS root; on Linux/macOS it lives under bin/
    const ovmsExe = process.platform === 'win32' ? 'ovms.exe' : path.join('bin', binary('ovms'))
    this.ovmsExePath = path.resolve(path.join(this.ovmsDir, ovmsExe))
    const archiveName = process.platform === 'win32' ? 'ovms.zip' : 'ovms.tar.gz'
    this.zipPath = path.resolve(path.join(this.serviceDir, archiveName))
    this.pythonEnvDir = path.resolve(path.join(this.serviceDir, '.venv'))
    this.detectDevicesScript = path.resolve(path.join(this.serviceDir, 'detect_devices.py'))

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

  /**
   * Return process.env with inherited Python/virtualenv variables removed.
   * When AI Playground is launched from a shell with another venv active
   * (e.g. ComfyUI's .venv), variables like VIRTUAL_ENV / PYTHONHOME /
   * PYTHONPATH / __PYVENV_LAUNCHER__ leak into any Python we spawn and break it
   * with "failed to get the Python codec of the filesystem encoding".
   */
  private stripInheritedPythonEnv(): {
    cleanEnv: NodeJS.ProcessEnv
    inheritedVirtualEnv?: string
  } {
    const {
      VIRTUAL_ENV: inheritedVirtualEnv,
      PYTHONPATH: _pythonPath,
      PYTHONHOME: _pythonHome,
      PYTHONSTARTUP: _pythonStartup,
      PYTHONEXECUTABLE: _pythonExecutable,
      __PYVENV_LAUNCHER__: _pyvenvLauncher,
      ...cleanEnv
    } = process.env
    return { cleanEnv, inheritedVirtualEnv }
  }

  /**
   * Drop any foreign virtualenv bin/Scripts directories from a PATH string so a
   * spawned interpreter can't resolve `python`/`python3` to the wrong venv.
   */
  private sanitizeForeignVenvFromPath(pathStr: string | undefined, activeVenv?: string): string {
    const venvBinDirs = new Set<string>()
    if (activeVenv) {
      venvBinDirs.add(path.normalize(path.join(activeVenv, 'bin')))
      venvBinDirs.add(path.normalize(path.join(activeVenv, 'Scripts')))
    }
    const looksLikeVenvBin = (p: string) => /[\\/](?:\.venv|venv)[\\/](?:bin|Scripts)$/.test(p)
    return (pathStr ?? '')
      .split(path.delimiter)
      .filter((p) => {
        if (!p) return false
        const normalized = path.normalize(p)
        return !venvBinDirs.has(normalized) && !looksLikeVenvBin(normalized)
      })
      .join(path.delimiter)
  }

  /**
   * Build the environment used to spawn the OVMS executable.
   * Cross-platform: Windows resolves DLLs from PATH, Linux resolves shared
   * objects (libopenvino, libtbb, Level Zero GPU libs, ...) from LD_LIBRARY_PATH.
   */
  private buildOvmsEnv(): NodeJS.ProcessEnv {
    // Set up environment variables as per setupvars.ps1 / setupvars.sh
    const pythonDir = path.join(this.ovmsDir, 'python')
    const scriptsDir = path.join(pythonDir, process.platform === 'win32' ? 'Scripts' : 'bin')

    const { cleanEnv, inheritedVirtualEnv } = this.stripInheritedPythonEnv()
    const sanitizedInheritedPath = this.sanitizeForeignVenvFromPath(
      cleanEnv.PATH,
      inheritedVirtualEnv,
    )

    if (process.platform === 'win32') {
      // Windows ships a fully self-contained CPython under ovms/python, so we
      // point PYTHONHOME at it and expose its Scripts dir on PATH.
      return {
        ...cleanEnv,
        OVMS_DIR: this.ovmsDir,
        PYTHONHOME: pythonDir,
        PATH: [this.ovmsDir, pythonDir, scriptsDir, sanitizedInheritedPath]
          .filter(Boolean)
          .join(path.delimiter),
      }
    }

    // Linux/macOS: the OVMS package does NOT bundle a complete CPython stdlib
    // (that's why the .deb depends on `python3`). Forcing PYTHONHOME=ovms/python
    // makes the embedded interpreter look for `encodings` in that incomplete
    // tree and abort with "failed to get the Python codec of the filesystem
    // encoding". Instead, leave PYTHONHOME unset so the matching system Python
    // (ubuntu24 → py3.12) provides the stdlib, and expose OVMS's own python
    // modules via PYTHONPATH.
    const ovmsPythonModuleDirs = [
      path.join(this.ovmsDir, 'lib', 'python'),
      path.join(pythonDir, 'lib', 'python'),
    ].filter((p) => filesystem.existsSync(p))

    return {
      ...cleanEnv,
      OVMS_DIR: this.ovmsDir,
      // Keep the inherited PATH (so /usr/bin/python3 is discoverable) and put
      // the OVMS bin dir first for the ovms binary's own helper executables.
      PATH: [path.join(this.ovmsDir, 'bin'), this.ovmsDir, sanitizedInheritedPath]
        .filter(Boolean)
        .join(path.delimiter),
      ...(ovmsPythonModuleDirs.length > 0 && {
        PYTHONPATH: ovmsPythonModuleDirs.join(path.delimiter),
      }),
      // Ensure a UTF-8 locale so the interpreter can load the filesystem-encoding
      // codec on minimal setups where LANG/LC_ALL may be unset.
      LANG: process.env.LANG ?? 'C.UTF-8',
      LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? 'C.UTF-8',
      LD_LIBRARY_PATH: [path.join(this.ovmsDir, 'lib'), process.env.LD_LIBRARY_PATH ?? '']
        .filter(Boolean)
        .join(':'),
    }
  }

  /**
   * Build the environment used to spawn the OpenVINO Python device-detection venv.
   * This venv (ovms-independent) has its own CPython, so we activate it via
   * VIRTUAL_ENV and must likewise strip any inherited foreign-venv pollution,
   * otherwise device detection crashes and silently hides the Intel GPU/NPU.
   */
  private buildPythonDetectionEnv(): NodeJS.ProcessEnv {
    const { cleanEnv, inheritedVirtualEnv } = this.stripInheritedPythonEnv()
    const venvBinDir = path.join(this.pythonEnvDir, process.platform === 'win32' ? 'Scripts' : 'bin')
    const sanitizedInheritedPath = this.sanitizeForeignVenvFromPath(
      cleanEnv.PATH,
      inheritedVirtualEnv,
    )

    return {
      ...cleanEnv,
      // Activate our own detection venv (its bin dir is prepended so its python
      // is the one that runs; PYTHONHOME stays unset so the venv resolves it).
      VIRTUAL_ENV: this.pythonEnvDir,
      PATH: [venvBinDir, sanitizedInheritedPath].filter(Boolean).join(path.delimiter),
      // On Linux, the OpenVINO runtime needs the Level Zero loader & Intel GPU
      // driver from the system lib dir to enumerate Intel GPUs/NPUs.
      ...(process.platform !== 'win32' && {
        LANG: process.env.LANG ?? 'C.UTF-8',
        LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? 'C.UTF-8',
        LD_LIBRARY_PATH: ['/usr/lib/x86_64-linux-gnu', process.env.LD_LIBRARY_PATH ?? '']
          .filter(Boolean)
          .join(':'),
      }),
    }
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
          this.currentEmbeddingModel !== embeddingModelName || !this.ovmsEmbeddingProcess?.isReady

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
    const defaultDevices: InferenceDevice[] = [
      { id: 'AUTO', name: 'Auto select device', selected: true },
    ]

    if (!this.isSetUp) {
      this.appLogger.info('OpenVINO not set up, using default devices', this.name)
      this.devices = defaultDevices
      this.sttDevices = [...defaultDevices]
      this.updateStatus()
      return
    }

    try {
      // Try Python-based detection first (provides full device names)
      const pythonDevices = await this.detectDevicesWithPython()
      if (pythonDevices) {
        this.applyDetectedDevices(pythonDevices)
        this.updateStatus()
        return
      }
    } catch (error) {
      this.appLogger.warn(
        `Python-based device detection failed: ${error}. Falling back to OVMS detection.`,
        this.name,
      )
    }

    // Fallback to OVMS-based detection
    try {
      const ovmsDevices = await this.detectDevicesWithOvms()
      this.applyDetectedDevices(ovmsDevices)
    } catch (error) {
      this.appLogger.error(`Failed to detect devices: ${error}`, this.name)
      // Fallback to default device on error
      this.devices = defaultDevices
      this.sttDevices = [...defaultDevices]
    }
    this.updateStatus()
  }

  /**
   * Detect devices using the OpenVINO Python script.
   * Returns array of {id, name} objects, or null if detection fails.
   */
  private async detectDevicesWithPython(): Promise<{ id: string; name: string }[] | null> {
    const pythonExe = path.join(
      this.pythonEnvDir,
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    )

    // Check if Python environment and script exist
    if (!filesystem.existsSync(pythonExe) || !filesystem.existsSync(this.detectDevicesScript)) {
      this.appLogger.info('OpenVINO Python environment not available', this.name)
      return null
    }

    this.appLogger.info('Detecting OpenVINO devices using Python script', this.name)

    return new Promise((resolve, reject) => {
      const childProcess = spawn(pythonExe, [this.detectDevicesScript], {
        cwd: this.serviceDir,
        windowsHide: true,
        env: this.buildPythonDetectionEnv(),
      })

      let stdout = ''
      let stderr = ''

      childProcess.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      childProcess.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`Python device detection process error: ${error}`, this.name)
        reject(error)
      })

      childProcess.on('exit', (code: number | null) => {
        if (code === 0) {
          try {
            const result = JSON.parse(stdout.trim())
            if (result.success && Array.isArray(result.devices)) {
              this.appLogger.info(
                `Python detected devices: ${JSON.stringify(result.devices)}`,
                this.name,
              )
              resolve(result.devices)
            } else {
              this.appLogger.warn(`Python script returned error: ${result.error}`, this.name)
              reject(new Error(result.error || 'Unknown error'))
            }
          } catch (parseError) {
            this.appLogger.error(`Failed to parse Python output: ${stdout}`, this.name)
            reject(parseError)
          }
        } else {
          this.appLogger.warn(
            `Python device detection exited with code ${code}: ${stderr}`,
            this.name,
          )
          reject(new Error(`Process exited with code ${code}`))
        }
      })

      // Timeout after 30 seconds (OpenVINO initialization can be slow)
      setTimeout(() => {
        childProcess.kill('SIGTERM')
        reject(new Error('Python device detection timed out'))
      }, 30000)
    })
  }

  /**
   * Detect devices using OVMS executable (fallback method).
   * Returns array of {id, name} objects with generic names.
   */
  private async detectDevicesWithOvms(): Promise<{ id: string; name: string }[]> {
    this.appLogger.info('Detecting OpenVINO devices using ovms.exe', this.name)

    // Get a temporary port for device detection
    const tempPort = await getPort({ port: portNumbers(57300, 57399) })

    const detectedDeviceIds = await new Promise<string[]>((resolve, reject) => {
      const args = ['--config_path', '.', '--rest_port', tempPort.toString()]

      this.appLogger.info(
        `Running device detection: ${this.ovmsExePath} ${args.join(' ')}`,
        this.name,
      )

      const childProcess = spawn(this.ovmsExePath, args, {
        cwd: this.ovmsDir,
        windowsHide: true,
        env: this.buildOvmsEnv(),
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
          this.appLogger.warn(
            `Device detection process exited with code ${code} before finding devices`,
            this.name,
          )
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

    // Map detected devices to {id, name} format with generic names
    const deviceNameMap: Record<string, string> = {
      CPU: 'CPU',
      GPU: 'GPU (Intel)',
      NPU: 'NPU (Intel)',
    }

    return detectedDeviceIds.map((deviceId) => ({
      id: deviceId,
      name: deviceNameMap[deviceId] || deviceId,
    }))
  }

  /**
   * Apply detected devices to the service state.
   */
  private applyDetectedDevices(devices: { id: string; name: string }[]): void {
    const mappedDevices: InferenceDevice[] = devices.map((device) => ({
      id: device.id,
      name: device.name,
      selected: false,
    }))

    // Create base device list with AUTO option
    const baseDevices: InferenceDevice[] = [
      { id: 'AUTO', name: 'Auto select device', selected: false },
      ...mappedDevices,
    ]

    // Helper function to select device by priority
    const selectByPriority = (
      deviceList: InferenceDevice[],
      priority: string[],
    ): InferenceDevice[] => {
      const result = deviceList.map((d) => ({ ...d, selected: false }))
      // Match by id prefix (e.g., 'GPU' matches 'GPU.0', 'GPU.1', etc.)
      const selectedDevice = priority
        .map((id) => result.find((d) => d.id === id || d.id.startsWith(`${id}.`)))
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

    this.appLogger.info(
      `Available LLM devices: ${JSON.stringify(this.devices, null, 2)}`,
      this.name,
    )
    this.appLogger.info(
      `Available STT devices: ${JSON.stringify(this.sttDevices, null, 2)}`,
      this.name,
    )
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
    if (settings.releaseTag !== undefined) {
      this.releaseTag = settings.releaseTag || undefined
      this.appLogger.info(
        `applied new OpenVINO Model Server release tag ${this.releaseTag ?? '(none)'}`,
        this.name,
      )
    }
    if (settings.version) {
      this.version = settings.version
      this.appLogger.info(`applied new OpenVINO Model Server version ${this.version}`, this.name)
    }
  }

  async getInstalledVersion(): Promise<{ version?: string; releaseTag?: string } | undefined> {
    if (!this.isSetUp) return undefined
    try {
      const result = await execAsync(`"${this.ovmsExePath}" --version`, {
        timeout: 5000,
        env: {
          ...process.env,
          // On Linux, OVMS shared libs (libtbb, libopenvino, ...) live in ovmsDir/lib
          ...(process.platform !== 'win32' && {
            LD_LIBRARY_PATH: [path.join(this.ovmsDir, 'lib'), process.env.LD_LIBRARY_PATH ?? '']
              .filter(Boolean)
              .join(':'),
          }),
        },
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

      // Install OpenVINO Python environment for device detection
      currentStep = 'install python'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'installing OpenVINO Python environment for device detection',
      }

      try {
        await installBackend('OpenVINO')
        this.appLogger.info('OpenVINO Python environment installed successfully', this.name)
      } catch (pythonError) {
        // Log but don't fail - device detection will fall back to OVMS-based detection
        this.appLogger.warn(
          `Failed to install OpenVINO Python environment: ${pythonError}. Device detection will use fallback method.`,
          this.name,
        )
      }

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'python environment setup complete',
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
    // Build an ordered list of candidate URLs to try, most-specific first.
    //
    // Windows – uses the OpenVINO toolkit storage (zip, no version in filename).
    // Linux   – GitHub Releases are canonical; toolkit storage is a fallback.
    //   GitHub/storage asset names embed the full version, e.g.:
    //     ovms_ubuntu24_2026.1.0_python_on.tar.gz
    const candidates: string[] = []
    const storageBaseUrl =
      'https://storage.openvinotoolkit.org/repositories/openvino_model_server/packages'

    if (process.platform === 'win32') {
      const versionPath = this.releaseTag
        ? `weekly/${this.version}.${this.releaseTag}`
        : this.version
      candidates.push(`${storageBaseUrl}/${versionPath}/ovms_windows_python_on.zip`)
    } else {
      // Prefer Ubuntu 24 (ships with Python). Fall back to Ubuntu 22.
      for (const distro of ['ubuntu24', 'ubuntu22']) {
        const pkg = `ovms_${distro}_${this.version}_python_on.tar.gz`

        // 1. GitHub Releases (most reliable for versioned packages)
        candidates.push(
          `https://github.com/openvinotoolkit/model_server/releases/download/v${this.version}/${pkg}`,
        )
        // 2. OpenVINO toolkit storage – weekly build
        if (this.releaseTag) {
          candidates.push(`${storageBaseUrl}/weekly/${this.version}.${this.releaseTag}/${pkg}`)
        }
        // 3. OpenVINO toolkit storage – stable
        candidates.push(`${storageBaseUrl}/${this.version}/${pkg}`)
      }
    }

    let response: Awaited<ReturnType<typeof net.fetch>> | undefined
    let downloadUrl = ''
    for (const url of candidates) {
      this.appLogger.info(`Trying OVMS download URL: ${url}`, this.name)
      const res = await net.fetch(url)
      const contentType = res.headers.get('content-type') ?? ''
      // Reject HTML responses (they indicate a 404/index page, not a real archive)
      if (res.ok && res.status === 200 && res.body && !contentType.includes('text/html')) {
        response = res
        downloadUrl = url
        break
      }
      this.appLogger.info(
        `URL ${url} returned ${res.status} / content-type: ${contentType} — skipping`,
        this.name,
      )
    }

    if (!response || !response.body) {
      throw new Error(
        `Failed to download OVMS: no valid download URL found. Tried: ${candidates.join(', ')}`,
      )
    }

    this.appLogger.info(`Downloading OVMS from ${downloadUrl}`, this.name)

    // Delete existing zip if it exists
    if (filesystem.existsSync(this.zipPath)) {
      this.appLogger.info(`Removing existing OVMS zip file`, this.name)
      filesystem.removeSync(this.zipPath)
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

    // Extract archive using the cross-platform extract helper
    // (PowerShell Expand-Archive on Windows, `tar -xf` on Linux/macOS).
    try {
      await extract(this.zipPath, this.ovmsDir)

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

      // On Linux the tar.gz may not preserve the executable bit on the binary.
      // Done after the folder-flattening above so ovmsExePath resolves correctly.
      if (process.platform !== 'win32' && filesystem.existsSync(this.ovmsExePath)) {
        await filesystem.chmod(this.ovmsExePath, 0o755)
        this.appLogger.info(`Made ovms binary executable`, this.name)
      }
    } catch (error) {
      this.appLogger.error(`Failed to extract OVMS: ${error}`, this.name)
      throw error
    }
  }

  async start(): Promise<BackendStatus> {
    if (this.settings.productMode === 'nvidia') {
      this.appLogger.info('Skipping OpenVINO start in NVIDIA mode', this.name)
      return this.currentStatus
    }

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
    await this.stopOvmsImageServer()

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
      if (this.ovmsTranscriptionProcess?.isReady && this.currentTranscriptionModel === modelName) {
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
      this.appLogger.info(
        `Transcription server started successfully for model: ${modelName}`,
        this.name,
      )
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

  /**
   * Get the image generation server URL if an image server is running
   */
  getImageServerUrl(): string | null {
    if (this.ovmsImageProcess?.isReady) {
      return `http://127.0.0.1:${this.ovmsImageProcess.port}/v3`
    }
    return null
  }

  /**
   * Start image generation server, optionally stopping the LLM server first to free GPU memory.
   * @param modelName - HuggingFace repo id (e.g. 'OpenVINO/LCM_Dreamshaper_v7-int8-ov')
   * @param keepModelsLoaded - If true, don't stop the LLM server before starting image server
   * @param resolution - Optional resolution in WxH format (e.g. '512x512'). When the selected
   *   device is NPU the pipeline must be reshaped to a static shape, so this value is required
   *   for NPU and is passed via OVMS `--resolution`. Ignored on non-NPU devices.
   */
  async startImageServer(
    modelName: string,
    keepModelsLoaded?: boolean,
    resolution?: string,
  ): Promise<void> {
    try {
      const selectedDevice = this.devices.find((d) => d.selected)?.id || 'AUTO'
      const isNpu = selectedDevice.startsWith('NPU')
      // Resolution only matters for NPU; ignore it on other devices so the model server
      // keeps a dynamic pipeline and accepts whatever resolution the client asks for.
      const effectiveResolution = isNpu ? resolution : undefined

      this.appLogger.info(
        `Starting image server for model: ${modelName}` +
          (effectiveResolution ? ` (NPU resolution: ${effectiveResolution})` : ''),
        this.name,
      )

      if (
        this.ovmsImageProcess?.isReady &&
        this.currentImageModel === modelName &&
        this.currentImageResolution === (effectiveResolution ?? null)
      ) {
        this.appLogger.info(`Image server already running with model: ${modelName}`, this.name)
        return
      }

      if (this.ovmsImageProcess) {
        await this.stopOvmsImageServer()
      }

      if (!keepModelsLoaded) {
        this.appLogger.info(
          'Stopping LLM server to free GPU memory for image generation',
          this.name,
        )
        await this.stopOvmsLlmServer()
      }

      await this.startOvmsImageServer(modelName, effectiveResolution)
      this.appLogger.info(`Image server started successfully for model: ${modelName}`, this.name)
    } catch (error) {
      this.appLogger.error(
        `Failed to start image server for model ${modelName}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  /**
   * Stop image generation server independently
   */
  async stopImageServer(): Promise<void> {
    try {
      this.appLogger.info('Stopping image server', this.name)
      await this.stopOvmsImageServer()
      this.appLogger.info('Image server stopped successfully', this.name)
    } catch (error) {
      this.appLogger.error(`Failed to stop image server: ${error}`, this.name)
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
      const maxPromptLen = contextSize ?? 8192

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
        '--cache_dir',
        'cache',
      ]

      if (selectedDevice.startsWith('NPU')) {
        args.push('--max_prompt_len', maxPromptLen.toString())
      }

      this.appLogger.info(`OVMS launch args: ${args.join(' ')}`, this.name)

      const childProcess = spawn(this.ovmsExePath, args, {
        cwd: this.ovmsDir,
        windowsHide: true,
        env: this.buildOvmsEnv(),
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
        'CLS',
        '--cache_dir',
        'cache',
      ]

      this.appLogger.info(`OVMS embedding launch args: ${args.join(' ')}`, this.name)

      const childProcess = spawn(this.ovmsExePath, args, {
        cwd: this.ovmsDir,
        windowsHide: true,
        env: this.buildOvmsEnv(),
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
        '--cache_dir',
        'cache',
      ]

      this.appLogger.info(`OVMS transcription launch args: ${args.join(' ')}`, this.name)

      const childProcess = spawn(this.ovmsExePath, args, {
        cwd: this.ovmsDir,
        windowsHide: true,
        env: this.buildOvmsEnv(),
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
        this.appLogger.info(
          `OVMS transcription server process exited with code: ${code}`,
          this.name,
        )
        if (this.ovmsTranscriptionProcess === ovmsProcess) {
          this.ovmsTranscriptionProcess = null
          this.currentTranscriptionModel = null
        }
      })

      // Wait for server to be ready
      await this.waitForServerReady(healthUrl, childProcess, 600)
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

  private async startOvmsImageServer(
    modelRepoId: string,
    resolution?: string,
  ): Promise<OvmsServerProcess> {
    try {
      const selectedDevice = this.devices.find((d) => d.selected)?.id || 'AUTO'
      const port = await getPort({ port: portNumbers(29300, 29399) })

      this.appLogger.info(
        `Starting OVMS image server for model: ${modelRepoId} on port ${port} with device ${selectedDevice}`,
        this.name,
      )

      const args = [
        '--rest_bind_address',
        '127.0.0.1',
        '--rest_port',
        port.toString(),
        '--source_model',
        modelRepoId.split('/').join('---'),
        '--model_repository_path',
        path.resolve(path.join(this.baseDir, 'models', 'openvino-image')),
        '--target_device',
        selectedDevice,
        '--task',
        'image_generation',
        '--cache_dir',
        'cache',
      ]

      // NPU requires the image generation pipeline to be reshaped to a static shape.
      // See: https://docs.openvino.ai/2025/model-server/ovms_docs_parameters.html#image-generation
      if (selectedDevice.startsWith('NPU')) {
        if (!resolution) {
          throw new Error(
            'OVMS image generation on NPU requires a static resolution but none was provided',
          )
        }
        args.push('--resolution', resolution)
      }

      this.appLogger.info(`OVMS image launch args: ${args.join(' ')}`, this.name)

      const childProcess = spawn(this.ovmsExePath, args, {
        cwd: this.ovmsDir,
        windowsHide: true,
        env: this.buildOvmsEnv(),
      })

      const healthUrl = `http://127.0.0.1:${port}/v2/health/ready`
      const ovmsProcess: OvmsServerProcess = {
        process: childProcess,
        port,
        modelRepoId,
        type: 'image_generation',
        isReady: false,
        healthEndpointUrl: healthUrl,
      }

      childProcess.stdout!.on('data', (message) => {
        this.appLogger.info(`[OVMS Image] ${message}`, this.name)
      })

      childProcess.stderr!.on('data', (message) => {
        this.appLogger.error(`[OVMS Image] ${message}`, this.name)
      })

      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`OVMS image server process error: ${error}`, this.name)
      })

      childProcess.on('exit', (code: number | null) => {
        this.appLogger.info(`OVMS image server process exited with code: ${code}`, this.name)
        if (this.ovmsImageProcess === ovmsProcess) {
          this.ovmsImageProcess = null
          this.currentImageModel = null
          this.currentImageResolution = null
        }
      })

      // Image model loading can be slow — use high maxAttempts
      await this.waitForServerReady(healthUrl, childProcess, 600)
      ovmsProcess.isReady = true

      this.ovmsImageProcess = ovmsProcess
      this.currentImageModel = modelRepoId
      this.currentImageResolution = resolution ?? null

      this.appLogger.info(`OVMS image server ready for model: ${modelRepoId}`, this.name)
      return ovmsProcess
    } catch (error) {
      this.appLogger.error(
        `Failed to start OVMS image server for model ${modelRepoId}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  private async stopOvmsImageServer(): Promise<void> {
    if (this.ovmsImageProcess) {
      this.appLogger.info(
        `Stopping OVMS image server for model: ${this.currentImageModel}`,
        this.name,
      )
      this.ovmsImageProcess.process.kill('SIGTERM')

      await new Promise<void>((resolve) => {
        const currentProcess = this.ovmsImageProcess
        const timeout = setTimeout(() => {
          if (currentProcess) {
            this.appLogger.warn(`Force killing OVMS image server process`, this.name)
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

      this.ovmsImageProcess = null
      this.currentImageModel = null
      this.currentImageResolution = null
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

  private async waitForServerReady(
    healthUrl: string,
    process: ChildProcess,
    maxAttempts = 120,
  ): Promise<void> {
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
