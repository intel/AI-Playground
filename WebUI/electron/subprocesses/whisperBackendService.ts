import { ChildProcess, execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'
import { BrowserWindow } from 'electron'
import { LocalSettings } from '../main.ts'
import { getSharedModelDir } from '../pathsManager.ts'
import { GitService, LongLivedPythonApiService, createEnhancedErrorDetails } from './service.ts'
import {
  aipgBaseDir,
  checkBackend,
  installBackendWithExtra,
  type UvExtra,
} from './uvBasedBackends/uv.ts'
import { levelZeroDeviceSelectorEnv, withSelectedDevice } from './deviceDetection.ts'

const execFileAsync = promisify(execFile)

/**
 * Standalone Whisper speech-to-text sidecar. Runs Whisper on torch (Intel XPU /
 * NVIDIA CUDA / CPU) via transformers, so it works in every product mode — unlike
 * the OVMS Whisper engine, which needs OpenVINO. Mirrors {@link Qwen3TtsBackendService}.
 */
export class WhisperBackendService extends LongLivedPythonApiService {
  readonly serviceFolder = 'whisper-backend'
  readonly baseDir = path.resolve(path.join(aipgBaseDir, this.serviceFolder))
  readonly serviceDir = this.baseDir
  readonly pythonEnvDir = path.resolve(path.join(this.serviceDir, '.venv'))
  devices: InferenceDevice[] = [{ id: 'cpu', name: 'CPU', selected: true }]
  private devicesDetected = false
  readonly git = new GitService()

  isSetUp: boolean = false
  readonly isRequired = false
  // Started on first transcribe, not at boot or install, so idle VRAM stays free.
  healthEndpointUrl = `${this.baseUrl}/healthy`

  private loopbackAuthToken: string = randomBytes(32).toString('hex')

  getLoopbackAuthToken(): string {
    return this.loopbackAuthToken
  }

  constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
    super(name, port, win, settings)

    this.serviceIsSetUp().then(async (setUp) => {
      this.isSetUp = setUp
      if (this.isSetUp) {
        await this.updateCachedVersion()
        this.setStatus('notYetStarted')
      }
      this.appLogger.info(`Service ${this.name} isSetUp: ${this.isSetUp}`, this.name)
    })
  }

  /** CUDA in NVIDIA product mode, Intel XPU on Windows, CPU elsewhere. */
  private get torchExtra(): UvExtra {
    if (this.settings.productMode === 'nvidia') return 'cuda'
    if (process.platform === 'win32') return 'xpu'
    return 'cpu'
  }

  async serviceIsSetUp(): Promise<boolean> {
    const lockOk = await checkBackend(this.serviceFolder, this.torchExtra)
      .then(() => true)
      .catch(() => false)
    // `uv sync --check` can report the venv as in-sync even when torch is not
    // actually importable — e.g. an app reinstall breaks the clone/hardlinked
    // torch wheel files while their dist-info lingers, so the lockfile check
    // still "sees" torch. transcription_engine.py imports torch lazily, so
    // /healthy comes up regardless and the failure would only surface on the
    // first transcription. Confirm torch is genuinely importable so the wizard /
    // backend management screen reflect reality and offer a reinstall.
    const torchOk = lockOk ? await this.torchImportable() : false
    const result = lockOk && torchOk
    this.appLogger.info(
      `Service ${this.name} isSetUp: ${result} (lockOk=${lockOk}, torchOk=${torchOk})`,
      this.name,
    )
    return result
  }

  /**
   * Whether the venv's own Python can `import torch` — see `venvCanImportModule`.
   * Reuses the result of the probe the start guard already ran, if any: spawning
   * python to import torch costs seconds, and `assertReadyToStart` would otherwise
   * pay it twice (once itself, once through `serviceIsSetUp`).
   */
  private async torchImportable(): Promise<boolean> {
    return this.torchProbeForStartGuard ?? this.venvCanImportModule('torch', this.venvProcessEnv)
  }

  /** Set only for the duration of one `assertReadyToStart` call. */
  private torchProbeForStartGuard: boolean | null = null

  private get pythonBinary(): string {
    return path.join(
      this.pythonEnvDir,
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python',
    )
  }

  private get venvProcessEnv(): Record<string, string | undefined> {
    const pathSep = process.platform === 'win32' ? ';' : ':'
    return {
      VIRTUAL_ENV: this.pythonEnvDir,
      PATH: [
        path.join(this.pythonEnvDir, 'bin'),
        path.join(this.pythonEnvDir, 'Scripts'),
        path.join(this.pythonEnvDir, 'Library', 'bin'),
        process.env.PATH,
        path.join(this.git.dir, 'cmd'),
      ].join(pathSep),
      PYTHONNOUSERSITE: 'true',
      PYTHONIOENCODING: 'utf-8',
    }
  }

  /** Enumerate torch accelerators (XPU / CUDA / CPU) via list_devices.py. */
  async detectDevices(): Promise<void> {
    const cpuDevice: InferenceDevice = { id: 'cpu', name: 'CPU', selected: false }
    let available: InferenceDevice[] = [{ ...cpuDevice }]
    try {
      if (this.isSetUp) {
        const { stdout, stderr } = await execFileAsync(this.pythonBinary, ['list_devices.py'], {
          cwd: this.serviceDir,
          env: {
            ...process.env,
            ...this.venvProcessEnv,
            ...levelZeroDeviceSelectorEnv('*'),
            SYCL_ENABLE_DEFAULT_CONTEXTS: '1',
            SYCL_CACHE_PERSISTENT: '1',
          },
          timeout: 30000,
        })
        if (stderr.trim()) this.appLogger.info(`device probe: ${stderr.trim()}`, this.name)
        const probed = JSON.parse(stdout.trim()) as Array<{ id: string; name: string }>
        if (probed.length > 0) available = probed.map((d) => ({ ...d, selected: false }))
        this.appLogger.info(`detected Whisper devices: ${JSON.stringify(probed)}`, this.name)
      }
    } catch (e) {
      this.appLogger.warn(`whisper device detection failed, defaulting to CPU: ${e}`, this.name)
      available = [{ ...cpuDevice }]
    }
    this.devices = withSelectedDevice(
      available,
      this.settings.lastSelectedDevicePerBackend[this.name],
      (ds) => ds[0],
    )
    if (this.isSetUp) this.devicesDetected = true
    this.updateStatus()
  }

  async *set_up(): AsyncIterable<SetupProgress> {
    this.setStatus('installing')
    this.appLogger.info('setting up whisper service', this.name)

    let currentStep = 'start'

    try {
      currentStep = 'start'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'starting to set up environment',
      }

      await this.git.ensureInstalled()

      currentStep = 'install dependencies'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'installing dependencies (torch may take several minutes)',
      }

      // Always install into a fresh venv — see `prepareCleanPythonEnv`. Without
      // this, a repair over a venv whose torch files are broken but whose
      // dist-info survived is a no-op that reports success and fails again on the
      // first transcription.
      await this.prepareCleanPythonEnv()

      this.appLogger.info(`installing whisper with torch extra '${this.torchExtra}'`, this.name)
      await installBackendWithExtra(this.serviceFolder, this.torchExtra)

      // Fail loudly if torch still isn't importable after the install, rather than
      // reporting success and letting the backend die on the first transcription.
      if (!(await this.torchImportable())) {
        throw new Error(
          'Speech To Text dependencies installed but PyTorch is still not importable in the environment.',
        )
      }

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'dependencies installed',
      }

      this.isSetUp = true
      this.devicesDetected = false
      await this.detectDevices()

      this.setStatus('notYetStarted')
      currentStep = 'end'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'success',
        debugMessage: 'whisper service set up completely',
      }
    } catch (e) {
      this.appLogger.warn(`Set up of whisper failed due to ${e}`, this.name, true)
      this.setStatus('installationFailed')

      const errorDetails = await createEnhancedErrorDetails(e, `${currentStep} operation`)

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'failed',
        debugMessage: `Failed to setup python environment due to ${e}`,
        errorDetails,
      }
    }
  }

  /**
   * Env pointing the engine at the shared STT model dir (so it can resolve the
   * per-repo local weights the download popup writes there) plus HF offline so the
   * sidecar never silently downloads — installs go through the popup only.
   */
  private get modelPathEnv(): Record<string, string> {
    const env: Record<string, string> = { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }
    const sttDir = getSharedModelDir('STT')
    if (sttDir) env.WHISPER_MODEL_DIR = sttDir
    return env
  }

  /**
   * The Flask health endpoint comes up even when torch is missing, because
   * transcription_engine.py imports torch lazily on the first transcription — so a
   * broken env yields a running server that later dies with
   * `ModuleNotFoundError: torch`. `uv sync --check --extra <x>` has proven
   * unreliable at flagging this (it can report the venv as in-sync while the
   * accelerator torch wheel, behind an extra + platform markers, is not actually
   * installed), so probe the exact thing that fails at transcription time first,
   * then still defer to the base readiness contract. A false result throws, which
   * runStartup surfaces as a 'failed' status the setup wizard / backend management
   * screen offer to reinstall.
   */
  protected async assertReadyToStart(): Promise<void> {
    if (!(await this.torchImportable())) {
      this.isSetUp = false
      this.appLogger.warn(
        'whisper start guard: torch not importable in venv, blocking start',
        this.name,
      )
      throw new Error(
        'The Speech To Text (Whisper) environment is incomplete — its Python dependencies (including PyTorch) are not installed. Reinstall the Speech To Text backend to finish provisioning it.',
      )
    }
    // The base check runs serviceIsSetUp, which probes torch again; the probe we
    // just did is still valid for this start attempt.
    this.torchProbeForStartGuard = true
    try {
      await super.assertReadyToStart()
    } finally {
      this.torchProbeForStartGuard = null
    }
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    this.loopbackAuthToken = randomBytes(32).toString('hex')
    if (!this.devicesDetected) await this.detectDevices()
    const selectedDevice = this.devices.find((d) => d.selected)?.id ?? 'cpu'
    const deviceEnv: Record<string, string> =
      selectedDevice === 'auto' ? {} : { WHISPER_DEVICE: selectedDevice }
    this.appLogger.info(`starting whisper on device: ${selectedDevice}`, this.name)
    const additionalEnvVariables: Record<string, string | undefined> = {
      ...this.venvProcessEnv,
      PIP_CONFIG_FILE: process.platform === 'win32' ? 'nul' : '/dev/null',
      AIPG_LOOPBACK_TOKEN: this.loopbackAuthToken,
      SYCL_ENABLE_DEFAULT_CONTEXTS: '1',
      SYCL_CACHE_PERSISTENT: '1',
      ...levelZeroDeviceSelectorEnv('*'),
      ...this.modelPathEnv,
      ...deviceEnv,
    }

    const apiProcess = spawn(this.pythonBinary, ['web_api.py', '--port', this.port.toString()], {
      cwd: this.serviceDir,
      windowsHide: true,
      env: { ...process.env, ...additionalEnvVariables },
    })

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
      didProcessExitEarlyTracker,
    }
  }
}
