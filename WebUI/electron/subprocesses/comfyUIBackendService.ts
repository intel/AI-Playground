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
  UvPipService,
  hijacksDir,
  installHijacks,
  patchFile,
} from './service.ts'
import { getMediaDir } from '../util.ts'
import { Arch } from './deviceArch.ts'
import { detectLevelZeroDevices, levelZeroDeviceSelectorEnv } from './deviceDetection.ts'
export class ComfyUiBackendService extends LongLivedPythonApiService {
  readonly isRequired = false
  readonly serviceFolder = 'ComfyUI'
  readonly serviceDir = path.resolve(path.join(this.baseDir, this.serviceFolder))
  readonly pythonEnvDir = path.resolve(path.join(this.baseDir, `comfyui-backend-env`))
  devices: InferenceDevice[] = [{ id: '*', name: 'Auto select device', selected: true }]
  readonly uvPip = new UvPipService(this.pythonEnvDir, this.serviceFolder)
  readonly git = new GitService()
  healthEndpointUrl = `${this.baseUrl}/queue`

  private readonly remoteUrl = 'https://github.com/comfyanonymous/ComfyUI.git'
  private revision = 'v0.3.44'

  private readonly comfyUIStartupParameters = this.settings.comfyUiParameters
    ? this.settings.comfyUiParameters
    : ['--lowvram', '--disable-ipex-optimize', '--bf16-unet', '--reserve-vram', '6.0']

  serviceIsSetUp(): boolean {
    const dirsExist =
      filesystem.existsSync(this.pythonEnvDir) &&
      filesystem.existsSync(this.serviceDir) &&
      filesystem.existsSync(hijacksDir)
    if (dirsExist) {
      setTimeout(async () => {
        const version = await this.getCurrentVersion()
        if (version) {
          this.appLogger.info(`comfyUI version ${version} detected`, this.name)
          this.revision = version
        }
      })
    }
    return dirsExist
  }

  isSetUp = this.serviceIsSetUp()

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
    const availableDevices = await detectLevelZeroDevices(this.uvPip.python)
    this.appLogger.info(`detected devices: ${JSON.stringify(availableDevices, null, 2)}`, this.name)
    this.devices = availableDevices.map((d) => ({ ...d, selected: d.id == '0' }))
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

      // Check whether all requirements are installed
      const requirementsTextPath = existingFileOrError(
        path.join(this.serviceDir, 'requirements.txt'),
      )
      try {
        await this.uvPip.checkRequirementsTxt(requirementsTextPath)
      } catch (_e) {
        await this.uvPip.run(['install', '-r', requirementsTextPath])
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
      } catch (_e) {
        this.appLogger.error('Failed to configure extra model paths for comfyUI', this.name)
        throw new Error('Failed to configure extra model paths for comfyUI')
      }
    }

    try {
      yield {
        serviceName: this.name,
        step: 'start',
        status: 'executing',
        debugMessage: 'starting to set up comfyUI environment',
      }

      await this.uvPip.ensureInstalled()
      await this.git.ensureInstalled()

      yield {
        serviceName: this.name,
        step: `Detecting intel device`,
        status: 'executing',
        debugMessage: `Trying to identify intel hardware`,
      }

      yield {
        serviceName: this.name,
        step: `install dependencies`,
        status: 'executing',
        debugMessage: `installing dependencies`,
      }
      const deviceArch = this.settings.deviceArchOverride ?? 'bmg'
      const archToRequirements = (deviceArch: Arch) => {
        switch (deviceArch) {
          case 'arl_h':
          case 'acm':
          case 'bmg':
          case 'lnl':
          case 'mtl':
            return 'xpu'
          default:
            return 'unknown'
        }
      }
      const deviceSpecificRequirements = existingFileOrError(
        path.join(aiBackendServiceDir(), `requirements-${archToRequirements(deviceArch)}.txt`),
      )
      await this.uvPip.run(['install', '-r', deviceSpecificRequirements])
      yield {
        serviceName: this.name,
        step: `install dependencies`,
        status: 'executing',
        debugMessage: `dependencies installed`,
      }

      yield {
        serviceName: this.name,
        step: `install comfyUI`,
        status: 'executing',
        debugMessage: `installing comfyUI base repo`,
      }
      await setupComfyUiBaseService()
      yield {
        serviceName: this.name,
        step: `install comfyUI`,
        status: 'executing',
        debugMessage: `installation of comfyUI base repo complete`,
      }

      yield {
        serviceName: this.name,
        step: `configure comfyUI`,
        status: 'executing',
        debugMessage: `configuring comfyUI base repo`,
      }
      await configureComfyUI()
      yield {
        serviceName: this.name,
        step: `configure comfyUI`,
        status: 'executing',
        debugMessage: `configured comfyUI base repo`,
      }
      await updateIntelWorkflows()

      this.setStatus('notYetStarted')
      yield {
        serviceName: this.name,
        step: 'end',
        status: 'success',
        debugMessage: `service set up completely`,
      }
    } catch (e) {
      this.appLogger.warn(`Set up of service failed due to ${e}`, this.name, true)
      this.appLogger.warn(`Aborting set up of ${this.name} service environment`, this.name, true)
      this.setStatus('installationFailed')
      yield {
        serviceName: this.name,
        step: 'end',
        status: 'failed',
        debugMessage: `Failed to setup comfyUI service due to ${e}`,
      }
    }
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    const additionalEnvVariables = {
      PATH: `${process.env.PATH};${path.join(this.git.dir, 'cmd')}`,
      PYTHONNOUSERSITE: 'true',
      SYCL_ENABLE_DEFAULT_CONTEXTS: '1',
      SYCL_CACHE_PERSISTENT: '1',
      PYTHONIOENCODING: 'utf-8',
      ...levelZeroDeviceSelectorEnv(this.devices.find((d) => d.selected)?.id),
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
    const apiProcess = spawn(this.uvPip.python.getExePath(), parameters, {
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
