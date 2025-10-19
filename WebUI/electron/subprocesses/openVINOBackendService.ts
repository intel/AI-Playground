import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import * as filesystem from 'fs-extra'
import { existingFileOrError } from './osProcessHelper.ts'
import { UvPipService, LongLivedPythonApiService, createEnhancedErrorDetails } from './service.ts'
import { detectOpenVINODevices, openVinoDeviceSelectorEnv } from './deviceDetection.ts'

const serviceFolder = 'openVINO'
export class OpenVINOBackendService extends LongLivedPythonApiService {
  readonly serviceDir = path.resolve(path.join(this.baseDir, serviceFolder))
  readonly pythonEnvDir = path.resolve(path.join(this.baseDir, `openvino-env`))
  // using ls_level_zero from default ai-backend env to avoid oneAPI dep conflicts
  readonly lsLevelZeroDir = path.resolve(path.join(this.baseDir, 'ai-backend-env'))
  readonly isRequired = true

  private version = '2025.2.0'

  healthEndpointUrl = `${this.baseUrl}/health`

  readonly uvPip = new UvPipService(this.pythonEnvDir, serviceFolder)
  readonly python = this.uvPip.python
  devices: InferenceDevice[] = [{ id: 'AUTO', name: 'Use best device', selected: true }]
  currentContextSize: number | null = null

  serviceIsSetUp(): boolean {
    return filesystem.existsSync(this.python.getExePath())
  }

  isSetUp = this.serviceIsSetUp()

  async detectDevices() {
    const availableDevices = await detectOpenVINODevices(this.python)
    this.appLogger.info(`detected devices: ${JSON.stringify(availableDevices, null, 2)}`, this.name)
    this.devices = [
      { id: 'AUTO', name: 'Auto select device', selected: true },
      ...availableDevices.map((d) => ({ ...d, selected: d.id == '0' })),
    ]
    this.updateStatus()
  }

  getServiceForPipFreeze(): UvPipService {
    return this.uvPip
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
        debugMessage: 'starting to set up python environment',
      }
      await this.python.ensureInstalled()

      currentStep = 'install dependencies'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `installing dependencies`,
      }

      let requirementsFile = path.join(this.serviceDir, 'requirements.txt')

      this.appLogger.info(`Using OpenVINO version override: ${this.version}`, this.name)

      // Create a temporary requirements file with the specified version
      const tempRequirementsPath = path.join(this.serviceDir, 'requirements-temp.txt')
      const originalRequirements = await filesystem.readFile(requirementsFile, 'utf-8')

      // Replace openvino version in requirements
      const modifiedRequirements = originalRequirements
        .replace(/openvino[>=<~!]*[\d.]+/g, `openvino==${this.version}`)
        .replace(/openvino-genai[>=<~!]*[\d.]+/g, `openvino-genai~=${this.version}`)
        .replace(/openvino-tokenizers[>=<~!]*[\d.]+/g, `openvino-tokenizers~=${this.version}`)

      await filesystem.writeFile(tempRequirementsPath, modifiedRequirements)
      requirementsFile = tempRequirementsPath

      this.appLogger.info(
        `Created temporary requirements file with OpenVINO ${this.version}`,
        this.name,
      )

      const commonRequirements = existingFileOrError(requirementsFile)
      await this.uvPip.run(['install', '-r', commonRequirements])

      // Clean up temporary requirements file if created
      if (requirementsFile.includes('requirements-temp.txt')) {
        await filesystem.remove(requirementsFile)
        this.appLogger.info(`Cleaned up temporary requirements file`, this.name)
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
        `${currentStep} operation`,
        this.uvPip,
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

  async updateSettings(settings: ServiceSettings): Promise<void> {
    if (settings.version) {
      this.version = settings.version
      this.appLogger.info(`applied new openvino version ${this.version}`, this.name)
    }
  }

  async getSettings(): Promise<ServiceSettings> {
    this.appLogger.info(`getting openvino settings`, this.name)
    return {
      version: this.version,
      serviceName: this.name,
    }
  }

  async ensureBackendReadiness(
    llmModelName: string,
    embeddingModelName?: string,
    contextSize?: number,
  ): Promise<void> {
    this.appLogger.info(
      `Ensuring openVINO backend readiness for contextSize: ${contextSize}`,
      this.name,
    )

    try {
      // Handle context size
      if (contextSize && contextSize !== this.currentContextSize) {
        this.currentContextSize = contextSize
        await this.stop()
        await this.start()
        this.appLogger.info(`openVINO ready with context size: ${contextSize}`, this.name)
      } else {
        this.appLogger.info(`openVINO already running with context size: ${contextSize}`, this.name)
      }
    } catch (error) {
      this.appLogger.error(
        `Failed to ensure backend readiness - LLM: ${llmModelName}, Embedding: ${embeddingModelName ?? 'none'}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    const additionalEnvVariables = {
      PATH: `${path.join(this.pythonEnvDir, 'Library', 'bin')};${process.env.PATH}`,
      PYTHONNOUSERSITE: 'true',
      SYCL_ENABLE_DEFAULT_CONTEXTS: '1',
      SYCL_CACHE_PERSISTENT: '1',
      PYTHONIOENCODING: 'utf-8',
      ...(this.currentContextSize ? { MAX_PROMPT_LEN: this.currentContextSize.toString() } : {}),
      ...openVinoDeviceSelectorEnv(this.devices.find((d) => d.selected)?.id),
      PIP_CONFIG_FILE: 'nul',
    }

    const apiProcess = spawn(
      this.python.getExePath(),
      ['openvino_web_api.py', '--port', this.port.toString()],
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
