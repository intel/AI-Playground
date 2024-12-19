import {getLsLevelZeroPath, getPythonPath, LongLivedPythonApiService} from "./apiService.ts";
import {ChildProcess, spawn} from "node:child_process";
import path from "node:path";
import fs from "fs";
import * as filesystem from "fs-extra";
import {existingFileOrError, spawnProcessAsync} from "./osProcessHelper.ts";
import { aiBackendServiceDir } from "./apiService.ts";
import {updateIntelWorkflows} from "./updateIntelWorkflows.ts";
import { HttpsProxyAgent } from "https-proxy-agent";


export class ComfyUiBackendService extends LongLivedPythonApiService {
    readonly isRequired = false
    readonly serviceDir = path.resolve(path.join(this.baseDir, "ComfyUI"));
    readonly pythonEnvDir = path.resolve(path.join(this.baseDir, `comfyui-backend-env`));
    readonly pythonExe = getPythonPath(this.pythonEnvDir)
    healthEndpointUrl = `${this.baseUrl}/queue`

    private readonly comfyUIStartupParameters = this.settings.comfyUiParameters ? this.settings.comfyUiParameters : [
        "--lowvram",
        "--disable-ipex-optimize",
        "--bf16-unet",
        "--reserve-vram",
        "4.0"
    ]

    serviceIsSetUp(): boolean {
        return filesystem.existsSync(this.pythonEnvDir) && filesystem.existsSync(this.serviceDir)
    }

    isSetUp = this.serviceIsSetUp();

    async *set_up(): AsyncIterable<SetupProgress> {
        this.appLogger.info("setting up service", this.name)
        this.setStatus('installing')
        const self = this

        const logToFileHandler = (data: string) => self.appLogger.logMessageToFile(data, self.name)

        const cloneGitStep = async (gitExePath: string, url: string, target: string) => {
            self.appLogger.info(`Cloning from ${url}`, self.name, true)
            try {
                // Explicitly specify the cert file bundled with portable git,
                // to avoid being affected by the system git configuration.
                const CABundleCrt = path.resolve(path.join(gitExePath, "../../mingw64/etc/ssl/certs/ca-bundle.crt"));
                const extraEnv = { GIT_SSL_CAINFO: CABundleCrt };
                await spawnProcessAsync(gitExePath, ["clone", url, target], logToFileHandler, extraEnv);
                existingFileOrError(target)
                self.appLogger.info(`repo available at ${target}`, self.name, true)
            } catch (e) {
                self.appLogger.error(`comfyUI cloning failed due to ${e}`, self.name, true)
                throw new Error(`comfyUI cloning failed due to ${e}`)
            }
        }

        const checkoutGitRefStep = async (gitExePath: string, repoDir: string, gitRef: string) => {
            self.appLogger.info(`checking out ${gitRef} in ${repoDir}`, self.name, true)
            try {
                await spawnProcessAsync(gitExePath, ["checkout", gitRef], logToFileHandler, {}, repoDir)
                self.appLogger.info(`repo ${repoDir} now at gitRef ${gitRef}`, self.name, true)
            } catch (e) {
                self.appLogger.warn(`failed to checkout specific ref ${gitRef}, due to ${e}`, self.name, true)
                self.appLogger.warn(`using default branch for ${repoDir} instead`, self.name, true)
            }
        }

        async function setUpServiceWorkEnv(): Promise<string> {
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


        async function installPortableGit(comfyUiContainmentDir: string): Promise<string> {
            
            const zippedGitTargetPath = path.join(comfyUiContainmentDir, "git.zip")
            const executableGitTempPath = path.join(comfyUiContainmentDir, "git")
            const executableGitTargetPath = path.join(self.baseDir, "portable-git")

            const portableGitUrl = "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/MinGit-2.47.1-64-bit.zip"
            self.appLogger.info(`fetching portable git from ${portableGitUrl}`, self.name, true)
            try {
                const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
                const options = proxy ? { agent: new HttpsProxyAgent(proxy) } : {};
                const fetch = (await import('node-fetch')).default;
                const response = await fetch(portableGitUrl, options);
                if (!response.ok) {
                    throw new Error(`fetching git returned HTTP code ${response.status}`)
                }
                if (!response.body) {
                    throw new Error(`fetching git returned empty body with code ${response.status}`)
                }
                const zippedGitStream = response.body;
                const fileStream = fs.createWriteStream(zippedGitTargetPath);
                zippedGitStream.pipe(fileStream);
                await new Promise((resolve, reject) => {
                    fileStream.on('finish', resolve);
                    fileStream.on('error', reject);
                });

                self.appLogger.info(`Zip file downloaded and saved to ${zippedGitTargetPath}`, self.name, true)
            } catch (error) {
                self.appLogger.error(`Downloading portable git failed due to ${error}`, self.name, true)
                throw new Error(`Downloading portable git failed due to ${error}`)
            }

            self.appLogger.info("Unzipping portable git", self.name, true)
            try {
                fs.mkdirSync(executableGitTempPath, { recursive: true })
                self.appLogger.info(`Unzipping with tar -C "${executableGitTempPath}" -xf "${zippedGitTargetPath}"`, self.name)
                await spawnProcessAsync("tar", ["-C", `${executableGitTempPath}`, "-xf", `${zippedGitTargetPath}`], logToFileHandler)
                const gitExe = existingFileOrError(path.join(executableGitTempPath, "cmd", "git.exe"))
                self.appLogger.info(`portable git callable at ${gitExe}`, self.name)
            } catch (e) {
                self.appLogger.error(`Failed to unzip portable git. Error: ${e}`, self.name, true)
                throw new Error(`Failed to unzip portable git. Error: ${e}`)
            }

            await self.commonSetupSteps.moveToFinalTarget(executableGitTempPath, executableGitTargetPath)
            return path.join(executableGitTargetPath, "cmd", "git.exe");
        }

        async function setupComfyUiBaseService(containmentDir: string, gitExePath: string, pythonEnvDir: string): Promise<string> {
            const comfyUICloneTarget = path.join(containmentDir, 'ComfyUI')

            const comfyUiRepoUrl = "https://github.com/comfyanonymous/ComfyUI.git";
            const comfyUiGitRef = "61b5072"
            await cloneGitStep(gitExePath, comfyUiRepoUrl, comfyUICloneTarget)
            await checkoutGitRefStep(gitExePath, comfyUICloneTarget, comfyUiGitRef)
            const requirementsTextPath = path.join(comfyUICloneTarget, 'requirements.txt')
            await self.commonSetupSteps.uvPipInstallRequirementsTxtStep(pythonEnvDir, requirementsTextPath)
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

        try {
            yield {serviceName: self.name, step: "start", status: "executing", debugMessage: "starting to set up comfyUI environment"};
            
            yield {serviceName: self.name, step: `preparing work directory`, status: "executing", debugMessage: `Cloning archetype python env`};
            const pythonEnvContainmentDir = await self.commonSetupSteps.copyArchetypePythonEnv(path.resolve(path.join(self.baseDir, `${self.name}-env_tmp`)))
            yield {serviceName: self.name, step: `preparing work directory`, status: "executing", debugMessage: `Cloning complete`};

            yield {serviceName: self.name, step: `Detecting intel device`, status: "executing", debugMessage: `Trying to identify intel hardware`};
            const deviceArch = await self.commonSetupSteps.detectDevice(pythonEnvContainmentDir)
            yield {serviceName: self.name, step: `Detecting intel device`, status: "executing", debugMessage: `detected intel hardware ${deviceArch}`};

            yield {serviceName: self.name, step: `install dependencies`, status: "executing", debugMessage: `installing dependencies`};
            const deviceSpecificRequirements = existingFileOrError(path.join(aiBackendServiceDir(), `requirements-${deviceArch}.txt`))
            await self.commonSetupSteps.uvPipInstallRequirementsTxtStep(pythonEnvContainmentDir, deviceSpecificRequirements, {disableUv: true})
            if (deviceArch === "bmg") {
                const intelSpecificExtension = existingFileOrError(self.customIntelExtensionForPytorch)
                await self.commonSetupSteps.uvInstallDependencyStep(pythonEnvContainmentDir, intelSpecificExtension)
            }
            yield {serviceName: self.name, step: `install dependencies`, status: "executing", debugMessage: `dependencies installed`};

            yield {serviceName: self.name, step: `move python environment to target`, status: "executing", debugMessage: `Moving python environment to target place at ${self.pythonEnvDir}`};
            await self.commonSetupSteps.moveToFinalTarget(pythonEnvContainmentDir, self.pythonEnvDir)
            yield {serviceName: self.name, step: `move python environment to target`, status: "executing", debugMessage: `Moved to ${self.pythonEnvDir}`};

            yield {serviceName: self.name, step: `preparing service work directory`, status: "executing", debugMessage: `Creating workdir`};
            const comfyUiServiceContainmentDir = await setUpServiceWorkEnv()
            yield {serviceName: self.name, step: `preparing service work directory`, status: "executing", debugMessage: `Created workdir`};

            yield {serviceName: self.name, step: `install git`, status: "executing", debugMessage: `installing git`};
            const gitExe = await installPortableGit(comfyUiServiceContainmentDir)
            yield {serviceName: self.name, step: `install git`, status: "executing", debugMessage: `installation of git complete`};

            yield {serviceName: self.name, step: `install comfyUI`, status: "executing", debugMessage: `installing comfyUI base repo`};
            const comfyUiTmpServiceDir = await setupComfyUiBaseService(comfyUiServiceContainmentDir, gitExe, self.pythonEnvDir)
            yield {serviceName: self.name, step: `install comfyUI`, status: "executing", debugMessage: `installation of comfyUI base repo complete`};

            yield {serviceName: self.name, step: `configure comfyUI`, status: "executing", debugMessage: `configuring comfyUI base repo`};
            await configureComfyUI(comfyUiTmpServiceDir)
            yield {serviceName: self.name, step: `configure comfyUI`, status: "executing", debugMessage: `configured comfyUI base repo`};

            yield {serviceName: self.name, step: `move service to target`, status: "executing", debugMessage: `Moving service to target place at ${self.pythonEnvDir}`};
            await this.commonSetupSteps.moveToFinalTarget(comfyUiTmpServiceDir, self.serviceDir)
            yield {serviceName: self.name, step: `move service to target`, status: "executing", debugMessage: `Moved to ${self.pythonEnvDir}`};
            await updateIntelWorkflows()

            this.setStatus('notYetStarted')
            yield {serviceName: self.name, step: "end", status: "success", debugMessage: `service set up completely`};
        } catch (e) {
            self.appLogger.warn(`Set up of service failed due to ${e}`, self.name, true)
            self.appLogger.warn(`Aborting set up of ${self.name} service environment`, self.name, true)
            this.setStatus('installationFailed')
            yield {serviceName: self.name, step: "end", status: "failed", debugMessage: `Failed to setup comfyUI service due to ${e}`};
        }
    }

    async spawnAPIProcess(): Promise<{ process: ChildProcess; didProcessExitEarlyTracker: Promise<boolean>; }> {
        const additionalEnvVariables = {
            "SYCL_ENABLE_DEFAULT_CONTEXTS": "1",
            "SYCL_CACHE_PERSISTENT": "1",
            "PYTHONIOENCODING": "utf-8",
            ...await this.commonSetupSteps.getDeviceSelectorEnv(),
        };

        const parameters = ["main.py", "--port", this.port.toString(), "--preview-method", "auto", "--output-directory", "../service/static/sd_out", ...this.comfyUIStartupParameters]
        this.appLogger.info(`starting comfyui with ${JSON.stringify({parameters, additionalEnvVariables})}`, this.name, true)
        const apiProcess = spawn(this.pythonExe, parameters, {
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
