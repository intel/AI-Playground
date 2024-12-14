import {getLsLevelZeroPath, LongLivedPythonApiService} from "./apiService.ts";
import {ChildProcess, spawn} from "node:child_process";
import path from "node:path";
import * as filesystem from 'fs-extra'
import {spawnProcessSync, existingFileOrError} from './osProcessHelper.ts'

export class LlamaCppBackendService extends LongLivedPythonApiService {
    readonly serviceDir = path.resolve(path.join(this.baseDir, "LlamaCPP"));
    readonly pythonEnvDir = path.resolve(path.join(this.baseDir, `llama-cpp-env`));
    readonly pythonExe = this.getPythonPath(this.pythonEnvDir)
    readonly isRequired = false;
    readonly lsLevelZeroExe = getLsLevelZeroPath(this.pythonEnvDir)

    healthEndpointUrl = `${this.baseUrl}/health`

    private getPythonPath(basePythonEnvDir: string): string {
        return path.resolve(path.join(basePythonEnvDir, "python.exe"))
    }

    serviceIsSetUp(): boolean {
        return filesystem.existsSync(this.pythonExe)
    }

    isSetUp = this.serviceIsSetUp();

    async *set_up(): AsyncIterable<SetupProgress> {
        this.currentStatus = 'installing'
        this.appLogger.info("setting up service", this.name)
        const self = this

        try {
            yield {serviceName: self.name, step: "start", status: "executing", debugMessage: "starting to set up python environment"};

            yield {serviceName: self.name, step: `preparing work directory`, status: "executing", debugMessage: `Cloning archetype python env`};
            const pythonEnvContainmentDir = await self.commonSetupSteps.copyArchetypePythonEnv(path.resolve(path.join(self.baseDir, `${self.name}-env_tmp`)))
            yield {serviceName: self.name, step: `preparing work directory`, status: "executing", debugMessage: `Cloning complete`};

            yield {serviceName: self.name, step: `Detecting intel device`, status: "executing", debugMessage: `Trying to identify intel hardware`};
            const deviceId = await self.commonSetupSteps.detectDevice(pythonEnvContainmentDir)
            yield {serviceName: self.name, step: `Detecting intel device`, status: "executing", debugMessage: `detected intel hardware ${deviceId}`};

            yield {serviceName: self.name, step: `install dependencies`, status: "executing", debugMessage: `installing dependencies`};
            const commonRequirements = existingFileOrError(path.join(self.serviceDir, 'requirements.txt'))
            const intelSpecificExtension = existingFileOrError(path.join(this.baseDir, 'llama_cpp_python-0.3.2-cp311-cp311-win_amd64.whl'))
            await self.commonSetupSteps.uvInstallDependencyStep(pythonEnvContainmentDir, intelSpecificExtension)
            await self.commonSetupSteps.uvPipInstallRequirementsTxtStep(pythonEnvContainmentDir, commonRequirements)
            yield {serviceName: self.name, step: `install dependencies`, status: "executing", debugMessage: `dependencies installed`};

            yield {serviceName: self.name, step: `move python environment to target`, status: "executing", debugMessage: `Moving python environment to target place at ${self.pythonEnvDir}`};
            await self.commonSetupSteps.moveToFinalTarget(pythonEnvContainmentDir, self.pythonEnvDir)
            yield {serviceName: self.name, step: `move python environment to target`, status: "executing", debugMessage: `Moved to ${self.pythonEnvDir}`};
            self.currentStatus = 'notYetStarted'
            this.updateStatus()
            yield {serviceName: self.name, step: "end", status: "success", debugMessage: `service set up completely`};
        } catch (e) {
            self.appLogger.warn(`Set up of service failed due to ${e}`, self.name, true)
            self.appLogger.warn(`Aborting set up of ${self.name} service environment`, self.name, true)
            self.currentStatus = 'installationFailed'
            this.updateStatus()
            yield {serviceName: self.name, step: "end", status: "failed", debugMessage: `Failed to setup python environment due to ${e}`};
        }
    }

    spawnAPIProcess(): {process: ChildProcess, didProcessExitEarlyTracker: Promise<boolean>} {
        const additionalEnvVariables = {
            "SYCL_ENABLE_DEFAULT_CONTEXTS": "1",
            "SYCL_CACHE_PERSISTENT": "1",
            "PYTHONIOENCODING": "utf-8",
            ...this.getOneApiSupportedDeviceEnvVariable(),
        };

        const apiProcess = spawn(this.pythonExe, ["llama_web_api.py", "--port", this.port.toString()], {
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

    getOneApiSupportedDeviceEnvVariable(): { ONEAPI_DEVICE_SELECTOR: string; } {
        try {
            const lsLevelZeroOut = spawnProcessSync(this.lsLevelZeroExe, []);
            this.appLogger.info(`ls_level_zero.exe output: ${lsLevelZeroOut}`, this.name)
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
