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
  readonly llamaCppRestDir = path.resolve(path.join(this.pythonEnvDir, 'llama-cpp-rest'));
  readonly llamaCppRestExePath = path.resolve(path.join(this.llamaCppRestDir, 'llama-server.exe'));
  readonly zipPath = path.resolve(path.join(this.pythonEnvDir, 'llama-cpp-ipex-llm.zip'));
  // Download URL and file paths
  readonly downloadUrl = 'https://github.com/ipex-llm/ipex-llm/releases/download/v2.2.0/llama-cpp-ipex-llm-2.2.0-win.zip';

  serviceIsSetUp(): boolean {
    return filesystem.existsSync(this.python.getExePath()) && filesystem.existsSync(this.llamaCppRestExePath)
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

      // Download Ollama ZIP file
      yield {
        serviceName: this.name,
        step: 'download',
        status: 'executing',
        debugMessage: `downloading Ollama from ${this.downloadUrl}`,
      };

      await this.downloadOllama();

      yield {
        serviceName: this.name,
        step: 'download',
        status: 'executing',
        debugMessage: 'download complete',
      };

      // Extract Ollama ZIP file
      yield {
        serviceName: this.name,
        step: 'extract',
        status: 'executing',
        debugMessage: 'extracting Ollama',
      };

      await this.extractOllama();

      yield {
        serviceName: this.name,
        step: 'extract',
        status: 'executing',
        debugMessage: 'extraction complete',
      };

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
  
    private async downloadOllama(): Promise<void> {
      this.appLogger.info(`Downloading Ollama from ${this.downloadUrl}`, this.name);
      
      // Delete existing zip if it exists
      if (filesystem.existsSync(this.zipPath)) {
        this.appLogger.info(`Removing existing Ollama zip file`, this.name);
        filesystem.removeSync(this.zipPath);
      }
  
      // Using electron net for better proxy support
      const response = await net.fetch(this.downloadUrl);
      if (!response.ok || response.status !== 200 || !response.body) {
        throw new Error(`Failed to download Ollama: ${response.statusText}`);
      }
      
      const buffer = await response.arrayBuffer();
      await filesystem.writeFile(this.zipPath, Buffer.from(buffer));
      
      this.appLogger.info(`Ollama zip file downloaded successfully`, this.name);
    }
  
    private async extractOllama(): Promise<void> {
      this.appLogger.info(`Extracting Ollama to ${this.llamaCppRestDir}`, this.name);
      
      // Delete existing ollama directory if it exists
      if (filesystem.existsSync(this.llamaCppRestDir)) {
        this.appLogger.info(`Removing existing Ollama directory`, this.name);
        filesystem.removeSync(this.llamaCppRestDir);
      }
      
      // Create ollama directory
      filesystem.mkdirSync(this.llamaCppRestDir, { recursive: true });
      
      // Extract zip file using PowerShell's Expand-Archive
      try {
        const command = `powershell -Command "Expand-Archive -Path '${this.zipPath}' -DestinationPath '${this.llamaCppRestDir}' -Force"`;
        await execAsync(command);
        
        this.appLogger.info(`Ollama extracted successfully`, this.name);
      } catch (error) {
        this.appLogger.error(`Failed to extract Ollama: ${error}`, this.name);
        throw error;
      }
    }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {

    const llamaLlmPort = await getPort({ port: portNumbers(39100, 39199) })
    const llamaEmbeddingPort = await getPort({ port: portNumbers(39200, 39299) })

    const additionalEnvVariables = {
      PYTHONNOUSERSITE: 'true',
      SYCL_ENABLE_DEFAULT_CONTEXTS: '1',
      SYCL_CACHE_PERSISTENT: '1',
      PYTHONIOENCODING: 'utf-8',
      LLAMA_LLM_PORT: llamaLlmPort,
      LLAMA_EMBEDDING_PORT: llamaEmbeddingPort,
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
