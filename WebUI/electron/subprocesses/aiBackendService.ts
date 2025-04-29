import * as filesystem from 'fs-extra'
import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import { existingFileOrError } from './osProcessHelper.ts'
import {
  DeviceService,
  GitService,
  installHijacks,
  LongLivedPythonApiService,
  UvPipService,
} from './service.ts'
import { Arch } from './deviceArch.ts'

export class AiBackendService extends LongLivedPythonApiService {
  readonly pythonEnvDir = path.resolve(path.join(this.baseDir, `${this.name}-env`))
  readonly serviceFolder = 'service'
  readonly serviceDir = path.resolve(path.join(this.baseDir, this.serviceFolder))
  readonly deviceService = new DeviceService()
  readonly git = new GitService()

  readonly isRequired = true
  readonly uvPip = new UvPipService(this.pythonEnvDir, this.serviceFolder)
  readonly pip = this.uvPip.pip
  readonly python = this.pip.python
  healthEndpointUrl = `${this.baseUrl}/healthy`
  serviceIsSetUp = () => filesystem.existsSync(this.python.getExePath())
  isSetUp = this.serviceIsSetUp()

  async *set_up(): AsyncIterable<SetupProgress> {
    this.setStatus('installing')
    this.appLogger.info('setting up service', this.name)

    try {
      yield {
        serviceName: this.name,
        step: 'start',
        status: 'executing',
        debugMessage: 'starting to set up environment',
      }
      await this.git.ensureInstalled()
      await this.uvPip.ensureInstalled()
      await this.deviceService.ensureInstalled()

      const deviceArch = await this.deviceService.getBestDeviceArch()
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
      await installHijacks()
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
      const commonRequirements = existingFileOrError(path.join(this.serviceDir, 'requirements.txt'))
      await this.uvPip.run([
        'install',
        '-r',
        commonRequirements,
        '--index-strategy',
        'unsafe-best-match',
      ])

      const ipexLlmRequirements = existingFileOrError(
        path.join(this.serviceDir, `requirements-ipex-llm.txt`),
      )
      if (deviceArch !== 'unknown') {
        await this.uvPip.run([
          'install',
          '-r',
          ipexLlmRequirements,
          '--index-strategy',
          'unsafe-best-match',
          '--prerelease=allow',
        ])
      }

      const deviceSpecificRequirements = existingFileOrError(
        path.join(this.serviceDir, `requirements-${archToRequirements(deviceArch)}.txt`),
      )
      await this.uvPip.run([
        'install',
        '-r',
        deviceSpecificRequirements,
        '--index-strategy',
        'unsafe-best-match',
        '--prerelease=allow',
        // '--force-reinstall',
      ])

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
      PATH: `${process.env.PATH};${path.join(this.git.dir, 'cmd')}`,
      SYCL_ENABLE_DEFAULT_CONTEXTS: '1',
      SYCL_CACHE_PERSISTENT: '1',
      PYTHONIOENCODING: 'utf-8',
      ...(await this.deviceService.getDeviceSelectorEnv()),
    }

    const apiProcess = spawn(
      this.python.getExePath(),
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
