import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'fs'
import * as filesystem from 'fs-extra'
import { existingFileOrError } from './osProcessHelper.ts'
import { updateIntelWorkflows } from './updateIntelWorkflows.ts'
import {
  LsLevelZeroService,
  LongLivedPythonApiService,
  aiBackendServiceDir,
  GitService,
} from './service.ts'

export class ComfyUiBackendService extends LongLivedPythonApiService {
  readonly isRequired = false
  readonly serviceDir = path.resolve(path.join(this.baseDir, 'ComfyUI'))
  readonly pythonEnvDir = path.resolve(path.join(this.baseDir, `comfyui-backend-env`))
  readonly lsLevelZeroDir = this.pythonEnvDir
  readonly lsLevelZero = new LsLevelZeroService(this.lsLevelZeroDir)
  readonly uvPip = this.lsLevelZero.uvPip
  readonly git = new GitService()
  healthEndpointUrl = `${this.baseUrl}/queue`

  private readonly remoteUrl = 'https://github.com/comfyanonymous/ComfyUI.git'
  private readonly revision = '61b5072'
  private readonly comfyUIStartupParameters = this.settings.comfyUiParameters
    ? this.settings.comfyUiParameters
    : ['--lowvram', '--disable-ipex-optimize', '--bf16-unet', '--reserve-vram', '5.0']

  serviceIsSetUp(): boolean {
    return filesystem.existsSync(this.pythonEnvDir) && filesystem.existsSync(this.serviceDir)
  }

  isSetUp = this.serviceIsSetUp()

  async *set_up(): AsyncIterable<SetupProgress> {
    this.appLogger.info('setting up service', this.name)
    this.setStatus('installing')

    const checkServiceDir = async (): Promise<boolean> => {
      if (!filesystem.existsSync(this.serviceDir)) {
        return false
      }

      // Check if it's a valid git repo
      try {
        await this.git.run(['-C', this.serviceDir, 'status'])
      } catch (_e) {
        try {
          filesystem.removeSync(this.serviceDir)
        } finally {
          return false
        }
      }

      return true
    }

    const setupComfyUiBaseService = async (): Promise<void> => {
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

      await this.lsLevelZero.ensureInstalled()
      await this.git.ensureInstalled()

      yield {
        serviceName: this.name,
        step: `Detecting intel device`,
        status: 'executing',
        debugMessage: `Trying to identify intel hardware`,
      }
      const deviceArch = await this.lsLevelZero.detectDevice()
      yield {
        serviceName: this.name,
        step: `Detecting intel device`,
        status: 'executing',
        debugMessage: `detected intel hardware ${deviceArch}`,
      }

      yield {
        serviceName: this.name,
        step: `install dependencies`,
        status: 'executing',
        debugMessage: `installing dependencies`,
      }
      const deviceSpecificRequirements = existingFileOrError(
        path.join(aiBackendServiceDir(), `requirements-${deviceArch}.txt`),
      )
      await this.uvPip.pip.run(['install', '-r', deviceSpecificRequirements])
      if (deviceArch === 'bmg' || deviceArch === 'arl_h') {
        const intelSpecificExtension = existingFileOrError(this.getIPEXWheelPath(deviceArch))
        await this.uvPip.pip.run(['install', intelSpecificExtension])
      }
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
      SYCL_ENABLE_DEFAULT_CONTEXTS: '1',
      SYCL_CACHE_PERSISTENT: '1',
      PYTHONIOENCODING: 'utf-8',
      ...(await this.lsLevelZero.getDeviceSelectorEnv()),
    }

    const parameters = [
      'main.py',
      '--port',
      this.port.toString(),
      '--preview-method',
      'auto',
      '--output-directory',
      '../service/static/sd_out',
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
