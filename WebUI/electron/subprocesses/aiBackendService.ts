import * as filesystem from 'fs-extra'
import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import { GitService, LongLivedPythonApiService, createEnhancedErrorDetails } from './service.ts'
import { aipgBaseDir, checkBackend, installBackend } from './uvBasedBackends/uv.ts'
import { BrowserWindow } from 'electron'
import { LocalSettings } from '../main.ts'

export type GpuHardwareDevice = {
  device: string
  name: string
  gpuDeviceId: string | null
}

export type HardwareDetectionResult = {
  success: boolean
  gpuDevices: GpuHardwareDevice[]
  error?: string
}

export class AiBackendService extends LongLivedPythonApiService {
  isSetUp: boolean = false
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
  readonly serviceFolder = 'service'
  readonly baseDir = path.resolve(path.join(aipgBaseDir, this.serviceFolder))
  readonly serviceDir = this.baseDir
  readonly pythonEnvDir = path.resolve(path.join(this.serviceDir, '.venv'))
  devices: InferenceDevice[] = [{ id: '*', name: 'Auto select device', selected: true }]
  readonly git = new GitService()

  readonly isRequired = true
  healthEndpointUrl = `${this.baseUrl}/healthy`
  async serviceIsSetUp() {
    const result = await checkBackend('service')
      .then(() => true)
      .catch(() => false)
    this.appLogger.info(`Service ${this.name} isSetUp: ${result}`, this.name)
    return result
  }

  async detectDevices() {}

  async detectHardwareDevices(): Promise<HardwareDetectionResult> {
    const pythonExe = path.join(
      this.pythonEnvDir,
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    )
    const detectScript = path.join(this.serviceDir, 'detect_hardware.py')

    if (!filesystem.existsSync(pythonExe) || !filesystem.existsSync(detectScript)) {
      this.appLogger.info('Python environment or detect_hardware.py not available', this.name)
      return { success: false, gpuDevices: [], error: 'Detection script not available' }
    }

    this.appLogger.info('Detecting GPU hardware using OpenVINO', this.name)

    return new Promise((resolve) => {
      const childProcess = spawn(pythonExe, [detectScript], {
        cwd: this.serviceDir,
        windowsHide: true,
        env: {
          ...process.env,
          VIRTUAL_ENV: this.pythonEnvDir,
          PATH: `${path.join(this.pythonEnvDir, 'Scripts')};${path.join(this.pythonEnvDir, 'bin')};${process.env.PATH}`,
          PYTHONNOUSERSITE: 'true',
        },
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
        this.appLogger.error(`Hardware detection process error: ${error}`, this.name)
        resolve({ success: false, gpuDevices: [], error: error.message })
      })

      childProcess.on('exit', (code: number | null) => {
        if (code === 0) {
          try {
            const result = JSON.parse(stdout.trim())
            if (result.success && Array.isArray(result.gpuDevices)) {
              this.appLogger.info(
                `Hardware detection found GPUs: ${JSON.stringify(result.gpuDevices)}`,
                this.name,
              )
              resolve({ success: true, gpuDevices: result.gpuDevices })
            } else {
              this.appLogger.warn(`Hardware detection script error: ${result.error}`, this.name)
              resolve({ success: false, gpuDevices: [], error: result.error })
            }
          } catch (_parseError) {
            this.appLogger.error(`Failed to parse hardware detection output: ${stdout}`, this.name)
            resolve({ success: false, gpuDevices: [], error: 'Failed to parse output' })
          }
        } else {
          this.appLogger.warn(`Hardware detection exited with code ${code}: ${stderr}`, this.name)
          resolve({ success: false, gpuDevices: [], error: `Process exited with code ${code}` })
        }
      })

      setTimeout(() => {
        childProcess.kill('SIGTERM')
        resolve({ success: false, gpuDevices: [], error: 'Hardware detection timed out' })
      }, 30000)
    })
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

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    const pathSep = process.platform === 'win32' ? ';' : ':'
    const additionalEnvVariables = {
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
      HF_ENDPOINT: this.settings.huggingfaceEndpoint,
      PIP_CONFIG_FILE: 'nul',
    }

    const pythonBinary = path.join(
      this.pythonEnvDir,
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python',
    )
    const apiProcess = spawn(pythonBinary, ['web_api.py', '--port', this.port.toString()], {
      cwd: this.serviceDir,
      windowsHide: true,
      env: Object.assign(process.env, additionalEnvVariables),
    })

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
