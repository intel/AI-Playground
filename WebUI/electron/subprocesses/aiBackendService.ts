import * as filesystem from 'fs-extra';
import getPort, { portNumbers } from "get-port";
import { ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { aiBackendServiceDir, getLsLevelZeroPath, getPythonPath, ipexIndex, ipexVersion, LongLivedPythonApiService } from "./apiService.ts";
import { existingFileOrError, spawnProcessSync } from './osProcessHelper.ts';
import { app, BrowserWindow } from 'electron';


export class AiBackendService extends LongLivedPythonApiService {
    readonly isRequired = true
    readonly serviceDir = aiBackendServiceDir();
    readonly pythonEnvDir = path.resolve(path.join(this.baseDir, `${this.name}-env`));
    readonly pythonExe = getPythonPath(this.pythonEnvDir)
    readonly lsLevelZeroExe = getLsLevelZeroPath(this.pythonEnvDir)
    healthEndpointUrl = `${this.baseUrl}/healthy`
    serviceIsSetUp = () => filesystem.existsSync(this.pythonExe) && filesystem.existsSync(this.lsLevelZeroExe);
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

            yield {serviceName: self.name, step: `install uv`, status: "executing", debugMessage: `installing uv`};
            await self.commonSetupSteps.installUv(pythonEnvContainmentDir);
            yield {serviceName: self.name, step: `install uv`, status: "executing", debugMessage: `installing uv complete`};

            yield {serviceName: self.name, step: `Detecting intel device`, status: "executing", debugMessage: `Trying to identify intel hardware`};
            const deviceId = await self.commonSetupSteps.detectDeviceArcMock(pythonEnvContainmentDir)
            yield {serviceName: self.name, step: `Detecting intel device`, status: "executing", debugMessage: `detected intel hardware ${deviceId}`};

            yield {serviceName: self.name, step: `install dependencies`, status: "executing", debugMessage: `installing dependencies`};
            const deviceSpecificRequirements = existingFileOrError(path.join(self.serviceDir, `requirements-${deviceId}.txt`))
            const commonRequirements = existingFileOrError(path.join(self.serviceDir, 'requirements.txt'))
            if (deviceId === "arc") {
                const intelSpecificExtension = existingFileOrError(self.customIntelExtensionForPytorch)
                await self.commonSetupSteps.pipInstallDependencyStep(pythonEnvContainmentDir, intelSpecificExtension)
            } else {
                await self.commonSetupSteps.uvInstallDependencyStep(pythonEnvContainmentDir, ipexVersion, ipexIndex)
            }

            await self.commonSetupSteps.uvPipInstallRequirementsTxtStep(pythonEnvContainmentDir, deviceSpecificRequirements)
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
