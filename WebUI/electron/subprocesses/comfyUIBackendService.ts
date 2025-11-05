import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'fs'
import * as filesystem from 'fs-extra'
import { existingFileOrError } from './osProcessHelper.ts'
import { updateIntelWorkflows } from './updateIntelWorkflows.ts'
import {
  LongLivedPythonApiService,
  aiBackendServiceDir,
  GitService,
  hijacksDir,
  installHijacks,
  patchFile,
  createEnhancedErrorDetails,
} from './service.ts'
import { aipgBaseDir, checkBackend, installBackend } from './uvBasedBackends/uv.ts'
import { ProcessError } from './osProcessHelper.ts'
import { getMediaDir } from '../util.ts'
import { Arch } from './deviceArch.ts'
import { detectLevelZeroDevices, levelZeroDeviceSelectorEnv } from './deviceDetection.ts'
import { BrowserWindow } from 'electron'
import { LocalSettings } from '../main.ts'
export class ComfyUiBackendService extends LongLivedPythonApiService {
  constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
    super(name, port, win, settings)
    
    this.serviceIsSetUp().then((setUp) => {
      this.isSetUp = setUp
      if (this.isSetUp) {
        this.setStatus('notYetStarted')
      }
      this.appLogger.info(`Service ${this.name} isSetUp: ${this.isSetUp}`, this.name)
    })
  }
  readonly isRequired = false
  readonly serviceFolder = 'ComfyUI'
  readonly baseDir = path.resolve(aipgBaseDir)
  readonly serviceDir = path.resolve(path.join(this.baseDir, this.serviceFolder))
  readonly pythonEnvDir = path.resolve(path.join(this.serviceDir, '.venv'))
  devices: InferenceDevice[] = [{ id: '*', name: 'Auto select device', selected: true }]
  readonly git = new GitService()
  healthEndpointUrl = `${this.baseUrl}/queue`

  private readonly remoteUrl = 'https://github.com/comfyanonymous/ComfyUI.git'
  private revision = 'v0.3.66'

  private readonly comfyUIStartupParameters = this.settings.comfyUiParameters
    ? this.settings.comfyUiParameters
    : ['--lowvram', '--disable-ipex-optimize', '--bf16-unet', '--reserve-vram', '6.0']

  async serviceIsSetUp(): Promise<boolean> {
    this.appLogger.info(`Checking if comfyUI directories exist`, this.name)
    const dirsExist =
      filesystem.existsSync(this.serviceDir)
    this.appLogger.info(`Checking if comfyUI directories exist: ${dirsExist}`, this.name)
    if (!dirsExist) return false
    
    setTimeout(async () => {
      const version = await this.getCurrentVersion()
      if (version) {
        this.appLogger.info(`comfyUI version ${version} detected`, this.name)
        this.revision = version
      }
    })

    const result = await checkBackend(this.serviceFolder).then(() => true).catch(() => false)
    this.appLogger.info(`Service ${this.name} isSetUp: ${result}`, this.name)
    return result
  }

  isSetUp = false

  async updateSettings(settings: ServiceSettings): Promise<void> {
    if (settings.version) {
      this.revision = settings.version
      this.appLogger.info(`applied new comfyUI version ${this.revision}`, this.name)
    }
  }

  async getSettings(): Promise<ServiceSettings> {
    this.appLogger.info(`getting comfyUI settings`, this.name)
    return { version: this.revision, serviceName: 'comfyui-backend' }
  }

  async getCurrentVersion(): Promise<string | undefined> {
    try {
      const gitOutput = await this.git.run(['-C', this.serviceDir, 'rev-parse', 'HEAD'])
      const versionMatch = gitOutput.match(/HEAD detached at ([0-9a-f]{7,})|v(\d+\.\d+\.\d+)/)
      if (versionMatch) {
        return versionMatch[1]
      }
    } catch (e) {
      this.appLogger.error(`failed to get comfyUI version: ${e}`, this.name)
      return undefined
    }
  }

  async detectDevices() {
    // For now, use auto-select device similar to aiBackendService
    const availableDevices = [{ id: '*', name: 'Auto select device', selected: true }]
    this.appLogger.info(`detected devices: ${JSON.stringify(availableDevices, null, 2)}`, this.name)
    this.devices = availableDevices
    this.updateStatus()
  }

  async *set_up(): AsyncIterable<SetupProgress> {
    this.appLogger.info('setting up service', this.name)
    this.setStatus('installing')

    const checkServiceDir = async (): Promise<boolean> => {
      if (!filesystem.existsSync(this.serviceDir)) {
        return false
      }

      // Check if it's a valid git repo
      try {
        const version = await this.getCurrentVersion()
        if (version === this.revision) {
          this.appLogger.info('comfyUI already cloned, skipping', this.name)
          return true
        }
        this.appLogger.info(
          `ComfyUI version ${version?.[1]} does not match ${this.revision}. Removing...`,
          this.name,
        )
        throw new Error('Version mismatch')
      } catch (_e) {
        try {
          filesystem.removeSync(this.serviceDir)
        } finally {
          return false
        }
      }
    }

    const setupComfyUiBaseService = async (): Promise<void> => {
      installHijacks()
      if (await checkServiceDir()) {
        this.appLogger.info('comfyUI already cloned, skipping', this.name)
      } else {
        await this.git.run(['clone', this.remoteUrl, this.serviceDir])
        await this.git.run(['-C', this.serviceDir, 'checkout', this.revision], {}, this.serviceDir)
      }

      // Copy ComfyUI dependency files and install using bundled uv
      const comfyUIDepsDir = path.join(aipgBaseDir, 'comfyui-deps')
      const pyprojectSource = path.join(comfyUIDepsDir, 'pyproject.toml')
      const uvLockSource = path.join(comfyUIDepsDir, 'uv.lock')
      const pyprojectTarget = path.join(this.serviceDir, 'pyproject.toml')
      const uvLockTarget = path.join(this.serviceDir, 'uv.lock')

      // Check if dependencies are already installed
      let needsInstall = false
      try {
        await checkProject(this.serviceDir)
        this.appLogger.info('ComfyUI dependencies already installed, skipping', this.name)
      } catch (_checkError) {
        needsInstall = true
      }

      if (needsInstall) {
        // Copy dependency specification files
        this.appLogger.info(
          `Copying pyproject.toml from ${pyprojectSource} to ${pyprojectTarget}`,
          this.name,
        )
        await filesystem.copyFile(pyprojectSource, pyprojectTarget)

        this.appLogger.info(`Copying uv.lock from ${uvLockSource} to ${uvLockTarget}`, this.name)
        await filesystem.copyFile(uvLockSource, uvLockTarget)

        // Install dependencies
        this.appLogger.info('Installing ComfyUI dependencies using bundled uv', this.name)
        await installBackend(this.serviceDir)
      }
    }

    const configureComfyUI = async (): Promise<void> => {
      try {
        this.appLogger.info('patching hijacks into comfyUI model_management', this.name)
        patchFile(
          path.join(this.serviceDir, 'comfy/model_management.py'),
          'from comfy.model_management import get_model',
          ['from ipex_to_cuda import ipex_init', 'ipex_init()'],
        )

        this.appLogger.info('Configuring extra model paths for comfyUI', this.name)
        const extraModelPathsYaml = path.join(this.serviceDir, 'extra_model_paths.yaml')
        const extraModelsYaml = `aipg:
  base_path: ${path.resolve(this.baseDir, 'service/models/stable_diffusion')}
  checkpoints: checkpoints
  clip: checkpoints
  vae: checkpoints
  unet: checkpoints
  loras: lora`
        fs.promises.writeFile(extraModelPathsYaml, extraModelsYaml, {
          encoding: 'utf-8',
          flag: 'w',
        })
        this.appLogger.info(
          `Configured extra model paths for comfyUI at ${extraModelPathsYaml} as ${extraModelsYaml} `,
          this.name,
        )
      } catch (configError) {
        this.appLogger.error(
          `Failed to configure extra model paths for comfyUI: ${configError}`,
          this.name,
        )
        // Re-throw ProcessError instances to preserve enhanced error details
        if (configError instanceof ProcessError) {
          throw configError
        }
        // For other errors, wrap with context
        throw new Error(`Failed to configure extra model paths for comfyUI: ${configError}`)
      }
    }

    let currentStep = 'start'

    try {
      currentStep = 'start'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'starting to set up comfyUI environment',
      }

      await this.git.ensureInstalled()

      currentStep = 'install comfyUI'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `installing comfyUI base repo`,
      }
      await setupComfyUiBaseService()
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `installation of comfyUI base repo complete`,
      }

      currentStep = 'configure comfyUI'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `configuring comfyUI base repo`,
      }
      await configureComfyUI()
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `configured comfyUI base repo`,
      }

      // Device-specific requirements and extra wheels are no longer needed
      // as uv handles all dependencies through pyproject.toml and uv.lock
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `updating workflows from intel repository`,
      }
      currentStep = 'updating workflows'
      await updateIntelWorkflows(this.settings.remoteRepository)

      this.setStatus('notYetStarted')
      currentStep = 'end'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'success',
        debugMessage: `service set up completely`,
      }
    } catch (e) {
      this.appLogger.warn(`Set up of service failed due to ${e}`, this.name, true)
      this.appLogger.warn(`Aborting set up of ${this.name} service environment`, this.name, true)
      this.setStatus('installationFailed')

      const errorDetails = await createEnhancedErrorDetails(
        e,
        `${currentStep} operation`,
      )
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'failed',
        debugMessage: `Failed to setup comfyUI service due to ${e}`,
        errorDetails,
      }
    }
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    const additionalEnvVariables = {
      PATH: `${path.join(this.pythonEnvDir, 'Library', 'bin')};${process.env.PATH};${path.join(this.git.dir, 'cmd')}`,
      PYTHONNOUSERSITE: 'true',
      SYCL_ENABLE_DEFAULT_CONTEXTS: '1',
      SYCL_CACHE_PERSISTENT: '1',
      PYTHONIOENCODING: 'utf-8',
      HF_ENDPOINT: this.settings.huggingfaceEndpoint,
      ...levelZeroDeviceSelectorEnv(this.devices.find((d) => d.selected)?.id),
      PIP_CONFIG_FILE: 'nul',
    }
    const mediaDir = getMediaDir()
    const parameters = [
      'main.py',
      '--port',
      this.port.toString(),
      '--preview-method',
      'auto',
      '--output-directory',
      mediaDir,
      ...this.comfyUIStartupParameters,
    ]
    this.appLogger.info(
      `starting comfyui with ${JSON.stringify({ parameters, additionalEnvVariables })}`,
      this.name,
      true,
    )
    const pythonBinary = path.join(
      this.pythonEnvDir,
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python'
    )
    const apiProcess = spawn(pythonBinary, parameters, {
      cwd: this.serviceDir,
      windowsHide: true,
      env: Object.assign(process.env, additionalEnvVariables),
    })

    //must be at the same tick as the spawn function call
    //otherwise we cannot really track errors given the nature of spawn() with a longlived process
    const didProcessExitEarlyTracker = new Promise<boolean>((resolve, _reject) => {
      apiProcess.on('exit', () => {
        this.appLogger.error(`encountered unexpected exit in ${this.name}.`, this.name)
        resolve(true)
      })
      apiProcess.on('error', (error) => {
        this.appLogger.error(`encountered error of process in ${this.name} : ${error}`, this.name)
        resolve(true)
      })
    })

    return {
      process: apiProcess,
      didProcessExitEarlyTracker: didProcessExitEarlyTracker,
    }
  }
}
function checkProject(serviceDir: string) {
  throw new Error('Function not implemented.')
}

