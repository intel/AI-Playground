import {LongLivedPythonApiService} from "./apiService.ts";
import {ChildProcess, spawn} from "node:child_process";
import path from "node:path";
import fs from "fs";
import getPort, {portNumbers} from "get-port";
import * as filesystem from "fs-extra";
import {AiBackendService} from "./aiBackendService.ts";
import {existingFileOrError, spawnProcessAsync, spawnProcessSync} from "./osProcessHelper.ts";


class ComfyUiBackendService extends LongLivedPythonApiService {
    readonly serviceDir = path.resolve(path.join(this.baseDir, "ComfyUI"));
    readonly pythonEnvDir = path.resolve(path.join(this.baseDir, `ai-backend-env`)); // use ai-backend python env. THis serivce should receive its own, but we lack the time, to fix this
    readonly pythonExe = LongLivedPythonApiService.getPythonPath(this.pythonEnvDir)
    readonly lsLevelZeroExe = AiBackendService.getLsLevelZeroPath(this.pythonEnvDir) // in the recycled ai-backend, we may conveniently assume, that this is already all setup.
    healthEndpointUrl = `${this.baseUrl}/queue`

    private readonly comfyUIStartupParameters = [
        "--lowvram",
        "--disable-ipex-optimize",
        "--bf16-unet",
        "--reserve-vram",
        "4.0"
    ]

    is_set_up(): boolean {
        return filesystem.existsSync(this.serviceDir) && filesystem.existsSync(this.lsLevelZeroExe)
    }

    async *set_up(): AsyncIterable<SetupProgress> {
        this.appLogger.info("setting up service", this.name)
        const self = this
        const logToFileHandler = (data: string) => self.appLogger.logMessageToFile(data, self.name)

        const uvPipInstallStep = async (pythonDir: string, skipOnMissingRequirementsTxt = false ) => {
            const requirementsTextPath = path.join(pythonDir, 'requirements.txt')
            if (skipOnMissingRequirementsTxt && !fs.existsSync(requirementsTextPath)) {
                self.appLogger.info(`No requirements.txt for ${pythonDir} - skipping`, self.name)
                return
            }
            try {
                self.appLogger.info(`Installing python dependencies for ${pythonDir}`, self.name, true)
                await spawnProcessAsync(self.pythonExe, ["-m", "uv", "pip", "install", "-r", requirementsTextPath], logToFileHandler)
                self.appLogger.info(`Successfully installed python dependencies for ${pythonDir}`, self.name, true)
            } catch (e) {
                self.appLogger.error(`Failure during installation of python dependencies for ${pythonDir}. Error: ${e}`, self.name, true)
                throw new Error(`Failed to install python dependencies for ${pythonDir}. Error: ${e}`)
            }
        }

        const cloneGitStep = async (gitExePath: string, url: string, target: string) => {
            self.appLogger.info(`Cloning from ${url}`, self.name)
            try {
                spawnProcessSync(gitExePath, ["clone", url, target], logToFileHandler)
                existingFileOrError(target)
                self.appLogger.info(`repo available at ${target}`, self.name)
            } catch (e) {
                self.appLogger.error(`comfyUI cloning failed due to ${e}`, self.name)
                throw new Error(`comfyUI cloning failed due to ${e}`)
            }
        }

        async function setUpWorkEnv(): Promise<string> {
            const comfyUiContaintmentDir = path.resolve(path.join(self.baseDir, `${self.name}-service_tmp`))
            self.appLogger.info(`Preparing installation containment dir at ${comfyUiContaintmentDir}`, self.name, true)
            try {
                if (filesystem.existsSync(comfyUiContaintmentDir)) {
                    self.appLogger.info(`Cleaning up previously containment directory at ${comfyUiContaintmentDir}`, self.name, true)
                    filesystem.removeSync(comfyUiContaintmentDir)
                }
                fs.mkdirSync(comfyUiContaintmentDir, { recursive: true });
                return comfyUiContaintmentDir
            } catch (e) {
                self.appLogger.error(`Failure during set up of workspace. Error: ${e}`, self.name, true)
                throw new Error(`Failure during set up of workspace. Error: ${e}`)
            }
        }


        async function verifyPythonBackendExists(): Promise<void> {
                self.appLogger.info(`verifying python env ${self.pythonEnvDir} exists`, self.name, true)
                if (filesystem.existsSync(self.lsLevelZeroExe) && filesystem.existsSync(self.pythonExe)) {
                    return
                } else {
                    throw new Error(`Python env missing or not set up correctly`)
                }
        }



        async function installPortableGit(comfyUiContainmentDir: string): Promise<string> {
            
            const zippedGitTargetPath = path.join(comfyUiContainmentDir, "git.zip")
            const executableGitTargetPath = path.join(comfyUiContainmentDir, "git")

            const portableGitUrl = "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/MinGit-2.47.1-64-bit.zip"
            self.appLogger.info(`fetching portable git from ${portableGitUrl}`, self.name, true)
            try {
                const response = await fetch(portableGitUrl);
                if (!response.ok) {
                    throw new Error(`fetching git returned HTTP code ${response.status}`)
                }
                if (!response.body) {
                    throw new Error(`fetching git returned empty body with code ${response.status}`)
                }
                const zippedGitStream = response.body.getReader();
                const fileStream = fs.createWriteStream(zippedGitTargetPath);
                let chunk = await zippedGitStream.read();
                while (!chunk.done) {
                    fileStream.write(chunk.value);
                    chunk = await zippedGitStream.read();
                }
                fileStream.end();
                self.appLogger.info(`Zip file downloaded and saved to ${zippedGitTargetPath}`, self.name, true)
            } catch (error) {
                self.appLogger.error(`Downloading portable git failed due to ${error}`, self.name, true)
                throw new Error(`Downloading portable git failed due to ${error}`)
            }

            self.appLogger.info("Unzipping portable git", self.name)
            try {
                fs.mkdirSync(executableGitTargetPath, { recursive: true })
                self.appLogger.info(`Unzipping with tar -C "${executableGitTargetPath}" -xf "${zippedGitTargetPath}"`, self.name)
                await spawnProcessAsync("tar", ["-C", `${executableGitTargetPath}`, "-xf", `${zippedGitTargetPath}`], logToFileHandler)
                const gitExe = existingFileOrError(path.join(executableGitTargetPath, "cmd", "git.exe"))
                self.appLogger.info(`portable git callable at ${gitExe}`, self.name)
                return gitExe
            } catch (e) {
                self.appLogger.error(`Failed to unzip portable git. Error: ${e}`, self.name, true)
                throw new Error(`Failed to unzip portable git. Error: ${e}`)
            }
        }

        async function setupComfyUiBaseService(containmentDir: string, gitExePath: string): Promise<string> {
            const comfyUICloneTarget = path.join(containmentDir, 'ComfyUI')

            await cloneGitStep(gitExePath, "https://github.com/comfyanonymous/ComfyUI.git", comfyUICloneTarget)
            await uvPipInstallStep(comfyUICloneTarget)
            return comfyUICloneTarget;
        }

        async function configureComfyUI(comfyUiServiceDir: string): Promise<void> {
                try {
                    self.appLogger.info("Configuring extra model paths for comfyUI", self.name)
                    const extraModelPathsYaml = path.join(comfyUiServiceDir, 'extra_model_paths.yaml')
                    const extraModelsYaml = `aipg:
  base_path: ${path.resolve(self.baseDir, 'service/models/stable_diffusion')}
  checkpoints: checkpoints
  clip: checkpoints
  vae: checkpoints
  unet: checkpoints
  loras: lora`
                    fs.promises.writeFile(extraModelPathsYaml, extraModelsYaml, {encoding: 'utf-8', flag: 'w'});
                    self.appLogger.info(`Configured extra model paths for comfyUI at ${extraModelPathsYaml} as ${extraModelsYaml} `, self.name)
                } catch (e) {
                    self.appLogger.error("Failed to configure extra model paths for comfyUI", self.name)
                    throw new Error("Failed to configure extra model paths for comfyUI")
                }
        }

        async function moveToFinalTarget(comfyUiTmpServiceDir: string): Promise<void> {
                self.appLogger.info(`renaming containment directory ${comfyUiTmpServiceDir} to ${self.serviceDir}`, self.name, true)
                try {
                    if (filesystem.existsSync(self.serviceDir)) {
                        self.appLogger.info(`Cleaning up previously python environment directory at ${self.serviceDir}`, self.name, true)
                        filesystem.removeSync(self.serviceDir)
                    }
                    filesystem.move(comfyUiTmpServiceDir, self.serviceDir)
                    self.appLogger.info(`comfyUI service dir now available at ${self.serviceDir}`, self.name, true)
                } catch (e) {
                    self.appLogger.error(`Failure to rename ${comfyUiTmpServiceDir} to ${self.serviceDir}. Error: ${e}`, self.name, true)
                    throw new Error(`Failure to rename ${comfyUiTmpServiceDir} to ${self.serviceDir}. Error: ${e}`)
                }
            }

        try {
            yield {serviceName: self.name, step: "start", status: "executing", debugMessage: "starting to set up comfyUI environment"};
            
            yield {serviceName: self.name, step: `preparing work directory`, status: "executing", debugMessage: `Creating workdir`};
            const comfyUiServiceContainmentDir = await setUpWorkEnv()
            yield {serviceName: self.name, step: `preparing work directory`, status: "executing", debugMessage: `Created workdir`};

            yield {serviceName: self.name, step: `install git`, status: "executing", debugMessage: `installing git`};
            const gitExe = await installPortableGit(comfyUiServiceContainmentDir)
            yield {serviceName: self.name, step: `install git`, status: "executing", debugMessage: `installation of git complete`};

            yield {serviceName: self.name, step: `verify python environment`, status: "executing", debugMessage: `verify python environment`};
            await verifyPythonBackendExists()
            yield {serviceName: self.name, step: `verify python environment`, status: "executing", debugMessage: `python environment set up`};

            yield {serviceName: self.name, step: `install comfyUI`, status: "executing", debugMessage: `installing comfyUI base repo`};
            const comfyUiTmpServiceDir = await setupComfyUiBaseService(comfyUiServiceContainmentDir, gitExe)
            yield {serviceName: self.name, step: `install git`, status: "executing", debugMessage: `installation of comfyUI base repo complete`};

            yield {serviceName: self.name, step: `configure comfyUI`, status: "executing", debugMessage: `configuring comfyUI base repo`};
            await configureComfyUI(comfyUiTmpServiceDir)
            yield {serviceName: self.name, step: `configure comfyUI`, status: "executing", debugMessage: `configured comfyUI base repo`};

            yield {serviceName: self.name, step: `move python environment to target`, status: "executing", debugMessage: `Moving python environment to target place at ${self.pythonEnvDir}`};
            await moveToFinalTarget(comfyUiTmpServiceDir)
            yield {serviceName: self.name, step: `move python environment to target`, status: "executing", debugMessage: `Moved to ${self.pythonEnvDir}`};
        
            yield {serviceName: self.name, step: "end", status: "success", debugMessage: `service set up completely`};
        } catch (e) {
            self.appLogger.warn(`Set up of service failed due to ${e}`, self.name, true)
            self.appLogger.warn(`Aborting set up of ${self.name} service environment`, self.name, true)
            yield {serviceName: self.name, step: "end", status: "failed", debugMessage: `Failed to setup comfyUI service due to ${e}`};
        }
    }

    spawnAPIProcess(): {
        process: ChildProcess,
        didProcessExitEarlyTracker: Promise<boolean>
    } {
        const additionalEnvVariables = {
            "SYCL_ENABLE_DEFAULT_CONTEXTS": "1",
            "SYCL_CACHE_PERSISTENT": "1",
            "PYTHONIOENCODING": "utf-8",
            ...this.getOneApiSupportedDeviceEnvVariable(),
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

    getOneApiSupportedDeviceEnvVariable(): { ONEAPI_DEVICE_SELECTOR: string; } {
        try {
            const lsLevelZeroOut = spawnProcessSync(this.lsLevelZeroExe, []);
            this.appLogger.info(`ls_level_zero.exe output: ${lsLevelZeroOut}`, self.name)
            const devices: { name: string, device_id: number, id: string }[] = JSON.parse(lsLevelZeroOut.toString());
            const supportedIDs = devices.filter(device => device.name.toLowerCase().includes("arc") || device.device_id === 0xE20B).map(device => device.id);
            const additionalEnvVariables = {ONEAPI_DEVICE_SELECTOR: "level_zero:" + supportedIDs.join(",")};
            this.appLogger.info(`Set ONEAPI_DEVICE_SELECTOR=${additionalEnvVariables["ONEAPI_DEVICE_SELECTOR"]}`, this.name);
            return additionalEnvVariables;
        } catch (error) {
            this.appLogger.error(`Failed to detect Level Zero devices: ${error}`, this.name);
            return {ONEAPI_DEVICE_SELECTOR: "level_zero:*"};
        }
    }
}

let instance:  ComfyUiBackendService | null = null

export async function comfyUIBackendService() {
    if (!instance) {
        instance = new ComfyUiBackendService('comfyui-backend', await getPort({port: portNumbers(49000, 49999)}))
    }
    return instance
}
