import {ChildProcess} from "node:child_process";
import path from "node:path";
import {app} from "electron";
import {appLoggerInstance} from "../logging/logger.ts";


export interface ApiService {
    readonly name: string
    readonly baseUrl: string
    currentStatus: BackendStatus;

    set_up(): AsyncIterable<SetupProgress>;
    is_set_up(): boolean;
    start(): Promise<BackendStatus>;
    stop(): Promise<BackendStatus>;
}

export abstract class LongLivedPythonApiService implements ApiService {
    readonly name: string
    readonly baseUrl: string
    readonly port: Number
    abstract healthEndpointUrl: string

    encapsulatedProcess: ChildProcess | null = null

    readonly baseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../../");
    readonly archtypePythonEnv = path.join(this.baseDir, "env")
    abstract readonly serviceDir: string
    abstract readonly pythonExe: string

    desiredStatus: BackendStatus = {status: "uninitialized"}
    currentStatus: BackendStatus = {status: "uninitialized"}

    readonly appLogger = appLoggerInstance

    constructor(name: string, port: Number) {
        this.name = name
        this.port = port
        this.baseUrl = `http://127.0.0.1:${port}`
    }

    static getPythonPath(basePythonEnvDir: string): string {
        return path.resolve(path.join(basePythonEnvDir, "bin", "python"))
    }

    abstract is_set_up(): boolean

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

    start(): Promise<BackendStatus> {
        if (this.desiredStatus.status === "stopped" && this.currentStatus.status !== "stopped") {
            return Promise.reject('Server currently stopping. Cannot start it.')
        }
        if (this.currentStatus.status === "running") {
            return Promise.resolve({status: "running"})
        }
        if (this.desiredStatus.status === "running") {
            return Promise.reject('Server startup already requested')
        }

        this.desiredStatus = {status: "running"}
        return new Promise<BackendStatus>(async (resolve, reject) => {
            try {
                this.appLogger.info(` trying to start ${this.name} python API`, this.name)
                const trackedProcess = this.spawnAPIProcess()
                this.encapsulatedProcess = trackedProcess.process
                this.pipeProcessLogs(trackedProcess.process)
                if (await this.listenServerReady(trackedProcess.didProcessExitEarlyTracker)) {
                    this.currentStatus = {status: "running"}
                    this.appLogger.info(`started server ${this.name} on ${this.baseUrl}`, this.name)
                    return resolve({status: "running"});
                } else {
                    this.currentStatus = {status: "failed"}
                    this.appLogger.error(`server ${this.name} failed to boot`, this.name)
                    this.encapsulatedProcess?.kill()
                    return resolve({status: "failed"});
                }
            } catch (error) {
                this.appLogger.error(` failed to start server due to ${error}`, this.name)
                this.currentStatus = {status: "failed"}
                this.encapsulatedProcess?.kill()
                this.encapsulatedProcess = null
                return reject(error)
            }
        })
    }


    stop(): Promise<BackendStatus> {
        this.appLogger.info(`Stopping backend ${this.name}. It was in state ${this.currentStatus.status}`, this.name)
        this.desiredStatus = {status: "stopped"}
        this.encapsulatedProcess?.kill()
        this.encapsulatedProcess = null
        this.currentStatus = {status: "stopped"}
        return Promise.resolve({status: "stopped"})
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
            const startupPeriodMaxMs = 30000
            while (performance.now() < startTime + startupPeriodMaxMs) {
                try {
                    const serviceHealthResponse = await fetch(this.healthEndpointUrl);
                    this.appLogger.info(`received response: ${serviceHealthResponse}`, "promise")
                    if (serviceHealthResponse.status === 200) {
                        const endTime = performance.now()
                        this.appLogger.info(`${this.name} server startup complete after ${endTime - startTime / 1000} seconds`, this.name)
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
}
