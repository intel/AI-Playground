import { ChildProcess, execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
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
import { QWEN3_TTS_MODEL_REPOS } from '@/assets/js/qwen3TtsConstants'

const execFileAsync = promisify(execFile)

export class Qwen3TtsBackendService extends LongLivedPythonApiService {
  readonly serviceFolder = 'qwen3-tts'
  readonly baseDir = path.resolve(path.join(aipgBaseDir, this.serviceFolder))
  readonly serviceDir = this.baseDir
  readonly pythonEnvDir = path.resolve(path.join(this.serviceDir, '.venv'))
  devices: InferenceDevice[] = [{ id: 'cpu', name: 'CPU', selected: true }]
  // Whether detectDevices() has probed the real accelerators yet. Until it has,
  // `devices` is just the CPU placeholder, so spawnAPIProcess must not force that
  // onto the engine (it would pin CPU on a GPU box). See spawnAPIProcess.
  private devicesDetected = false
  readonly git = new GitService()

  isSetUp: boolean = false
  readonly isRequired = false
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

  /**
   * Torch accelerator variant to install. Mirrors comfyUIBackendService: CUDA in
   * NVIDIA product mode, Intel XPU on Windows, CPU elsewhere (Linux/macOS). The
   * same extra must be passed to both the install and the setup check — without
   * it, `uv sync --check` resolves the base deps (no torch) and reports a
   * spurious mismatch, and a product-mode switch (e.g. to NVIDIA) correctly
   * surfaces as "not set up" so the CUDA build gets reinstalled.
   */
  private get torchExtra(): UvExtra {
    if (this.settings.productMode === 'nvidia') return 'cuda'
    if (process.platform === 'win32') return 'xpu'
    return 'cpu'
  }

  async serviceIsSetUp(): Promise<boolean> {
    const result = await checkBackend(this.serviceFolder, this.torchExtra)
      .then(() => true)
      .catch(() => false)
    this.appLogger.info(`Service ${this.name} isSetUp: ${result}`, this.name)
    return result
  }

  private get pythonBinary(): string {
    return path.join(
      this.pythonEnvDir,
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python',
    )
  }

  /**
   * PATH/venv env needed for the venv python to import torch (native XPU/CUDA
   * DLLs live in the venv on Windows). Shared by device detection and the server
   * spawn so both resolve the same accelerator libraries.
   */
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

  /**
   * Enumerate the accelerators the TTS model can run on (Intel XPU / CUDA / CPU)
   * by probing torch inside the service venv. The device ids are valid
   * QWEN3_TTS_DEVICE strings so spawnAPIProcess passes the user's choice straight
   * through. The probe lists CPU last and any GPUs first, so we default-select
   * the best available device (GPU when present, else CPU) — no "auto" entry,
   * since CPU is always shown and a concrete default is clearer. Falls back to
   * CPU-only when the env isn't set up or the probe fails.
   */
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
        // The probe logs its enumeration reasoning to stderr — keep it in the
        // backend log so a missing GPU can be diagnosed from the driver probe.
        if (stderr.trim()) this.appLogger.info(`device probe: ${stderr.trim()}`, this.name)
        const probed = JSON.parse(stdout.trim()) as Array<{ id: string; name: string }>
        if (probed.length > 0) available = probed.map((d) => ({ ...d, selected: false }))
        this.appLogger.info(`detected TTS devices: ${JSON.stringify(probed)}`, this.name)
      }
    } catch (e) {
      this.appLogger.warn(`qwen3-tts device detection failed, defaulting to CPU: ${e}`, this.name)
      available = [{ ...cpuDevice }]
    }
    // Restore the user's persisted choice; otherwise default to the best device
    // (probe orders GPUs before CPU, so the first entry is the preferred one).
    this.devices = withSelectedDevice(
      available,
      this.settings.lastSelectedDevicePerBackend[this.name],
      (ds) => ds[0],
    )
    // Only count a real probe (isSetUp) as "detected"; a skipped probe leaves the
    // CPU placeholder and should still be re-probed before the next spawn.
    if (this.isSetUp) this.devicesDetected = true
    this.updateStatus()
  }

  async *set_up(): AsyncIterable<SetupProgress> {
    this.setStatus('installing')
    this.appLogger.info('setting up qwen3-tts service', this.name)

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

      this.appLogger.info(`installing qwen3-tts with torch extra '${this.torchExtra}'`, this.name)
      await installBackendWithExtra(this.serviceFolder, this.torchExtra)

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'dependencies installed',
      }

      // The env now exists on disk, but `isSetUp` was resolved to false when the
      // constructor ran (before this install). Flip it and re-probe the
      // accelerators now so the GPU shows up in the device picker immediately —
      // without this, detectDevices() skips the real torch probe (it is gated on
      // isSetUp) and the box stays CPU-only until the next app restart.
      this.isSetUp = true
      this.devicesDetected = false
      await this.detectDevices()

      this.setStatus('notYetStarted')
      currentStep = 'end'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'success',
        debugMessage: 'qwen3-tts service set up completely',
      }
    } catch (e) {
      this.appLogger.warn(`Set up of qwen3-tts failed due to ${e}`, this.name, true)
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
   * The local directory a downloaded Qwen3-TTS repo lives in. The standard
   * model-download popup writes HF repos into the shared TTS model dir under the
   * `owner---repo` name (see service/utils.repo_local_root_dir_name), so we mirror
   * that naming here. `from_pretrained` loads a local directory directly, so we
   * point the engine at these paths instead of letting it hit the network.
   */
  private localModelDir(repoId: string): string | undefined {
    const ttsDir = getSharedModelDir('TTS')
    if (!ttsDir) return undefined
    const dir = path.join(ttsDir, repoId.replace('/', '---'))
    return fs.existsSync(dir) ? dir : undefined
  }

  /**
   * Env pointing the engine at locally-downloaded weights, plus HF offline so the
   * sidecar never silently downloads a model — installs go through the popup only.
   */
  private get modelPathEnv(): Record<string, string> {
    const env: Record<string, string> = { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }
    const custom = this.localModelDir(QWEN3_TTS_MODEL_REPOS.customVoice)
    const voiceDesign = this.localModelDir(QWEN3_TTS_MODEL_REPOS.voiceDesign)
    if (custom) env.QWEN3_TTS_MODEL = custom
    if (voiceDesign) env.QWEN3_TTS_VOICE_DESIGN_MODEL = voiceDesign
    return env
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    this.loopbackAuthToken = randomBytes(32).toString('hex')
    // Ensure the accelerators have actually been probed before we pick a device.
    // Without this, an on-demand start that races ahead of detectDevices() would
    // see only the CPU placeholder and force QWEN3_TTS_DEVICE=cpu — pinning CPU
    // even on a machine with a usable GPU.
    if (!this.devicesDetected) await this.detectDevices()
    // Pass the user-selected accelerator through to tts_engine. Defaults to CPU
    // if nothing is marked selected; a legacy 'auto' selection is left unset so
    // the engine resolves the device itself.
    const selectedDevice = this.devices.find((d) => d.selected)?.id ?? 'cpu'
    const deviceEnv: Record<string, string> =
      selectedDevice === 'auto' ? {} : { QWEN3_TTS_DEVICE: selectedDevice }
    this.appLogger.info(`starting qwen3-tts on device: ${selectedDevice}`, this.name)
    const additionalEnvVariables: Record<string, string | undefined> = {
      ...this.venvProcessEnv,
      PIP_CONFIG_FILE: process.platform === 'win32' ? 'nul' : '/dev/null',
      AIPG_LOOPBACK_TOKEN: this.loopbackAuthToken,
      QWEN3_TTS_ATTN: 'sdpa',
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
