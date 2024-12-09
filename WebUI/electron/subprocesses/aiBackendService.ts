import {LongLivedPythonApiService} from "./apiService.ts";
import {ChildProcess, spawn} from "node:child_process";
import getPort, {portNumbers} from "get-port";
import path from "node:path";
import {app} from "electron";


class AiBackendService extends LongLivedPythonApiService {
    readonly workDir = path.resolve(app.isPackaged ? path.join(process.resourcesPath, "service") : path.join(__dirname, "../../../service"));
    readonly pythonExe = path.resolve(path.join(this.baseDir, "env/python.exe"));

    spawnAPIProcess(): {process: ChildProcess, didProcessExitEarlyTracker: Promise<boolean>} {
        this.appLogger.info(` trying to start ${this.name} python API`, this.name)
        const additionalEnvVariables = {
            "SYCL_ENABLE_DEFAULT_CONTEXTS": "1",
            "SYCL_CACHE_PERSISTENT": "1",
            "PYTHONIOENCODING": "utf-8",
            ...this.getSupportedDeviceEnvVariable(),
        };

        const apiProcess = spawn(this.pythonExe, ["web_api.py", "--port", this.port.toString()], {
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

        const processStartupFailedDueToEarlyExit = didProcessExitEarlyTracker.then( earlyExit => !earlyExit)

        return Promise.race([processStartupFailedDueToEarlyExit, processStartupCompletePromise])
    }
}

let instance:  AiBackendService | null = null

export async function aiBackendService() {
    if (instance) {
        return instance
    } else {
        instance = new AiBackendService('ai-backend', await getPort({port: portNumbers(59000, 59999)}))
        return instance
    }
}
