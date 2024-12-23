import {ChildProcess} from "node:child_process";
import path from "node:path";
import {app, BrowserWindow} from "electron";
import {appLoggerInstance} from "../logging/logger.ts";
import fs from "fs";
import * as filesystem from "fs-extra";

export const aiBackendServiceDir = () => path.resolve(app.isPackaged ? path.join(process.resourcesPath, "service") : path.join(__dirname, "../../../service"));

const ipexWheel = "intel_extension_for_pytorch-2.3.110+xpu-cp311-cp311-win_amd64.whl"

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
    readonly name: BackendServiceName
    readonly baseUrl: string
    readonly port: number
    readonly win: BrowserWindow
    readonly settings: LocalSettings
    abstract readonly isRequired: boolean
    abstract healthEndpointUrl: string

    encapsulatedProcess: ChildProcess | null = null

    readonly baseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../../");
    readonly prototypicalPythonEnv = app.isPackaged ? path.join(this.baseDir, "prototype-python-env") : path.join(this.baseDir, "build-envs/online/prototype-python-env")
    readonly customIntelExtensionForPytorch = path.join(app.isPackaged ? this.baseDir : path.join(__dirname, "../../external/"), ipexWheel)
    abstract readonly pythonEnvDir: string
    abstract readonly lsLevelZeroDir: string
    abstract readonly serviceDir: string
    abstract isSetUp: boolean;

    desiredStatus: BackendStatus = "uninitializedStatus"
    currentStatus: BackendStatus = "uninitializedStatus"

    readonly appLogger = appLoggerInstance

    constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
        this.win = win
        this.name = name
        this.port = port
        this.baseUrl = `http://127.0.0.1:${port}`
        this.settings = settings
    }

    abstract serviceIsSetUp(): boolean

    setStatus(status: BackendStatus) {
        this.currentStatus = status
        this.updateStatus()
    }

    updateStatus() {
        this.win.webContents.send("serviceInfoUpdate", this.get_info());
    }

    get_info(): ApiServiceInformation {
        if(this.currentStatus === "uninitializedStatus") {
            this.currentStatus = this.isSetUp ? "notYetStarted" : "notInstalled"
        }
        return {
            serviceName: this.name,
            status: this.currentStatus,
            baseUrl: this.baseUrl,
            port: this.port,
            isSetUp: this.isSetUp,
            isRequired: this.isRequired
        }
    }

    abstract set_up(): AsyncIterable<SetupProgress>

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
        this.setStatus('starting')
        try {
            this.appLogger.info(` trying to start ${this.name} python API`, this.name)
            const trackedProcess = await this.spawnAPIProcess()
            this.encapsulatedProcess = trackedProcess.process
            this.pipeProcessLogs(trackedProcess.process)
            if (await this.listenServerReady(trackedProcess.didProcessExitEarlyTracker)) {
                this.currentStatus = "running"
                this.appLogger.info(`started server ${this.name} on ${this.baseUrl}`, this.name)
            } else {
                this.currentStatus = "failed"
                this.desiredStatus = "failed"
                this.isSetUp = false
                this.appLogger.error(`server ${this.name} failed to boot`, this.name)
                this.encapsulatedProcess?.kill()
            }
        } catch (error) {
            this.appLogger.error(` failed to start server due to ${error}`, this.name)
            this.currentStatus = "failed"
            this.desiredStatus = "failed"
            this.isSetUp = false
            this.encapsulatedProcess?.kill()
            this.encapsulatedProcess = null
        } finally {
            this.win.webContents.send("serviceInfoUpdate", this.get_info());
        }
        return this.currentStatus;
    }


    async stop(): Promise<BackendStatus> {
        this.appLogger.info(`Stopping backend ${this.name}. It was in state ${this.currentStatus}`, this.name)
        this.desiredStatus = "stopped"
        this.setStatus('stopping')
        this.encapsulatedProcess?.kill()
        await new Promise(resolve => {
            setTimeout(() => {
                resolve("killedprocess (hopefully)")
            }, 1000)
        })

        this.encapsulatedProcess = null
        this.currentStatus = "stopped"
        return "stopped"
    }

    abstract spawnAPIProcess(): Promise<{ process: ChildProcess; didProcessExitEarlyTracker: Promise<boolean>; }>

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
            const startupPeriodMaxMs = 120000
            while (performance.now() < startTime + startupPeriodMaxMs) {
                try {
                    const serviceHealthResponse = await fetch(this.healthEndpointUrl);
                    this.appLogger.info(`received response: ${serviceHealthResponse.status}`, this.name)
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
        moveToFinalTarget: async (src: string, target: string) => {
            this.appLogger.info(`renaming directory ${src} to ${target}`, this.name, true)
            try {
                if (filesystem.existsSync(target)) {
                    this.appLogger.info(`Cleaning up previously resource directory at ${target}`, this.name, true)
                    await fs.promises.rm(target, {recursive: true, force: true})
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
