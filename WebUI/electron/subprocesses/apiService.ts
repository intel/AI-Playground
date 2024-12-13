import {ChildProcess} from "node:child_process";
import path from "node:path";
import {app, BrowserWindow} from "electron";
import {appLoggerInstance} from "../logging/logger.ts";
import fs from "fs";
import {copyFileWithDirs, existingFileOrError, spawnProcessAsync, spawnProcessSync} from "./osProcessHelper.ts";
import * as filesystem from "fs-extra";
import {z} from "zod";

export const aiBackendServiceDir = () => path.resolve(app.isPackaged ? path.join(process.resourcesPath, "service") : path.join(__dirname, "../../../service"));

const LsLevelZeroDeviceSchema = z.object({id: z.number(), name: z.string(), device_id: z.number()});
const LsLevelZeroOutSchema = z.array(LsLevelZeroDeviceSchema).min(1);
type LsLevelZeroDevice = z.infer<typeof LsLevelZeroDeviceSchema>;

export function getLsLevelZeroPath(basePythonEnvDir: string): string {
    return path.resolve(path.join(basePythonEnvDir, "Library/bin/ls_level_zero.exe"));
}
export function getPythonPath(basePythonEnvDir: string): string {
    return path.resolve(path.join(basePythonEnvDir, "python.exe"))
}

const ipexWheel = "intel_extension_for_pytorch-2.3.110+xpu-cp311-cp311-win_amd64.whl"
export const ipexIndex = 'https://pytorch-extension.intel.com/release-whl/stable/xpu/cn/'
export const ipexVersion = 'intel-extension-for-pytorch==2.3.110.post0+xpu'

export interface ApiService {
    readonly name: string
    readonly baseUrl: string
    readonly port: number
    readonly isRequired: boolean
    currentStatus: BackendStatus;
    isSetUp: boolean;

    set_up(): AsyncIterable<SetupProgress>;
    start(): Promise<BackendStatus>;
    stop(): Promise<BackendStatus>;
    get_info(): ApiServiceInformation;
}

export abstract class LongLivedPythonApiService implements ApiService {
    readonly name: string
    readonly baseUrl: string
    readonly port: number
    readonly win: BrowserWindow
    abstract readonly isRequired: boolean
    abstract healthEndpointUrl: string

    encapsulatedProcess: ChildProcess | null = null

    readonly baseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../../");
    readonly prototypicalPythonEnv = path.join(this.baseDir, "prototype-python-env")
    readonly customIntelExtensionForPytorch = path.join(this.baseDir, ipexWheel)
    abstract readonly serviceDir: string
    abstract readonly pythonExe: string
    abstract isSetUp: boolean;

    desiredStatus: BackendStatus = "uninitialized"
    currentStatus: BackendStatus = "uninitialized"

    readonly appLogger = appLoggerInstance

    constructor(name: string, port: number, win: BrowserWindow) {
        this.win = win
        this.name = name
        this.port = port
        this.baseUrl = `http://127.0.0.1:${port}`
    }

    abstract serviceIsSetUp(): boolean

    updateStatus() {
        this.isSetUp = this.serviceIsSetUp();
        this.win.webContents.send("serviceInfoUpdate", this.get_info());
    }

    get_info(): ApiServiceInformation {
        return {
            serviceName: this.name,
            status: this.currentStatus,
            baseUrl: this.baseUrl,
            port: this.port,
            isSetUp: this.isSetUp,
            isRequired: this.isRequired
        }
    }

    set_up(): AsyncIterable<SetupProgress> {
        this.appLogger.info("called setup function", this.name)
        const self = this

        async function* generateSequence(): AsyncGenerator<SetupProgress> {
            for (let i = 0; i <= 5; i++) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                yield {serviceName: self.name, step: `Step_${i}`, status: "executing", debugMessage: ""};
            }
        }
        return generateSequence();
    }

    async start(): Promise<BackendStatus> {
        if (this.desiredStatus === "stopped" && this.currentStatus !== "stopped") {
            throw new Error('Server currently stopping. Cannot start it.')
        }
        if (this.currentStatus === "running") {
            return "running"
        }
        if (this.desiredStatus === "running") {
            throw new Error('Server startup already requested')
        }

        this.desiredStatus = "running"
        try {
            this.appLogger.info(` trying to start ${this.name} python API`, this.name)
            const trackedProcess = this.spawnAPIProcess()
            this.encapsulatedProcess = trackedProcess.process
            this.pipeProcessLogs(trackedProcess.process)
            if (await this.listenServerReady(trackedProcess.didProcessExitEarlyTracker)) {
                this.currentStatus = "running"
                this.appLogger.info(`started server ${this.name} on ${this.baseUrl}`, this.name)
            } else {
                this.currentStatus = "failed"
                this.desiredStatus = "failed"
                this.appLogger.error(`server ${this.name} failed to boot`, this.name)
                this.encapsulatedProcess?.kill()
            }
        } catch (error) {
            this.appLogger.error(` failed to start server due to ${error}`, this.name)
            this.currentStatus = "failed"
            this.desiredStatus = "failed"
            this.encapsulatedProcess?.kill()
            this.encapsulatedProcess = null
            throw error;
        } finally {
            this.win.webContents.send("serviceInfoUpdate", this.get_info());
        }
        return this.currentStatus;
    }


    async stop(): Promise<BackendStatus> {
        this.appLogger.info(`Stopping backend ${this.name}. It was in state ${this.currentStatus}`, this.name)
        this.desiredStatus = "stopped"
        this.encapsulatedProcess?.kill()
        this.encapsulatedProcess = null
        this.currentStatus = "stopped"
        return "stopped"
    }

    abstract spawnAPIProcess(): { process: ChildProcess, didProcessExitEarlyTracker: Promise<boolean> }

    pipeProcessLogs(process: ChildProcess) {
        process.stdout!.on('data', (message) => {
            if (message.toString().startsWith('INFO')) {
                this.appLogger.info(`${message}`, this.name)
            } else if (message.toString().startsWith('WARN')) {
                this.appLogger.warn(`${message}`, this.name)
            } else {
                this.appLogger.error(`${message}`, this.name)
            }
        })

        process.stderr!.on('data', (message) => {
            this.appLogger.error(`${message}`, this.name)
        })
        process.on('error', (message) => {
            this.appLogger.error(`backend process ${this.name} exited abruptly due to : ${message}`, this.name)
        })
    }


    async listenServerReady(didProcessExitEarlyTracker: Promise<boolean>): Promise<boolean> {
        const startTime = performance.now()
        const processStartupCompletePromise = new Promise<boolean>(async (resolve) => {
            const queryIntervalMs = 250
            const startupPeriodMaxMs = 60000
            while (performance.now() < startTime + startupPeriodMaxMs) {
                try {
                    const serviceHealthResponse = await fetch(this.healthEndpointUrl);
                    this.appLogger.info(`received response: ${serviceHealthResponse.status}`, "promise")
                    if (serviceHealthResponse.status === 200) {
                        const endTime = performance.now()
                        this.appLogger.info(`${this.name} server startup complete after ${(endTime - startTime) / 1000} seconds`, this.name)
                        resolve(true)
                        break
                    }
                } catch (e) {
                    //fetch will simply fail while server not up
                }
                await new Promise<void>(resolve => setTimeout(resolve, queryIntervalMs));
            }
            if (performance.now() >= startTime + startupPeriodMaxMs) {
                this.appLogger.warn(`Server ${this.name} did not return healthy response within ${startupPeriodMaxMs / 1000} seconds`, this.name)
                resolve(false)
            }
        })

        const processStartupFailedDueToEarlyExit = didProcessExitEarlyTracker.then(earlyExit => !earlyExit)

        return await Promise.race([processStartupFailedDueToEarlyExit, processStartupCompletePromise])
    }

    protected commonSetupSteps = {

        detectDeviceArcMock: async (pythonEnvContainmentDir: string): Promise<string> => {
            this.appLogger.info("Detecting intel deviceID", this.name)
            this.appLogger.info("Copying ls_level_zero.exe", this.name)
            const lsLevelZeroBinaryTargetPath = getLsLevelZeroPath(pythonEnvContainmentDir)
            const src = existingFileOrError(path.resolve(path.join(aiBackendServiceDir(), "tools/ls_level_zero.exe")));
            copyFileWithDirs(src, lsLevelZeroBinaryTargetPath);

            return 'cuda';
        },

        detectDevice: async (pythonEnvContainmentDir: string): Promise<string> => {
            this.appLogger.info("Detecting intel deviceID", this.name)
            try {
                // copy ls_level_zero.exe from service/tools to env/Library/bin for SYCL environment
                this.appLogger.info("Copying ls_level_zero.exe", this.name)
                const lsLevelZeroBinaryTargetPath = getLsLevelZeroPath(pythonEnvContainmentDir)
                const src = existingFileOrError(path.resolve(path.join(aiBackendServiceDir(), "tools/ls_level_zero.exe")));
                copyFileWithDirs(src, lsLevelZeroBinaryTargetPath);

                this.appLogger.info("Fetching requirements for ls_level_zero.exe", this.name)
                const pythonExe = existingFileOrError(getPythonPath(pythonEnvContainmentDir))
                const lsLevelZeroRequirements = existingFileOrError(path.resolve(path.join(aiBackendServiceDir(), "requirements-ls_level_zero.txt")));
                await spawnProcessAsync(pythonExe, ["-m", "uv", "pip", "install", "-r", lsLevelZeroRequirements], (data: string) => {this.appLogger.logMessageToFile(data, this.name)})
                const lsLevelZeroOut = spawnProcessSync(lsLevelZeroBinaryTargetPath, [], (data: string) => {this.appLogger.logMessageToFile(data, this.name)});
                this.appLogger.info(`ls_level_zero.exe output: ${lsLevelZeroOut}`, this.name)
                const devices = LsLevelZeroOutSchema.parse(JSON.parse(lsLevelZeroOut));
                return devices[0].name.toLowerCase().includes("arc") ? "arc" : "ultra"
            } catch (e) {
                return "cuda"
                this.appLogger.error(`Failure to identify intel hardware. Error: ${e}`, this.name, true)
                throw new Error(`Failure to identify intel hardware. Error: ${e}`)
            }
        },

        copyArchetypePythonEnv: async (targetDir: string) => {
            const archtypePythonEnv = existingFileOrError(this.prototypicalPythonEnv)
            this.appLogger.info(`Cloning archetype python env ${archtypePythonEnv} into ${targetDir}`, this.name, true)
            try {
                if (filesystem.existsSync(targetDir)) {
                    this.appLogger.info(`Cleaning up previously containment directory at ${targetDir}`, this.name, true)
                    filesystem.removeSync(targetDir)
                }
                copyFileWithDirs(archtypePythonEnv, targetDir)
                return targetDir;
            } catch (e) {
                this.appLogger.error(`Failure during set up of workspace. Error: ${e}`, this.name, true)
                throw new Error(`Failure during set up of workspace. Error: ${e}`)
            }
        },

        installUv: async (pythonEnvDir: string) => {
            this.appLogger.info(`installing uv into env ${pythonEnvDir}`, this.name, true)
            try {
                const pythonExe = existingFileOrError(getPythonPath(pythonEnvDir))
                const getPipScript = existingFileOrError(path.join(pythonEnvDir, 'get-pip.py'))
                await spawnProcessAsync(pythonExe, [getPipScript], (data: string) => {this.appLogger.logMessageToFile(data, this.name)})
                await spawnProcessAsync(pythonExe, ["-m", "pip", "install", "uv"], (data: string) => {this.appLogger.logMessageToFile(data, this.name)})
                this.appLogger.info(`Successfully installed uv into env ${pythonEnvDir}`, this.name, true)
            } catch (e) {
                this.appLogger.error(`Failed to install uv for env ${pythonEnvDir}. Error: ${e}`, this.name, true)
                throw new Error(`Failed to install uv. Error: ${e}`);
            }
        },

        uvPipInstallRequirementsTxtStep: async (pythonEnvDir: string, requirementsTextPath: string, skipOnMissingRequirementsTxt = false) => {
            if (skipOnMissingRequirementsTxt && !fs.existsSync(requirementsTextPath)) {
                this.appLogger.info(`No requirements.txt for ${requirementsTextPath} - skipping`, this.name, true)
                return
            }
            try {
                const pythonExe = existingFileOrError(getPythonPath(pythonEnvDir))
                this.appLogger.info(`Installing python dependencies for ${pythonEnvDir}`, this.name, true)
                await spawnProcessAsync(pythonExe, ["-m", "uv", "pip", "install", "-r", requirementsTextPath, "--index-strategy", "unsafe-best-match"], (data: string) => {this.appLogger.logMessageToFile(data, this.name)})
                this.appLogger.info(`Successfully installed python dependencies for ${pythonEnvDir}`, this.name, true)
            } catch (e) {
                this.appLogger.error(`Failure during installation of python dependencies for ${pythonEnvDir}. Error: ${e}`, this.name, true)
                throw new Error(`Failed to install python dependencies for ${pythonEnvDir}. Error: ${e}`)
            }
        },

        uvInstallDependencyStep: async (pythonEnvDir: string, dependency: string, extraIndex?: string) => {
            try {
                const pythonExe = existingFileOrError(getPythonPath(pythonEnvDir))
                this.appLogger.info(`Installing dependency ${dependency} for ${pythonEnvDir}`, this.name, true)
                const extraIndexArgs = extraIndex ? ["--extra-index-url", extraIndex] : []
                await spawnProcessAsync(pythonExe, ["-m", "uv", "pip", "install", dependency, "--index-strategy", "unsafe-best-match", ...extraIndexArgs], (data: string) => {this.appLogger.logMessageToFile(data, this.name)})
                this.appLogger.info(`Successfully installed of dependency ${dependency} for ${pythonEnvDir}`, this.name, true)
            } catch (e) {
                this.appLogger.error(`Failure during installation of dependency ${dependency} for ${pythonEnvDir}. Error: ${e}`, this.name, true)
                throw new Error(`Failed to install of dependency ${dependency} for ${pythonEnvDir}. Error: ${e}`)
            }
        },

        pipInstallDependencyStep: async (pythonEnvDir: string, dependency: string) => {
            try {
                const pythonExe = existingFileOrError(getPythonPath(pythonEnvDir))
                this.appLogger.info(`Installing dependency ${dependency} for ${pythonEnvDir}`, this.name, true)
                await spawnProcessAsync(pythonExe, ["-m","pip", "install", dependency], (data: string) => {this.appLogger.logMessageToFile(data, this.name)})
                this.appLogger.info(`Successfully installed of dependency ${dependency} for ${pythonEnvDir}`, this.name, true)
            } catch (e) {
                this.appLogger.error(`Failure during installation of dependency ${dependency} for ${pythonEnvDir}. Error: ${e}`, this.name, true)
                throw new Error(`Failed to install of dependency ${dependency} for ${pythonEnvDir}. Error: ${e}`)
            }
        },
        
        moveToFinalTarget: async (src: string, target: string) => {
            this.appLogger.info(`renaming directory ${src} to ${target}`, this.name, true)
            try {
                if (filesystem.existsSync(target)) {
                    this.appLogger.info(`Cleaning up previously resource directory at ${target}`, this.name, true)
                    filesystem.removeSync(target)
                }
                await filesystem.move(src, target)
                this.appLogger.info(`resources now available at ${target}`, this.name, true)
            } catch (e) {
                this.appLogger.error(`Failure to rename ${src} to ${target}. Error: ${e}`, this.name, true)
                throw new Error(`Failure to rename ${src} to ${target}. Error: ${e}`)
            }
        },
    };
}
