import * as filesystem from 'fs-extra'
import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import {
  DeviceService,
  GitService,
  installHijacks,
  LongLivedPythonApiService,
  createEnhancedErrorDetails,
} from './service.ts'
import { getBestDevice } from './deviceArch.ts'
import { levelZeroDeviceSelectorEnv } from './deviceDetection.ts'
import { aipgBaseDir, checkBackend, installBackend, installWheel } from './uvBasedBackends/uv.ts'
import { BrowserWindow } from 'electron'
import { LocalSettings } from '../main.ts'

export class AiBackendService extends LongLivedPythonApiService {
  isSetUp: boolean = false
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
  readonly serviceFolder = 'service'
  readonly baseDir = path.resolve(path.join(aipgBaseDir, this.serviceFolder))
  readonly serviceDir = this.baseDir
  readonly pythonEnvDir = path.resolve(path.join(this.serviceDir, '.venv'))
  devices: InferenceDevice[] = [{ id: '*', name: 'Auto select device', selected: true }]
  readonly git = new GitService()

  readonly isRequired = true
  healthEndpointUrl = `${this.baseUrl}/healthy`
  async serviceIsSetUp() {
    const result = await checkBackend('service').then(() => true).catch(() => false)
    this.appLogger.info(`Service ${this.name} isSetUp: ${result}`, this.name)
    return result
  }
  readonly deviceService = new DeviceService()

  async detectDevices() {
  }

  async *set_up(): AsyncIterable<SetupProgress> {
    this.setStatus('installing')
    this.appLogger.info('setting up service', this.name)

    // Track the current step being executed
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
        debugMessage: `installing dependencies`,
      }      
      await installBackend(this.serviceFolder)

      this.appLogger.info('scanning for extra wheels', this.name)
      const wheelFiles = (await filesystem.readdir(this.wheelDir)).filter((e) =>
        e.endsWith('.whl'),
      )
      this.appLogger.info(`found extra wheels: ${JSON.stringify(wheelFiles)}`, this.name)
      for (const wheelFile of wheelFiles) {
        await installWheel(this.serviceFolder, path.join(this.wheelDir, wheelFile))
      }

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `dependencies installed`,
      }

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
        `${currentStep} operation`
      )

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'failed',
        debugMessage: `Failed to setup python environment due to ${e}`,
        errorDetails,
      }
    }
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    const additionalEnvVariables = {
      VIRTUAL_ENV: this.pythonEnvDir,
      PATH: `${path.join(this.pythonEnvDir, 'bin')};${path.join(this.pythonEnvDir, 'Scripts')};${path.join(this.pythonEnvDir, 'Library', 'bin')};${process.env.PATH};${path.join(this.git.dir, 'cmd')}`,
      PYTHONNOUSERSITE: 'true',
      PYTHONIOENCODING: 'utf-8',
      HF_ENDPOINT: this.settings.huggingfaceEndpoint,
      PIP_CONFIG_FILE: 'nul',
    }

    const pythonBinary = path.join(this.pythonEnvDir, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
    const apiProcess = spawn(
      pythonBinary,
      ['web_api.py', '--port', this.port.toString()],
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
