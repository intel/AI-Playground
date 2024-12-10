import {LongLivedPythonApiService} from "./apiService.ts";
import {ChildProcess, spawn, spawnSync} from "node:child_process";
import getPort, {portNumbers} from "get-port";
import path from "node:path";
import {app} from "electron";
import * as fs from 'fs-extra'
import {spawnProcessSync, existingFileOrError} from './osProcessHelper.ts'

class AiBackendService extends LongLivedPythonApiService {
    readonly serviceDir = path.resolve(app.isPackaged ? path.join(process.resourcesPath, "service") : path.join(__dirname, "../../../service"));
    readonly pythonEnvDir = path.resolve(path.join(this.baseDir, "env"));
    readonly pythonExe = path.resolve(path.join(this.pythonEnvDir, "python.exe"));
    healthEndpointUrl = `${this.baseUrl}/healthy`

    set_up(): AsyncIterable<SetupProgress> {
        this.appLogger.info("setting up service", this.name)
        const self = this


        async function installPip(pythonEnvContainmentDir: string): Promise<SetupProgress> {

        }

        async function runPipInstallSetup(pythonEnvContainmentDir: string, deviceId: string): Promise<SetupProgress> {

        }

        function setUpWorkEnv(remainingSteps: (pythonEnvContainmentDir :string ) => AsyncIterable<SetupProgress>): AsyncIterable<SetupProgress> {
            const archtypePythonEnv = path.resolve(path.join(self.baseDir, "env"))
            const targetPythonEnvContainmentDir = path.resolve(path.join(self.baseDir, `${self.name}-env_tmp`))

            const setUpStep: Promise<string> = new Promise<string>((resolve, reject) => {
                const archtypePythonEnv = path.resolve(path.join(self.baseDir, "env"))
                const targetPythonEnvContainmentDir = path.resolve(path.join(self.baseDir, `${self.name}-env_tmp`))
                self.appLogger.info(`Cloning archetype python env ${archtypePythonEnv} into ${targetPythonEnvContainmentDir}`, self.name, true)
                try {
                    if (fs.existsSync(targetPythonEnvContainmentDir)) {
                        self.appLogger.info(`Cleaning up previously containment directory at ${targetPythonEnvContainmentDir}`, self.name, true)
                        fs.removeSync(targetPythonEnvContainmentDir)
                    }
                    fs.cpSync(archtypePythonEnv, targetPythonEnvContainmentDir)
                    resolve(targetPythonEnvContainmentDir)
                } catch (e) {
                    self.appLogger.error(`Failure during set up of workspace. Error: ${e}`, self.name, true)
                    reject(`Failure during set up of workspace. Error: ${e}`)
                }
            })

            return (async function* () {
                yield {serviceName: self.name, step: `preparing work directory`, status: "executing", debugMessage: `Cloning archetype python env ${archtypePythonEnv} into ${targetPythonEnvContainmentDir}`};
                try {
                    const deviceId: string = await setUpStep
                    yield* remainingSteps(deviceId)
                } catch (e) {
                    yield {serviceName: self.name, step: `preparing work directory`, status: "failed", debugMessage: `failure to prepare work directory: ${e}. `};
                }
            })()
        }

        async function* detectDevice(pythonEnvContainmentDir: string, remainingSteps: (deviceId :string ) => AsyncGenerator<SetupProgress>): AsyncGenerator<SetupProgress> {
            self.appLogger.info("Detecting intel deviceID", self.name)
            const setUpStep : Promise<string> = new Promise<string>((resolve, reject) => {
                try {
                    // copy ls_level_zero.exe from service/tools to env/Library/bin for SYCL environment
                    self.appLogger.info("Copying ls_level_zero.exe", self.name)
                    const lsLevelZeroBinaryTargetPath = path.resolve(path.join(pythonEnvContainmentDir, "Library/bin/ls_level_zero.exe"));
                    const src = existingFileOrError(path.resolve(path.join(self.serviceDir, "tools/ls_level_zero.exe")));
                    fs.copyFileSync(src, lsLevelZeroBinaryTargetPath);

                    self.appLogger.info("Fetching requirements for ls_level_zero.exe", self.name)
                    const lsLevelZeroRequirements = existingFileOrError(path.resolve(path.join(self.serviceDir, "requirements-ls_level_zero.txt")));
                    await runPipInstall(pythonEnvContainmentDir, lsLevelZeroRequirements) //should be non evaluating expression to just call the process, not the top one

                    const lsLevelZeroOut = spawnProcessSync(lsLevelZeroBinaryTargetPath);
                    self.appLogger.info(`ls_level_zero.exe output: ${lsLevelZeroOut}`, self.name)
                    const devices = JSON.parse(lsLevelZeroOut.toString());
                    return devices // todo: select first in list or reject!
                } catch (e) {
                    self.appLogger.error(`Failure to identify intel hardware. Error: ${e}`, self.name, true)
                    reject(`Failure to identify intel hardware. Error: ${e}`)
                }
            });

            yield {serviceName: self.name, step: `Detecting intel device`, status: "executing", debugMessage: `Trying to identify intel hardware`};
            try {
                const deviceId: string = await setUpStep
                yield* remainingSteps(deviceId)
            } catch (e) {
                yield {serviceName: self.name, step: `Detecting intel device`, status: "failed", debugMessage: `Failure to identify intel hardware. Error: ${e}. `};
            }
        }

        async function* moveToFinalTarget(pythonEnvContainmentDir: string): AsyncGenerator<SetupProgress> {
            const setUpStep : Promise<void> = new Promise<void>((resolve, reject) => {
                self.appLogger.info(`renaming containment directory ${pythonEnvContainmentDir} to ${self.pythonEnvDir}`, self.name, true)
                try {
                    if (fs.existsSync(self.pythonEnvDir)) {
                        self.appLogger.info(`Cleaning up previously pyenv directory at ${self.pythonEnvDir}`, self.name, true)
                        fs.removeSync(self.pythonEnvDir)
                    }
                    fs.move(pythonEnvContainmentDir, self.pythonEnvDir)
                    self.appLogger.info(`pyenv now available at ${self.pythonEnvDir}`, self.name, true)
                    resolve()
                } catch (e) {
                    self.appLogger.error(`Failure to rename ${pythonEnvContainmentDir} to ${self.pythonEnvDir}. Error: ${e}`, self.name, true)
                    reject(`Failure to rename ${pythonEnvContainmentDir} to ${self.pythonEnvDir}. Error: ${e}`)
                }
            });

            yield {serviceName: self.name, step: `move pyenv to target`, status: "executing", debugMessage: `Moving pyenv to target place at ${self.pythonEnvDir}`};
            try {
                await setUpStep
                yield {serviceName: self.name, step: `move pyenv to target`, status: "failed", debugMessage: `Moving pyenv to target place at ${self.pythonEnvDir}`};
            } catch (e) {
                yield {serviceName: self.name, step: `move pyenv to target`, status: "failed", debugMessage: `Moving pyenv to target place at ${self.pythonEnvDir}`};
            }
        }

        return setUpWorkEnv(async function* (pythonEnvContainmentDir: string) {
            yield installPip(pythonEnvContainmentDir)
            yield* detectDevice(pythonEnvContainmentDir, async function* (deviceId: string) {
                yield runPipInstallSetup(pythonEnvContainmentDir, deviceId)
                yield runPipInstallSetup(pythonEnvContainmentDir, deviceId)

            })
            yield* moveToFinalTarget(pythonEnvContainmentDir)
        });
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
