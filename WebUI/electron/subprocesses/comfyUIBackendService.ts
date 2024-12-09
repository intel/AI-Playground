import {LongLivedPythonApiService} from "./apiService.ts";
import {ChildProcess, spawn} from "node:child_process";
import path from "node:path";
import fs from "fs";
import getPort, {portNumbers} from "get-port";


class ComfyUiBackendService extends LongLivedPythonApiService {
    readonly workDir = path.resolve(path.join(this.baseDir, "ComfyUI"));
    readonly pythonExe = path.resolve(path.join(this.baseDir, "env/python.exe"));

    private readonly comfyUIStartupParameters = [
        "--lowvram",
        "--disable-ipex-optimize",
        "--bf16-unet",
        "--reserve-vram",
        "4.0"
    ]

    set_up(): Promise<void> {
        const extraModelsYaml = `aipg:
  base_path: ${path.resolve(this.baseDir, 'service/models/stable_diffusion')}
  checkpoints: checkpoints
  clip: checkpoints
  vae: checkpoints
  unet: checkpoints
  loras: lora`
        return fs.promises.writeFile(path.join(this.workDir, 'extra_model_paths.yaml'), extraModelsYaml, {encoding: 'utf-8', flag: 'w'});
    }

    spawnAPIProcess(): {
        process: ChildProcess,
        didProcessExitEarlyTracker: Promise<boolean>
    } {
        this.appLogger.info(` trying to start ${this.name} python API`, this.name)
        const additionalEnvVariables = {
            "SYCL_ENABLE_DEFAULT_CONTEXTS": "1",
            "SYCL_CACHE_PERSISTENT": "1",
            "PYTHONIOENCODING": "utf-8",
            ...this.getSupportedDeviceEnvVariable(),
        };

        const apiProcess = spawn(this.pythonExe, ["main.py", "--port", this.port.toString(), "--preview-method", "auto", "--output-directory", "../service/static/sd_out", ...this.comfyUIStartupParameters], {
            cwd: this.workDir,
            windowsHide: true,
            env: Object.assign(process.env, additionalEnvVariables)
        });

        //must be at the same tick as the spawn function call
        //otherwise we cannot really track errors given the nature of spawn() with a longlived process
        const didProcessExitEarlyTracker = new Promise<boolean>((resolve, reject) => {
            apiProcess.on('exit', () => {
                this.appLogger.error(`encountered unexpected exit in ${this.name}.`, this.name)
                resolve(true);
            });
            apiProcess.on('error', (error) => {
                this.appLogger.error(`encountered error of process in ${this.name} : ${error}`, this.name)
                resolve(true);
            });
        });

        apiProcess.stdout.on('data', (message) => {
            if (message.toString().startsWith('INFO')) {
                this.appLogger.info(`${message}`, this.name)
            } else if (message.toString().startsWith('WARN')) {
                this.appLogger.warn(`${message}`, this.name)
            } else {
                this.appLogger.error(`${message}`, this.name)
            }
        })

        apiProcess.stderr.on('data', (message) => {
            this.appLogger.error(`${message}`, this.name)
        })
        apiProcess.on('error', (message) => {
            this.appLogger.error(`backend process ${this.name} exited abruptly due to : ${message}`, this.name)
        })

        return {
            process: apiProcess,
            didProcessExitEarlyTracker: didProcessExitEarlyTracker,
        }
    }

    async listenServerReady(process: ChildProcess, didProcessExitEarlyTracker: Promise<boolean>): Promise<boolean> {
        const processStartupCompletePromise = new Promise<boolean>((resolve) => {
            setTimeout(() => {
                //TODO: call health endpoint or query logs for startup complete log...
                this.appLogger.info("####### mocked server ready signal return true ####", this.name)
                resolve(true)
            }, 4000)
        })

        const processStartupFailedDueToEarlyExit = didProcessExitEarlyTracker.then(earlyExit => !earlyExit)

        return Promise.race([processStartupFailedDueToEarlyExit, processStartupCompletePromise])
    }
}

let instance:  ComfyUiBackendService | null = null

export async function comfyUIBackendService() {
    if (instance) {
        return instance
    } else {
        instance = new ComfyUiBackendService('comfyui-backend', await getPort({port: portNumbers(49000, 49999)}))
        return instance
    }
}
