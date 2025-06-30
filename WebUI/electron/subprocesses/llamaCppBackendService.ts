import { app } from 'electron'
import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import * as filesystem from 'fs-extra'
import { existingFileOrError } from './osProcessHelper.ts'
import { UvPipService, LongLivedPythonApiService, PythonService } from './service.ts'
import { detectLevelZeroDevices, levelZeroDeviceSelectorEnv } from './deviceDetection.ts'

const serviceFolder = 'LlamaCPP'
export class LlamaCppBackendService extends LongLivedPythonApiService {
  readonly serviceDir = path.resolve(path.join(this.baseDir, serviceFolder))
  readonly pythonEnvDir = path.resolve(path.join(this.baseDir, `llama-cpp-env`)) 
  // using ls_level_zero from default ai-backend env to avoid oneAPI dep conflicts
  devices: InferenceDevice[] = [{ id: 'AUTO', name: 'Auto select device', selected: true }]
  readonly isRequired = false

  healthEndpointUrl = `${this.baseUrl}/health`

  readonly uvPip = new UvPipService(this.pythonEnvDir, serviceFolder)
  readonly aiBackend = new PythonService(path.resolve(path.join(this.baseDir, `ai-backend-env`)), path.resolve(path.join(this.baseDir, `service`)))
  readonly python = this.uvPip.python

  serviceIsSetUp(): boolean {
    return filesystem.existsSync(this.python.getExePath())
  }

  isSetUp = this.serviceIsSetUp()

  async detectDevices() {
    const availableDevices = await detectLevelZeroDevices(this.aiBackend)
    this.appLogger.info(`detected devices: ${JSON.stringify(availableDevices, null, 2)}`, this.name)
    this.devices = availableDevices.map((d) => ({ ...d, selected: d.id == '0' }))
  }

  async *set_up(): AsyncIterable<SetupProgress> {
    this.setStatus('installing')
    this.appLogger.info('setting up service', this.name)

    try {
      yield {
        serviceName: this.name,
        step: 'start',
        status: 'executing',
        debugMessage: 'starting to set up python environment',
      }
      await this.uvPip.ensureInstalled()

      yield {
        serviceName: this.name,
        step: `install dependencies`,
        status: 'executing',
        debugMessage: `installing dependencies`,
      }
      const commonRequirements = existingFileOrError(path.join(this.serviceDir, 'requirements.txt'))
      const intelSpecificExtensionDir = app.isPackaged
        ? this.baseDir
        : path.join(__dirname, '../../external')
      const intelSpecificExtension = existingFileOrError(
        path.join(intelSpecificExtensionDir, 'llama_cpp_python-0.3.8-cp312-cp312-win_amd64.whl'),
      )
      await this.uvPip.pip.run(['install', intelSpecificExtension])
      await this.uvPip.run(['install', '-r', commonRequirements])
      yield {
        serviceName: this.name,
        step: `install dependencies`,
        status: 'executing',
        debugMessage: `dependencies installed`,
      }

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
        debugMessage: `Failed to setup python environment due to ${e}`,
      }
    }
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    const additionalEnvVariables = {
      PYTHONNOUSERSITE: 'true',
      SYCL_ENABLE_DEFAULT_CONTEXTS: '1',
      SYCL_CACHE_PERSISTENT: '1',
      PYTHONIOENCODING: 'utf-8',
      ...levelZeroDeviceSelectorEnv(this.devices.find((d) => d.selected)?.id),
    }

    const apiProcess = spawn(
      this.python.getExePath(),
      ['llama_web_api.py', '--port', this.port.toString()],
      {
        cwd: this.serviceDir,
        windowsHide: true,
        env: Object.assign(process.env, additionalEnvVariables),
      },
    )

    //must be at the same tick as the spawn function call
    //otherwise we cannot really track errors given the nature of spawn() with a longlived process
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
}
