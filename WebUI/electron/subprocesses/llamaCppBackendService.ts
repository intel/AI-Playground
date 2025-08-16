import { ChildProcess, exec, spawn } from 'node:child_process'
import path from 'node:path'
import * as filesystem from 'fs-extra'
import { existingFileOrError } from './osProcessHelper.ts'
import { UvPipService, LongLivedPythonApiService, PythonService } from './service.ts'
import { detectLevelZeroDevices, levelZeroDeviceSelectorEnv } from './deviceDetection.ts'
import { promisify } from 'node:util'
import { net } from 'electron'
import getPort, { portNumbers } from 'get-port'
const execAsync = promisify(exec)

interface LlamaServerProcess {
  process: ChildProcess
  port: number
  modelPath: string
  modelRepoId: string
  type: 'llm' | 'embedding'
  isReady: boolean
}

const serviceFolder = 'LlamaCPP'
export class LlamaCppBackendService extends LongLivedPythonApiService {
  readonly serviceDir = path.resolve(path.join(this.baseDir, serviceFolder))
  readonly pythonEnvDir = path.resolve(path.join(this.baseDir, `llama-cpp-env`))
  // using ls_level_zero from default ai-backend env to avoid oneAPI dep conflicts
  devices: InferenceDevice[] = [{ id: 'AUTO', name: 'Auto select device', selected: true }]
  readonly isRequired = false

  private version = 'b6178'

  healthEndpointUrl = `${this.baseUrl}/health`

  private llamaLlmProcess: LlamaServerProcess | null = null
  private llamaEmbeddingProcess: LlamaServerProcess | null = null
  private currentLlmModel: string | null = null
  private currentContextSize: number | null = null
  private currentEmbeddingModel: string | null = null

  private lastPythonWrapperLlmPort: number | null = null
  private lastPythonWrapperEmbeddingPort: number | null = null

  readonly uvPip = new UvPipService(this.pythonEnvDir, serviceFolder)
  readonly aiBackend = new PythonService(
    path.resolve(path.join(this.baseDir, `ai-backend-env`)),
    path.resolve(path.join(this.baseDir, `service`)),
  )
  readonly python = this.uvPip.python
  readonly llamaCppRestDir = path.resolve(path.join(this.pythonEnvDir, 'llama-cpp-rest'))
  readonly llamaCppRestExePath = path.resolve(path.join(this.llamaCppRestDir, 'llama-server.exe'))
  readonly zipPath = path.resolve(path.join(this.pythonEnvDir, 'llama-cpp-release.zip'))

  serviceIsSetUp(): boolean {
    return (
      filesystem.existsSync(this.python.getExePath()) &&
      filesystem.existsSync(this.llamaCppRestExePath)
    )
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
      await this.uvPip.run(['install', '-r', commonRequirements])
      yield {
        serviceName: this.name,
        step: `install dependencies`,
        status: 'executing',
        debugMessage: `dependencies installed`,
      }

      // Download Llamacpp ZIP file
      yield {
        serviceName: this.name,
        step: 'download',
        status: 'executing',
        debugMessage: `downloading Llamacpp`,
      }

      await this.downloadLlamacpp()

      yield {
        serviceName: this.name,
        step: 'download',
        status: 'executing',
        debugMessage: 'download complete',
      }

      // Extract Llamacpp ZIP file
      yield {
        serviceName: this.name,
        step: 'extract',
        status: 'executing',
        debugMessage: 'extracting Llamacpp',
      }

      await this.extractLlamacpp()

      yield {
        serviceName: this.name,
        step: 'extract',
        status: 'executing',
        debugMessage: 'extraction complete',
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

  private async downloadLlamacpp(): Promise<void> {
    const downloadUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${this.version}/llama-${this.version}-bin-win-vulkan-x64.zip`
    this.appLogger.info(`Downloading Llamacpp from ${downloadUrl}`, this.name)

    // Delete existing zip if it exists
    if (filesystem.existsSync(this.zipPath)) {
      this.appLogger.info(`Removing existing Llamacpp zip file`, this.name)
      filesystem.removeSync(this.zipPath)
    }

    // Using electron net for better proxy support
    const response = await net.fetch(downloadUrl)
    if (!response.ok || response.status !== 200 || !response.body) {
      throw new Error(`Failed to download Llamacpp: ${response.statusText}`)
    }

    const buffer = await response.arrayBuffer()
    await filesystem.writeFile(this.zipPath, Buffer.from(buffer))

    this.appLogger.info(`Llamacpp zip file downloaded successfully`, this.name)
  }

  private async extractLlamacpp(): Promise<void> {
    this.appLogger.info(`Extracting Llamacpp to ${this.llamaCppRestDir}`, this.name)

    // Delete existing llamacpp directory if it exists
    if (filesystem.existsSync(this.llamaCppRestDir)) {
      this.appLogger.info(`Removing existing Llamacpp directory`, this.name)
      filesystem.removeSync(this.llamaCppRestDir)
    }

    // Create llamacpp directory
    filesystem.mkdirSync(this.llamaCppRestDir, { recursive: true })

    // Extract zip file using PowerShell's Expand-Archive
    try {
      const command = `powershell -Command "Expand-Archive -Path '${this.zipPath}' -DestinationPath '${this.llamaCppRestDir}' -Force"`
      await execAsync(command)

      this.appLogger.info(`Llamacpp extracted successfully`, this.name)
    } catch (error) {
      this.appLogger.error(`Failed to extract Llamacpp: ${error}`, this.name)
      throw error
    }
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    const currentLlmPort = this.llamaLlmProcess?.port || 39150
    const currentEmbeddingPort = this.llamaEmbeddingProcess?.port || 39250

    const additionalEnvVariables = {
      PYTHONNOUSERSITE: 'true',
      SYCL_ENABLE_DEFAULT_CONTEXTS: '1',
      SYCL_CACHE_PERSISTENT: '1',
      PYTHONIOENCODING: 'utf-8',
      LLAMA_LLM_PORT: currentLlmPort.toString(),
      LLAMA_EMBEDDING_PORT: currentEmbeddingPort.toString(),
      ...levelZeroDeviceSelectorEnv(this.devices.find((d) => d.selected)?.id),
    }

    this.appLogger.info(
      `Starting Python wrapper with LLM port: ${currentLlmPort}, Embedding port: ${currentEmbeddingPort}`,
      this.name,
    )

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

  async stop(): Promise<BackendStatus> {
    // Stop llama-server processes first
    await this.stopLlamaLlmServer()
    await this.stopLlamaEmbeddingServer()

    // Then stop the Python backend
    return super.stop()
  }

  /**
   * Override base class method to ensure llama-server is running with specified models
   * This is called from the frontend before inference to ensure backend readiness
   * Handles both LLM and embedding models when provided
   */
  async ensureBackendReadiness(
    llmModelName: string,
    embeddingModelName?: string,
    contextSize?: number,
  ): Promise<void> {
    this.appLogger.info(
      `Ensuring llamaCPP backend readiness for LLM: ${llmModelName}, Embedding: ${embeddingModelName ?? 'none'}`,
      this.name,
    )

    try {
      let serversChanged = false

      // Handle LLM model
      if (
        this.currentLlmModel !== llmModelName ||
        (contextSize && contextSize !== this.currentContextSize) ||
        !this.llamaLlmProcess?.isReady
      ) {
        await this.switchModel(llmModelName, 'llm', contextSize)
        serversChanged = true
        this.appLogger.info(`LLM server ready with model: ${llmModelName}`, this.name)
      } else {
        this.appLogger.info(`LLM server already running with model: ${llmModelName}`, this.name)
      }

      // Handle embedding model if provided
      if (embeddingModelName) {
        if (
          this.currentEmbeddingModel !== embeddingModelName ||
          !this.llamaEmbeddingProcess?.isReady
        ) {
          await this.switchModel(embeddingModelName, 'embedding')
          serversChanged = true
          this.appLogger.info(`Embedding server ready with model: ${embeddingModelName}`, this.name)
        } else {
          this.appLogger.info(
            `Embedding server already running with model: ${embeddingModelName}`,
            this.name,
          )
        }
      }

      // Restart Python wrapper if ports changed and we have an active process
      if (serversChanged && this.encapsulatedProcess && this.needsPythonWrapperRestart()) {
        this.appLogger.info(
          'Server ports changed, restarting Python wrapper for synchronization',
          this.name,
        )
        await this.restartPythonWrapperWithNewPorts()
      }

      this.appLogger.info(
        `LlamaCPP backend fully ready - LLM: ${llmModelName}, Embedding: ${embeddingModelName ?? 'none'}`,
        this.name,
      )
    } catch (error) {
      this.appLogger.error(
        `Failed to ensure backend readiness - LLM: ${llmModelName}, Embedding: ${embeddingModelName ?? 'none'}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  /**
   * Check if Python wrapper needs restart due to port changes
   */
  private needsPythonWrapperRestart(): boolean {
    const currentLlmPort = this.llamaLlmProcess?.port || null
    const currentEmbeddingPort = this.llamaEmbeddingProcess?.port || null

    return (
      this.lastPythonWrapperLlmPort !== currentLlmPort ||
      this.lastPythonWrapperEmbeddingPort !== currentEmbeddingPort
    )
  }

  /**
   * Update port tracking after Python wrapper restart
   */
  private updatePythonWrapperPortTracking(): void {
    this.lastPythonWrapperLlmPort = this.llamaLlmProcess?.port || null
    this.lastPythonWrapperEmbeddingPort = this.llamaEmbeddingProcess?.port || null
    this.appLogger.info(
      `Updated Python wrapper port tracking - LLM: ${this.lastPythonWrapperLlmPort}, Embedding: ${this.lastPythonWrapperEmbeddingPort}`,
      this.name,
    )
  }

  /**
   * Restart Python wrapper with updated server ports
   */
  private async restartPythonWrapperWithNewPorts(): Promise<void> {
    this.appLogger.info('Restarting Python wrapper with updated server ports', this.name)

    try {
      // Stop current Python wrapper (but keep llama-servers running)
      if (this.encapsulatedProcess) {
        this.appLogger.info('Stopping Python wrapper process', this.name)
        this.encapsulatedProcess.kill('SIGTERM')

        // Wait for graceful shutdown
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (this.encapsulatedProcess) {
              this.appLogger.warn('Force killing Python wrapper process', this.name)
              this.encapsulatedProcess.kill('SIGKILL')
            }
            resolve()
          }, 3000)

          if (this.encapsulatedProcess) {
            this.encapsulatedProcess.on('exit', () => {
              clearTimeout(timeout)
              resolve()
            })
          } else {
            clearTimeout(timeout)
            resolve()
          }
        })

        this.encapsulatedProcess = null
      }

      // Start new Python wrapper with updated ports
      const trackedProcess = await this.spawnAPIProcess()
      this.encapsulatedProcess = trackedProcess.process
      this.pipeProcessLogs(trackedProcess.process)

      // Wait for Python wrapper to be ready
      if (await this.listenServerReady(trackedProcess.didProcessExitEarlyTracker)) {
        this.updatePythonWrapperPortTracking()
        this.appLogger.info('Python wrapper restarted successfully with new ports', this.name)
      } else {
        throw new Error('Python wrapper failed to start after port update')
      }
    } catch (error) {
      this.appLogger.error(`Failed to restart Python wrapper: ${error}`, this.name)
      throw error
    }
  }

  async switchModel(
    modelRepoId: string,
    type: 'llm' | 'embedding',
    contextSize?: number,
  ): Promise<number> {
    this.appLogger.info(`Switching ${type} model to: ${modelRepoId}`, this.name)

    try {
      if (type === 'llm') {
        if (
          this.currentLlmModel === modelRepoId &&
          (!contextSize || contextSize === this.currentContextSize) &&
          this.llamaLlmProcess?.isReady
        ) {
          this.appLogger.info(
            `LLM model ${modelRepoId} already loaded with context size ${this.currentContextSize}`,
            this.name,
          )
          return this.llamaLlmProcess.port
        }

        const oldPort = this.llamaLlmProcess?.port
        await this.stopLlamaLlmServer()
        const process = await this.startLlamaLlmServer(modelRepoId, contextSize)

        // Log port change for debugging
        if (oldPort && oldPort !== process.port) {
          this.appLogger.info(
            `LLM server port changed from ${oldPort} to ${process.port}`,
            this.name,
          )
        }

        return process.port
      } else {
        if (this.currentEmbeddingModel === modelRepoId && this.llamaEmbeddingProcess?.isReady) {
          this.appLogger.info(`Embedding model ${modelRepoId} already loaded`, this.name)
          return this.llamaEmbeddingProcess.port
        }

        const oldPort = this.llamaEmbeddingProcess?.port
        await this.stopLlamaEmbeddingServer()
        const process = await this.startLlamaEmbeddingServer(modelRepoId)

        // Log port change for debugging
        if (oldPort && oldPort !== process.port) {
          this.appLogger.info(
            `Embedding server port changed from ${oldPort} to ${process.port}`,
            this.name,
          )
        }

        return process.port
      }
    } catch (error) {
      this.appLogger.error(`Failed to switch ${type} model to ${modelRepoId}: ${error}`, this.name)
      throw error
    }
  }

  private async startLlamaLlmServer(
    modelRepoId: string,
    contextSize?: number,
  ): Promise<LlamaServerProcess> {
    try {
      const modelPath = this.resolveModelPath(modelRepoId)
      const port = await getPort({ port: portNumbers(39100, 39199) })

      this.appLogger.info(
        `Starting LLM server for model: ${modelRepoId} on port ${port}`,
        this.name,
      )

      const args = [
        '--model',
        modelPath,
        '--port',
        port.toString(),
        '--gpu-layers',
        '999',
        '--ctx-size',
        contextSize?.toFixed() ?? '8192',
      ]

      const childProcess = spawn(this.llamaCppRestExePath, args, {
        cwd: this.llamaCppRestDir,
        windowsHide: true,
        env: {
          ...process.env,
          SYCL_ENABLE_DEFAULT_CONTEXTS: '1',
          SYCL_CACHE_PERSISTENT: '1',
          ...levelZeroDeviceSelectorEnv(this.devices.find((d) => d.selected)?.id),
        },
      })

      const llamaProcess: LlamaServerProcess = {
        process: childProcess,
        port,
        modelPath,
        modelRepoId,
        type: 'llm',
        isReady: false,
      }

      childProcess.stdout!.on('data', (message) => {
        if (message.toString().startsWith('INFO')) {
          this.appLogger.info(`${message}`, this.name)
        } else if (message.toString().startsWith('WARN')) {
          this.appLogger.warn(`${message}`, this.name)
        } else {
          this.appLogger.error(`${message}`, this.name)
        }
      })

      childProcess.stderr!.on('data', (message) => {
        this.appLogger.error(`${message}`, this.name)
      })

      // Set up process event handlers
      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`LLM server process error: ${error}`, this.name)
      })

      childProcess.on('exit', (code: number | null) => {
        this.appLogger.info(`LLM server process exited with code: ${code}`, this.name)
        if (this.llamaLlmProcess === llamaProcess) {
          this.llamaLlmProcess = null
          this.currentLlmModel = null
        }
      })

      // Wait for server to be ready
      await this.waitForServerReady(`http://127.0.0.1:${port}/health`)
      llamaProcess.isReady = true

      this.llamaLlmProcess = llamaProcess
      this.currentLlmModel = modelRepoId
      this.currentContextSize = contextSize ?? null

      this.appLogger.info(`LLM server ready for model: ${modelRepoId}`, this.name)
      return llamaProcess
    } catch (error) {
      this.appLogger.error(
        `Failed to start LLM server for model ${modelRepoId}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  private async startLlamaEmbeddingServer(modelRepoId: string): Promise<LlamaServerProcess> {
    try {
      const modelPath = this.resolveEmbeddingModelPath(modelRepoId)
      const port = await getPort({ port: portNumbers(39200, 39299) })

      this.appLogger.info(
        `Starting embedding server for model: ${modelRepoId} on port ${port}`,
        this.name,
      )

      const args = ['--embedding', '--model', modelPath, '--port', port.toString()]

      const childProcess = spawn(this.llamaCppRestExePath, args, {
        cwd: this.llamaCppRestDir,
        windowsHide: true,
        env: {
          ...process.env,
          SYCL_ENABLE_DEFAULT_CONTEXTS: '1',
          SYCL_CACHE_PERSISTENT: '1',
          ...levelZeroDeviceSelectorEnv(this.devices.find((d) => d.selected)?.id),
        },
      })

      const llamaProcess: LlamaServerProcess = {
        process: childProcess,
        port,
        modelPath,
        modelRepoId,
        type: 'embedding',
        isReady: false,
      }

      // Set up process event handlers
      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`Embedding server process error: ${error}`, this.name)
      })

      childProcess.on('exit', (code: number | null) => {
        this.appLogger.info(`Embedding server process exited with code: ${code}`, this.name)
        if (this.llamaEmbeddingProcess === llamaProcess) {
          this.llamaEmbeddingProcess = null
          this.currentEmbeddingModel = null
        }
      })

      // Wait for server to be ready
      await this.waitForServerReady(`http://127.0.0.1:${port}/health`)
      llamaProcess.isReady = true

      this.llamaEmbeddingProcess = llamaProcess
      this.currentEmbeddingModel = modelRepoId

      this.appLogger.info(`Embedding server ready for model: ${modelRepoId}`, this.name)
      return llamaProcess
    } catch (error) {
      this.appLogger.error(
        `Failed to start embedding server for model ${modelRepoId}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  private async stopLlamaLlmServer(): Promise<void> {
    if (this.llamaLlmProcess) {
      this.appLogger.info(`Stopping LLM server for model: ${this.currentLlmModel}`, this.name)
      this.llamaLlmProcess.process.kill('SIGTERM')

      // Wait a bit for graceful shutdown, then force kill if needed
      await new Promise<void>((resolve) => {
        const currentProcess = this.llamaLlmProcess
        const timeout = setTimeout(() => {
          if (currentProcess) {
            this.appLogger.warn(`Force killing LLM server process`, this.name)
            currentProcess.process.kill('SIGKILL')
          }
          resolve()
        }, 5000)

        if (currentProcess) {
          currentProcess.process.on('exit', () => {
            clearTimeout(timeout)
            resolve()
          })
        } else {
          clearTimeout(timeout)
          resolve()
        }
      })

      this.llamaLlmProcess = null
      this.currentLlmModel = null
    }
  }

  private async stopLlamaEmbeddingServer(): Promise<void> {
    if (this.llamaEmbeddingProcess) {
      this.appLogger.info(
        `Stopping embedding server for model: ${this.currentEmbeddingModel}`,
        this.name,
      )
      this.llamaEmbeddingProcess.process.kill('SIGTERM')

      // Wait a bit for graceful shutdown, then force kill if needed
      await new Promise<void>((resolve) => {
        const currentProcess = this.llamaEmbeddingProcess
        const timeout = setTimeout(() => {
          if (currentProcess) {
            this.appLogger.warn(`Force killing embedding server process`, this.name)
            currentProcess.process.kill('SIGKILL')
          }
          resolve()
        }, 5000)

        if (currentProcess) {
          currentProcess.process.on('exit', () => {
            clearTimeout(timeout)
            resolve()
          })
        } else {
          clearTimeout(timeout)
          resolve()
        }
      })

      this.llamaEmbeddingProcess = null
      this.currentEmbeddingModel = null
    }
  }

  private resolveModelPath(modelRepoId: string): string {
    // Use the same logic as the Python backend
    const modelBasePath = 'service/models/llm/ggufLLM'
    const [namespace, repo, ...model] = modelRepoId.split('/')
    const modelPath = path.resolve(
      path.join(this.baseDir, modelBasePath, `${namespace}---${repo}`, model.join('/')),
    )

    if (!filesystem.existsSync(modelPath)) {
      throw new Error(`Model file not found: ${modelPath}`)
    }

    return modelPath
  }

  private resolveEmbeddingModelPath(modelRepoId: string): string {
    // Use the same logic as the Python embedding backend
    const modelBasePath = 'service/models/llm/embedding/llamaCPP'
    const [namespace, repo, ...model] = modelRepoId.split('/')
    const modelDir = path.resolve(
      path.join(this.baseDir, modelBasePath, `${namespace}---${repo}`, model.join('/')),
    )

    if (!filesystem.existsSync(modelDir)) {
      throw new Error(`Embedding model directory not found: ${modelDir}`)
    }

    // Find the first .gguf file in the directory
    const files = filesystem.readdirSync(modelDir)
    const ggufFile = files.find((f) => f.endsWith('.gguf'))

    if (!ggufFile) {
      throw new Error(`No GGUF file found in embedding model directory: ${modelDir}`)
    }

    return path.join(modelDir, ggufFile)
  }

  private async waitForServerReady(healthUrl: string): Promise<void> {
    const maxAttempts = 120
    const delayMs = 1000

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await fetch(healthUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(1000),
        })

        if (response.ok) {
          this.appLogger.info(`Server ready at ${healthUrl}`, this.name)
          return
        }
      } catch (_error) {
        // Server not ready yet, continue waiting
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    throw new Error(`Server failed to start within ${(maxAttempts * delayMs) / 1000} seconds`)
  }

  async getSettings(): Promise<ServiceSettings> {
    return {
      serviceName: this.name,
      version: this.version,
    }
  }

  async updateSettings(settings: ServiceSettings): Promise<void> {
    if (settings.version) {
      this.version = settings.version
      this.appLogger.info(`applied new LlamaCPP version ${this.version}`, this.name)
    }
  }
}
