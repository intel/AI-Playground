import * as filesystem from 'fs-extra';
import { ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { existingFileOrError } from './osProcessHelper.ts';
import { aiBackendServiceDir, LongLivedPythonApiService, LsLevelZeroService } from './service.ts';


export class AiBackendService extends LongLivedPythonApiService {
    readonly pythonEnvDir = path.resolve(path.join(this.baseDir, `${this.name}-env`));
    readonly lsLevelZero = new LsLevelZeroService(this.pythonEnvDir);
    readonly lsLevelZeroDir: string = this.lsLevelZero.dir;
    readonly uvPip = this.lsLevelZero.uvPip;
    readonly pip = this.uvPip.pip;
    readonly python = this.pip.python;

    readonly isRequired = true
    readonly serviceDir = aiBackendServiceDir();
    healthEndpointUrl = `${this.baseUrl}/healthy`
    serviceIsSetUp = () => filesystem.existsSync(this.python.getExePath());
    isSetUp = this.serviceIsSetUp();

    async *set_up(): AsyncIterable<SetupProgress> {
        this.setStatus('installing')
        this.appLogger.info("setting up service", this.name)
        const self = this

        try {
            yield {serviceName: self.name, step: "start", status: "executing", debugMessage: "starting to set up environment"};
            // lsLevelZero will ensure uv and pip are installed
            await this.lsLevelZero.ensureInstalled();

            const deviceArch = await self.lsLevelZero.detectDevice();
            yield {serviceName: self.name, step: `Detecting intel device`, status: "executing", debugMessage: `detected intel hardware ${deviceArch}`};

            yield {serviceName: self.name, step: `install dependencies`, status: "executing", debugMessage: `installing dependencies`};
            const deviceSpecificRequirements = existingFileOrError(path.join(self.serviceDir, `requirements-${deviceArch}.txt`))
            await this.pip.run(["install", "-r", deviceSpecificRequirements]);
            if (deviceArch === "bmg") {
                const intelSpecificExtension = existingFileOrError(self.customIntelExtensionForPytorch)
                await this.pip.run(["install", intelSpecificExtension]);
            }

            const commonRequirements = existingFileOrError(path.join(self.serviceDir, 'requirements.txt'))
            await this.uvPip.run(["install", "-r", commonRequirements]);
            yield {serviceName: self.name, step: `install dependencies`, status: "executing", debugMessage: `dependencies installed`};

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
            ...await this.lsLevelZero.getDeviceSelectorEnv(),
        };

        const apiProcess = spawn(this.python.getExePath(), ["web_api.py", "--port", this.port.toString()], {
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
