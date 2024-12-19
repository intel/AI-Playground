import * as filesystem from 'fs-extra';
import { ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { aiBackendServiceDir, getLsLevelZeroPath, getPythonPath, LongLivedPythonApiService } from "./apiService.ts";
import { existingFileOrError } from './osProcessHelper.ts';


export class AiBackendService extends LongLivedPythonApiService {
    readonly isRequired = true
    readonly serviceDir = aiBackendServiceDir();
    readonly pythonEnvDir = path.resolve(path.join(this.baseDir, `${this.name}-env`));
    readonly pythonExe = getPythonPath(this.pythonEnvDir)
    healthEndpointUrl = `${this.baseUrl}/healthy`
    serviceIsSetUp = () => filesystem.existsSync(this.pythonExe);
    isSetUp = this.serviceIsSetUp();

    async *set_up(): AsyncIterable<SetupProgress> {
        this.setStatus('installing')
        this.appLogger.info("setting up service", this.name)
        const self = this

        try {
            yield {serviceName: self.name, step: "start", status: "executing", debugMessage: "starting to set up python environment"};

            yield {serviceName: self.name, step: `preparing work directory`, status: "executing", debugMessage: `Cloning archetype python env`};
            const pythonEnvContainmentDir = await self.commonSetupSteps.copyArchetypePythonEnv(path.resolve(path.join(self.baseDir, `${self.name}-env_tmp`)))
            yield {serviceName: self.name, step: `preparing work directory`, status: "executing", debugMessage: `Cloning complete`};

            yield {serviceName: self.name, step: `Detecting intel device`, status: "executing", debugMessage: `Trying to identify intel hardware`};
            const deviceArch = await self.commonSetupSteps.detectDevice(pythonEnvContainmentDir)
            yield {serviceName: self.name, step: `Detecting intel device`, status: "executing", debugMessage: `detected intel hardware ${deviceArch}`};

            yield {serviceName: self.name, step: `install dependencies`, status: "executing", debugMessage: `installing dependencies`};
            const deviceSpecificRequirements = existingFileOrError(path.join(self.serviceDir, `requirements-${deviceArch}.txt`))
            const commonRequirements = existingFileOrError(path.join(self.serviceDir, 'requirements.txt'))
            if (deviceArch === "bmg") {
                const intelSpecificExtension = existingFileOrError(self.customIntelExtensionForPytorch)
                await self.commonSetupSteps.uvInstallDependencyStep(pythonEnvContainmentDir, intelSpecificExtension)
            }

            await self.commonSetupSteps.uvPipInstallRequirementsTxtStep(pythonEnvContainmentDir, deviceSpecificRequirements, {disableUv: true})
            await self.commonSetupSteps.uvPipInstallRequirementsTxtStep(pythonEnvContainmentDir, commonRequirements)
            yield {serviceName: self.name, step: `install dependencies`, status: "executing", debugMessage: `dependencies installed`};

            yield {serviceName: self.name, step: `move python environment to target`, status: "executing", debugMessage: `Moving python environment to target place at ${self.pythonEnvDir}`};
            await self.commonSetupSteps.moveToFinalTarget(pythonEnvContainmentDir, self.pythonEnvDir)
            yield {serviceName: self.name, step: `move python environment to target`, status: "executing", debugMessage: `Moved to ${self.pythonEnvDir}`};
            this.setStatus('notYetStarted')
            yield {serviceName: self.name, step: "end", status: "success", debugMessage: `service set up completely`};
        } catch (e) {
            self.appLogger.warn(`Set up of service failed due to ${e}`, self.name, true)
            self.appLogger.warn(`Aborting set up of ${self.name} service environment`, self.name, true)
            this.setStatus('installationFailed')
            yield {serviceName: self.name, step: "end", status: "failed", debugMessage: `Failed to setup python environment due to ${e}`};
        }
    }


    async spawnAPIProcess(): Promise<{ process: ChildProcess; didProcessExitEarlyTracker: Promise<boolean>; }> {
        const additionalEnvVariables = {
            "SYCL_ENABLE_DEFAULT_CONTEXTS": "1",
            "SYCL_CACHE_PERSISTENT": "1",
            "PYTHONIOENCODING": "utf-8",
            ...await this.commonSetupSteps.getDeviceSelectorEnv(),
        };

        const apiProcess = spawn(this.pythonExe, ["web_api.py", "--port", this.port.toString()], {
            cwd: this.serviceDir,
            windowsHide: true,
            env: Object.assign(process.env, additionalEnvVariables)
        });

        //must be at the same tick as the spawn function call
        //otherwise we cannot really track errors given the nature of spawn() with a longlived process
        const didProcessExitEarlyTracker = new Promise<boolean>((resolve, reject) => {
            apiProcess.on('error', (error) => {
                this.appLogger.error(`encountered error of process in ${this.name} : ${error}`, this.name)
                resolve(true);
            });
            apiProcess.on('exit', () => {
                this.appLogger.error(`encountered unexpected exit in ${this.name}.`, this.name)
                resolve(true);
            });
        });

        return {
            process: apiProcess,
            didProcessExitEarlyTracker: didProcessExitEarlyTracker,
        }
    }
}
