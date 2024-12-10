import {LongLivedPythonApiService} from "./apiService.ts";
import {ChildProcess, spawn} from "node:child_process";
import path from "node:path";
import fs from "fs";
import getPort, {portNumbers} from "get-port";


class ComfyUiBackendService extends LongLivedPythonApiService {
    readonly serviceDir = path.resolve(path.join(this.baseDir, "ComfyUI"));
    readonly pythonExe = path.resolve(path.join(this.baseDir, "env", "python.exe"));
    healthEndpointUrl = `${this.baseUrl}/queue`

    private readonly comfyUIStartupParameters = [
        "--lowvram",
        "--disable-ipex-optimize",
        "--bf16-unet",
        "--reserve-vram",
        "4.0"
    ]

    set_up(): AsyncIterable<SetupProgress> {
        const extraModelsYaml = `aipg:
  base_path: ${path.resolve(this.baseDir, 'service/models/stable_diffusion')}
  checkpoints: checkpoints
  clip: checkpoints
  vae: checkpoints
  unet: checkpoints
  loras: lora`
        fs.promises.writeFile(path.join(this.serviceDir, 'extra_model_paths.yaml'), extraModelsYaml, {encoding: 'utf-8', flag: 'w'});
        return super.set_up()
    }

    spawnAPIProcess(): {
        process: ChildProcess,
        didProcessExitEarlyTracker: Promise<boolean>
    } {
        const additionalEnvVariables = {
            "SYCL_ENABLE_DEFAULT_CONTEXTS": "1",
            "SYCL_CACHE_PERSISTENT": "1",
            "PYTHONIOENCODING": "utf-8",
            ...this.getSupportedDeviceEnvVariable(),
        };

        const apiProcess = spawn(this.pythonExe, ["main.py", "--port", this.port.toString(), "--preview-method", "auto", "--output-directory", "../service/static/sd_out", ...this.comfyUIStartupParameters], {
            cwd: this.serviceDir,
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

        return {
            process: apiProcess,
            didProcessExitEarlyTracker: didProcessExitEarlyTracker,
        }
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
