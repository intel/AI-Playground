import {LongLivedPythonApiService} from "./apiService.ts";
import {ChildProcess, spawn} from "node:child_process";
import getPort, {portNumbers} from "get-port";
import path from "node:path";
import {app} from "electron";
import * as filesystem from 'fs-extra'
import {copyFileWithDirs, existingFileOrError, spawnProcessAsync, spawnProcessSync} from './osProcessHelper.ts'
import { z } from "zod";

const LsLevelZeroDeviceSchema = z.object({id: z.number(), name: z.string(), device_id: z.number()});
const LsLevelZeroOutSchema = z.array(LsLevelZeroDeviceSchema).min(1);
type LsLevelZeroDevice = z.infer<typeof LsLevelZeroDeviceSchema>;

export class AiBackendService extends LongLivedPythonApiService {
    readonly serviceDir = path.resolve(app.isPackaged ? path.join(process.resourcesPath, "service") : path.join(__dirname, "../../../service"));
    readonly pythonEnvDir = path.resolve(path.join(this.baseDir, `${this.name}-env`));
    readonly pythonExe = LongLivedPythonApiService.getPythonPath(this.pythonEnvDir)
    readonly lsLevelZeroExe = AiBackendService.getLsLevelZeroPath(this.pythonEnvDir)
    healthEndpointUrl = `${this.baseUrl}/healthy`


    public static getLsLevelZeroPath(basePythonEnvDir: string): string {
        return path.resolve(path.join(basePythonEnvDir, "Library/bin/ls_level_zero.exe"));
    }

    is_set_up(): boolean {
        return filesystem.existsSync(this.pythonExe) && filesystem.existsSync(this.lsLevelZeroExe)
    }

    async *set_up(): AsyncIterable<SetupProgress> {
        this.appLogger.info("setting up service", this.name)
        const self = this
        const logToFileHandler = (data: string) => self.appLogger.logMessageToFile(data, self.name)

        async function installUv(pythonEnvContainmentDir: string): Promise<void> {
            self.appLogger.info(`installing uv into env ${pythonEnvContainmentDir}`, self.name, true)
            try {
                const pythonExe = existingFileOrError(LongLivedPythonApiService.getPythonPath(pythonEnvContainmentDir))
                const getPipScript = existingFileOrError(path.join(pythonEnvContainmentDir, 'get-pip.py'))
                await spawnProcessAsync(pythonExe, [getPipScript], logToFileHandler)
                await spawnProcessAsync(pythonExe, ["-m", "pip", "install", "uv"], logToFileHandler)
                self.appLogger.info(`Successfully installed uv into env ${pythonEnvContainmentDir}`, self.name, true)
            } catch (e) {
                self.appLogger.error(`Failed to install uv. Error: ${e}`, self.name, true)
                throw new Error(`Failed to install uv. Error: ${e}`);
            }
        }

        async function runUvPipInstallSetup(pythonEnvContainmentDir: string, deviceId: string): Promise<void> {
            self.appLogger.info(`installing python dependencies`, self.name, true)
            try {
                const pythonExe = existingFileOrError(LongLivedPythonApiService.getPythonPath(pythonEnvContainmentDir))
                const deviceSpecificRequirements = existingFileOrError(path.join(self.serviceDir, `requirements-${deviceId}.txt`))
                const commonRequirements = existingFileOrError(path.join(self.serviceDir, 'requirements.txt'))
                await spawnProcessAsync(pythonExe, ["-m", "uv", "pip", "install", "-r", deviceSpecificRequirements], logToFileHandler)
                await spawnProcessAsync(pythonExe, ["-m", "uv", "pip", "install", "-r", commonRequirements], logToFileHandler)
                self.appLogger.info(`Successfully installed python dependencies`, self.name, true)
            } catch (e) {
                self.appLogger.error(`Failure during installation of python dependencies: ${e}`, self.name, true)
                throw new Error(`Failed to install python dependencies. Error: ${e}`)
            }
        }

        async function setUpWorkEnv(): Promise<string> {
            const archtypePythonEnv = existingFileOrError(self.archtypePythonEnv)
            const targetPythonEnvContainmentDir = path.resolve(path.join(self.baseDir, `${self.name}-env_tmp`))

            self.appLogger.info(`Cloning archetype python env ${archtypePythonEnv} into ${targetPythonEnvContainmentDir}`, self.name, true)
            try {
                if (filesystem.existsSync(targetPythonEnvContainmentDir)) {
                    self.appLogger.info(`Cleaning up previously containment directory at ${targetPythonEnvContainmentDir}`, self.name, true)
                    filesystem.removeSync(targetPythonEnvContainmentDir)
                }
                copyFileWithDirs(archtypePythonEnv, targetPythonEnvContainmentDir)
                return targetPythonEnvContainmentDir;
            } catch (e) {
                self.appLogger.error(`Failure during set up of workspace. Error: ${e}`, self.name, true)
                throw new Error(`Failure during set up of workspace. Error: ${e}`)
            }
        }

        async function detectDeviceArcMock(pythonEnvContainmentDir: string): Promise<string> {
            self.appLogger.info("Detecting intel deviceID", self.name)
            self.appLogger.info("Copying ls_level_zero.exe", self.name)
            const lsLevelZeroBinaryTargetPath = AiBackendService.getLsLevelZeroPath(pythonEnvContainmentDir)
            const src = existingFileOrError(path.resolve(path.join(self.serviceDir, "tools/ls_level_zero.exe")));
            copyFileWithDirs(src, lsLevelZeroBinaryTargetPath);

            return 'arc';
        }

        async function detectDevice(pythonEnvContainmentDir: string): Promise<LsLevelZeroDevice> {
            self.appLogger.info("Detecting intel deviceID", self.name)
            try {
                // copy ls_level_zero.exe from service/tools to env/Library/bin for SYCL environment
                self.appLogger.info("Copying ls_level_zero.exe", self.name)
                const lsLevelZeroBinaryTargetPath = AiBackendService.getLsLevelZeroPath(pythonEnvContainmentDir)
                const src = existingFileOrError(path.resolve(path.join(self.serviceDir, "tools/ls_level_zero.exe")));
                copyFileWithDirs(src, lsLevelZeroBinaryTargetPath);

                self.appLogger.info("Fetching requirements for ls_level_zero.exe", self.name)
                const pythonExe = existingFileOrError(LongLivedPythonApiService.getPythonPath(pythonEnvContainmentDir))
                const lsLevelZeroRequirements = existingFileOrError(path.resolve(path.join(self.serviceDir, "requirements-ls_level_zero.txt")));
                await spawnProcessAsync(pythonExe, ["-m", "uv", "pip", "install", "-r", lsLevelZeroRequirements], logToFileHandler)
                const lsLevelZeroOut = spawnProcessSync(lsLevelZeroBinaryTargetPath, [], logToFileHandler);
                self.appLogger.info(`ls_level_zero.exe output: ${lsLevelZeroOut}`, self.name)
                const devices = LsLevelZeroOutSchema.parse(lsLevelZeroOut);
                return devices[0];
            } catch (e) {
                self.appLogger.error(`Failure to identify intel hardware. Error: ${e}`, self.name, true)
                throw new Error(`Failure to identify intel hardware. Error: ${e}`)
            }
        }

        async function moveToFinalTarget(pythonEnvContainmentDir: string): Promise<void> {
            self.appLogger.info(`renaming containment directory ${pythonEnvContainmentDir} to ${self.pythonEnvDir}`, self.name, true)
            try {
                if (filesystem.existsSync(self.pythonEnvDir)) {
                    self.appLogger.info(`Cleaning up previously python environment directory at ${self.pythonEnvDir}`, self.name, true)
                    filesystem.removeSync(self.pythonEnvDir)
                }
                filesystem.move(pythonEnvContainmentDir, self.pythonEnvDir)
                self.appLogger.info(`python environment now available at ${self.pythonEnvDir}`, self.name, true)
            } catch (e) {
                self.appLogger.error(`Failure to rename ${pythonEnvContainmentDir} to ${self.pythonEnvDir}. Error: ${e}`, self.name, true)
                throw new Error(`Failure to rename ${pythonEnvContainmentDir} to ${self.pythonEnvDir}. Error: ${e}`)
            }
        }

        try {
            yield {serviceName: self.name, step: "start", status: "executing", debugMessage: "starting to set up python environment"};

            yield {serviceName: self.name, step: `preparing work directory`, status: "executing", debugMessage: `Cloning archetype python env`};
            const pythonEnvContainmentDir = await setUpWorkEnv()
            yield {serviceName: self.name, step: `preparing work directory`, status: "executing", debugMessage: `Cloning complete`};
            
            yield {serviceName: self.name, step: `install uv`, status: "executing", debugMessage: `installing uv`};
            await installUv(pythonEnvContainmentDir);
            yield {serviceName: self.name, step: `install uv`, status: "executing", debugMessage: `installing uv complete`};

            yield {serviceName: self.name, step: `Detecting intel device`, status: "executing", debugMessage: `Trying to identify intel hardware`};
            const deviceId = await detectDeviceArcMock(pythonEnvContainmentDir)
            yield {serviceName: self.name, step: `Detecting intel device`, status: "executing", debugMessage: `detected intel hardware ${deviceId}`};

            yield {serviceName: self.name, step: `install dependencies`, status: "executing", debugMessage: `installing dependencies`};
            await runUvPipInstallSetup(pythonEnvContainmentDir, deviceId)
            yield {serviceName: self.name, step: `install dependencies`, status: "executing", debugMessage: `dependencies installed`};

            yield {serviceName: self.name, step: `move python environment to target`, status: "executing", debugMessage: `Moving python environment to target place at ${self.pythonEnvDir}`};
            await moveToFinalTarget(pythonEnvContainmentDir)
            yield {serviceName: self.name, step: `move python environment to target`, status: "executing", debugMessage: `Moved to ${self.pythonEnvDir}`};
            yield {serviceName: self.name, step: "end", status: "success", debugMessage: `service set up completely`};
        } catch (e) {
            self.appLogger.warn(`Set up of service failed due to ${e}`, self.name, true)
            self.appLogger.warn(`Aborting set up of ${self.name} service environment`, self.name, true)
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
        // Filter out unsupported devices
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

let instance:  AiBackendService | null = null

export async function aiBackendService() {
    if (instance) {
        return instance
    } else {
        instance = new AiBackendService('ai-backend', await getPort({port: portNumbers(59000, 59999)}))
        return instance
    }
}
