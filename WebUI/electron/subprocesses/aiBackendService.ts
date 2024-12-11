import {LongLivedPythonApiService} from "./apiService.ts";
import {ChildProcess, spawn, spawnSync} from "node:child_process";
import getPort, {portNumbers} from "get-port";
import path from "node:path";
import {app} from "electron";
import * as filesystem from 'fs-extra'
import {spawnProcessSync, existingFileOrError, spawnProcessAsync, copyFileWithDirs} from './osProcessHelper.ts'

class AiBackendService extends LongLivedPythonApiService {
    readonly serviceDir = path.resolve(app.isPackaged ? path.join(process.resourcesPath, "service") : path.join(__dirname, "../../../service"));
    readonly pythonEnvDir = path.resolve(path.join(this.baseDir, `${this.name}-env`));
    readonly pythonExe = this.getPythonPath(this.pythonEnvDir)
    readonly lsLevelZeroExe = this.getLsLevelZeroPath(this.pythonEnvDir)
    healthEndpointUrl = `${this.baseUrl}/healthy`


    private getPythonPath(basePythonEnvDir: string): string {
        return path.resolve(path.join(basePythonEnvDir, "python.exe"))
    }

    private getLsLevelZeroPath(basePythonEnvDir: string): string {
        return path.resolve(path.join(basePythonEnvDir, "Library/bin/ls_level_zero.exe"));
    }

    is_set_up(): boolean {
        return filesystem.existsSync(this.pythonExe) && filesystem.existsSync(this.lsLevelZeroExe)
    }

    set_up(): AsyncIterable<SetupProgress> {
        this.appLogger.info("setting up service", this.name)
        const self = this
        const logToFileHandler = (data: string) => self.appLogger.logMessageToFile(data, self.name)

        async function* installPip(pythonEnvContainmentDir: string): AsyncIterable<SetupProgress> {
            const setUpStep: Promise<void> = new Promise<void>((resolve, reject) => {
                self.appLogger.info(`installing pip into env ${pythonEnvContainmentDir}`, self.name, true)
                try {
                    const pythonExe = existingFileOrError(self.getPythonPath(pythonEnvContainmentDir))
                    const getPipScript = existingFileOrError(path.join(pythonEnvContainmentDir, 'get-pip.py'))
                    spawnProcessSync(pythonExe, [getPipScript], logToFileHandler)
                    self.appLogger.info(`Successfully installed pip into env ${pythonEnvContainmentDir}`, self.name, true)
                    resolve()
                } catch (e) {
                    self.appLogger.error(`Failed to install pip. Error: ${e}`, self.name, true)
                    reject(new Error(`Failed to install pip. Error: ${e}`))
                }
            })

            yield {serviceName: self.name, step: `install pip`, status: "executing", debugMessage: `installing pip`};
            await setUpStep
            yield {serviceName: self.name, step: `install pip`, status: "executing", debugMessage: `installing pip complete`};
        }

        async function* runPipInstallSetup(pythonEnvContainmentDir: string, deviceId: string): AsyncIterable<SetupProgress> {
            const setUpStep: Promise<void> = new Promise<void>(async (resolve, reject) => {
                self.appLogger.info(`installing python dependencies`, self.name, true)
                try {
                    const pythonExe = existingFileOrError(self.getPythonPath(pythonEnvContainmentDir))
                    const deviceSpecificRequirements = existingFileOrError(path.join(self.serviceDir, `requirements-${deviceId}.txt`))
                    const commonRequirements = existingFileOrError(path.join(self.serviceDir, 'requirements.txt'))
                    await spawnProcessAsync(pythonExe, ["-m", "pip", "install", "-r", deviceSpecificRequirements], logToFileHandler)
                    await spawnProcessAsync(pythonExe, ["-m", "pip", "install", "-r", commonRequirements], logToFileHandler)
                    self.appLogger.info(`Successfully installed python dependencies`, self.name, true)
                    resolve()
                } catch (e) {
                    self.appLogger.error(`Failed to install pip. Error: ${e}`, self.name, true)
                    reject(new Error(`Failed to install pip. Error: ${e}`))
                }
            })

            yield {serviceName: self.name, step: `install dependencies`, status: "executing", debugMessage: `installing dependencies`};
            await setUpStep
            yield {serviceName: self.name, step: `install dependencies`, status: "executing", debugMessage: `dependencies installed`};
        }

        async function* setUpWorkEnv(remainingSteps: (pythonEnvContainmentDir :string ) => AsyncIterable<SetupProgress>): AsyncIterable<SetupProgress> {
            const archtypePythonEnv = existingFileOrError(path.join(self.baseDir, "..", "arc-env"))
            const targetPythonEnvContainmentDir = path.resolve(path.join(self.baseDir, `${self.name}-env_tmp`))

            const setUpStep: Promise<string> = new Promise<string>((resolve, reject) => {
                const targetPythonEnvContainmentDir = path.resolve(path.join(self.baseDir, `${self.name}-env_tmp`))
                self.appLogger.info(`Cloning archetype python env ${archtypePythonEnv} into ${targetPythonEnvContainmentDir}`, self.name, true)
                try {
                    if (filesystem.existsSync(targetPythonEnvContainmentDir)) {
                        self.appLogger.info(`Cleaning up previously containment directory at ${targetPythonEnvContainmentDir}`, self.name, true)
                        filesystem.removeSync(targetPythonEnvContainmentDir)
                    }
                    copyFileWithDirs(archtypePythonEnv, targetPythonEnvContainmentDir)
                    resolve(targetPythonEnvContainmentDir)
                } catch (e) {
                    self.appLogger.error(`Failure during set up of workspace. Error: ${e}`, self.name, true)
                    reject(new Error(`Failure during set up of workspace. Error: ${e}`))
                }
            })

            yield {serviceName: self.name, step: `preparing work directory`, status: "executing", debugMessage: `Cloning archetype python env ${archtypePythonEnv} into ${targetPythonEnvContainmentDir}`};
            const deviceId: string = await setUpStep
            yield {serviceName: self.name, step: `preparing work directory`, status: "executing", debugMessage: `Cloning complete`};
            yield* remainingSteps(deviceId)
        }

        async function* detectDeviceArcMock(pythonEnvContainmentDir: string, remainingSteps: (deviceId :string ) => AsyncGenerator<SetupProgress>): AsyncGenerator<SetupProgress> {
            self.appLogger.info("Detecting intel deviceID", self.name)
            const setUpStep : Promise<string> = new Promise(resolve => {
                self.appLogger.info("Copying ls_level_zero.exe", self.name)
                const lsLevelZeroBinaryTargetPath = self.getLsLevelZeroPath(pythonEnvContainmentDir)
                const src = existingFileOrError(path.resolve(path.join(self.serviceDir, "tools/ls_level_zero.exe")));
                copyFileWithDirs(src, lsLevelZeroBinaryTargetPath);
                resolve("arc")
            })

            yield {serviceName: self.name, step: `Detecting intel device`, status: "executing", debugMessage: `Trying to identify intel hardware`};
            const deviceId: string = await setUpStep
            yield {serviceName: self.name, step: `Detecting intel device`, status: "executing", debugMessage: `detected intel hardware ${deviceId}`};
            yield* remainingSteps(deviceId)
        }

        async function* detectDevice(pythonEnvContainmentDir: string, remainingSteps: (deviceId :string ) => AsyncGenerator<SetupProgress>): AsyncGenerator<SetupProgress> {
            self.appLogger.info("Detecting intel deviceID", self.name)
            const setUpStep : Promise<string> = new Promise<string>(async (resolve, reject) => {
                try {
                    // copy ls_level_zero.exe from service/tools to env/Library/bin for SYCL environment
                    self.appLogger.info("Copying ls_level_zero.exe", self.name)
                    const lsLevelZeroBinaryTargetPath = self.getLsLevelZeroPath(pythonEnvContainmentDir)
                    const src = existingFileOrError(path.resolve(path.join(self.serviceDir, "tools/ls_level_zero.exe")));
                    copyFileWithDirs(src, lsLevelZeroBinaryTargetPath);

                    self.appLogger.info("Fetching requirements for ls_level_zero.exe", self.name)
                    const pythonExe = existingFileOrError(self.getPythonPath(pythonEnvContainmentDir))
                    const lsLevelZeroRequirements = existingFileOrError(path.resolve(path.join(self.serviceDir, "requirements-ls_level_zero.txt")));
                    await spawnProcessAsync(pythonExe, ["-m", "pip", "install", "-r", lsLevelZeroRequirements], logToFileHandler)
                    const lsLevelZeroOut = spawnProcessSync(lsLevelZeroBinaryTargetPath, [], logToFileHandler);
                    self.appLogger.info(`ls_level_zero.exe output: ${lsLevelZeroOut}`, self.name)
                    const devices = JSON.parse(lsLevelZeroOut.toString());
                    resolve(devices) // todo: select first in list or reject!
                } catch (e) {
                    self.appLogger.error(`Failure to identify intel hardware. Error: ${e}`, self.name, true)
                    reject(new Error(`Failure to identify intel hardware. Error: ${e}`))
                }
            });

            yield {serviceName: self.name, step: `Detecting intel device`, status: "executing", debugMessage: `Trying to identify intel hardware`};
            const deviceId: string = await setUpStep
            yield {serviceName: self.name, step: `Detecting intel device`, status: "executing", debugMessage: `detected intel hardware ${deviceId}`};
            yield* remainingSteps(deviceId)
        }

        async function* moveToFinalTarget(pythonEnvContainmentDir: string): AsyncGenerator<SetupProgress> {
            const setUpStep : Promise<void> = new Promise<void>((resolve, reject) => {
                self.appLogger.info(`renaming containment directory ${pythonEnvContainmentDir} to ${self.pythonEnvDir}`, self.name, true)
                try {
                    if (filesystem.existsSync(self.pythonEnvDir)) {
                        self.appLogger.info(`Cleaning up previously python environment directory at ${self.pythonEnvDir}`, self.name, true)
                        filesystem.removeSync(self.pythonEnvDir)
                    }
                    filesystem.move(pythonEnvContainmentDir, self.pythonEnvDir)
                    self.appLogger.info(`python environment now available at ${self.pythonEnvDir}`, self.name, true)
                    resolve()
                } catch (e) {
                    self.appLogger.error(`Failure to rename ${pythonEnvContainmentDir} to ${self.pythonEnvDir}. Error: ${e}`, self.name, true)
                    reject(new Error(`Failure to rename ${pythonEnvContainmentDir} to ${self.pythonEnvDir}. Error: ${e}`))
                }
            });

            yield {serviceName: self.name, step: `move python environment to target`, status: "executing", debugMessage: `Moving python environment to target place at ${self.pythonEnvDir}`};
            await setUpStep
            yield {serviceName: self.name, step: `move python environment to target`, status: "executing", debugMessage: `Moved to ${self.pythonEnvDir}`};
        }

        return async function* () {
            try {
                yield {serviceName: self.name, step: "start", status: "executing", debugMessage: "starting to set up python environment"};
                yield* setUpWorkEnv(async function* (pythonEnvContainmentDir: string) {
                    yield* installPip(pythonEnvContainmentDir)
                    yield* detectDeviceArcMock(pythonEnvContainmentDir, async function* (deviceId: string) {
                        yield* runPipInstallSetup(pythonEnvContainmentDir, deviceId)
                    })
                    yield* moveToFinalTarget(pythonEnvContainmentDir)
                    yield {serviceName: self.name, step: "end", status: "success", debugMessage: `service set up completely`};
                });   
            } catch (e) {
                self.appLogger.warn(`Set up of service failed due to ${e}`, self.name, true)
                self.appLogger.warn(`Aborting set up of ${self.name} service environment`, self.name, true)
                yield {serviceName: self.name, step: "end", status: "failed", debugMessage: `Failed to setup python environment due to ${e}`};
            }
        }()
    }


    spawnAPIProcess(): {process: ChildProcess, didProcessExitEarlyTracker: Promise<boolean>} {
        const additionalEnvVariables = {
            "SYCL_ENABLE_DEFAULT_CONTEXTS": "1",
            "SYCL_CACHE_PERSISTENT": "1",
            "PYTHONIOENCODING": "utf-8",
            ...this.getSupportedDeviceEnvVariable(),
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

let instance:  AiBackendService | null = null

export async function aiBackendService() {
    if (instance) {
        return instance
    } else {
        instance = new AiBackendService('ai-backend', await getPort({port: portNumbers(59000, 59999)}))
        return instance
    }
}
