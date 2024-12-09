import {ChildProcess, spawnSync} from "node:child_process";
import path from "node:path";
import {app} from "electron";
import fs from "fs";
import {appLoggerInstance} from "../logging/logger.ts";

export interface ApiService {
    readonly name: string
    readonly baseUrl: string
    currentStatus: BackendStatus;

    setup(): Promise<void>;
    start(): Promise<BackendStatus>;
    stop(): Promise<BackendStatus>;
}

export abstract class LongLivedPythonApiService implements ApiService {
    readonly name: string
    readonly baseUrl: string
    readonly port: Number

    constructor(name: string, port: Number) {
        this.name = name
        this.port = port
        this.baseUrl = `http://127.0.0.1:${port}`
    }

    readonly appLogger = appLoggerInstance

    desiredStatus: BackendStatus = {status: "uninitialized"}
    currentStatus: BackendStatus = {status: "uninitialized"}
    encapsulatedProcess: ChildProcess | null = null

    readonly baseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../../");
    abstract readonly workDir: string
    abstract readonly pythonExe: string

    setup(): Promise<void> {
        //TODO setup with pip install etc
        return Promise.resolve();
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
                const trackedProcess = this.spawnAPIProcess()
                this.encapsulatedProcess = trackedProcess.process
                if (await this.listenServerReady(trackedProcess.process, trackedProcess.didProcessExitEarlyTracker)) {
                    this.currentStatus = {status: "running"}
                    this.appLogger.info(`started server ${this.name} on ${this.baseUrl}`, this.name)
                    return resolve({status: "running"});
                } else {
                    this.currentStatus = {status: "failed"}
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

    abstract spawnAPIProcess(): {process: ChildProcess, didProcessExitEarlyTracker: Promise<boolean>}

    abstract listenServerReady(process: ChildProcess, didProcessExitEarlyTracker: Promise<boolean>): Promise<boolean>

    getSupportedDeviceEnvVariable(): { ONEAPI_DEVICE_SELECTOR: string; } {
        // Filter out unsupported devices
        // Filter out unsupported devices
        try {
            const lsLevelZeroDevices = path.resolve(path.join(this.baseDir, "service/tools/ls_level_zero.exe"));
            // copy ls_level_zero.exe to env/Library/bin for SYCL environment
            const dest = path.resolve(path.join(this.pythonExe, "../Library/bin/ls_level_zero.exe"));
            fs.copyFileSync(lsLevelZeroDevices, dest);
            const ls = spawnSync(dest);
            this.appLogger.info(`ls_level_zero.exe stdout: ${ls.stdout.toString()}`, this.name);
            const devices: {name: string, device_id: number, id: string}[] = JSON.parse(ls.stdout.toString()); // TODO: use zod to parse output
            const supportedIDs = devices.filter(device => device.name.toLowerCase().includes("arc") || device.device_id === 0xE20B).map(device => device.id);
            const additionalEnvVariables = {ONEAPI_DEVICE_SELECTOR: "level_zero:" + supportedIDs.join(",")};
            this.appLogger.info(`Set ONEAPI_DEVICE_SELECTOR=${additionalEnvVariables["ONEAPI_DEVICE_SELECTOR"]}`, this.name);
            return additionalEnvVariables;
        } catch (error) {
            this.appLogger.error(`Failed to detect Level Zero devices: ${error}`, this.name);
            return {ONEAPI_DEVICE_SELECTOR:"level_zero:*"};
        }
    }
}
