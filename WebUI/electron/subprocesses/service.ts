import {ChildProcess} from "node:child_process";
import {app, BrowserWindow, net} from "electron";
import fs from "fs";
import * as filesystem from 'fs-extra';
import path from "node:path";
import { appLoggerInstance } from "../logging/logger.ts";
import { existingFileOrError, spawnProcessAsync } from "./osProcessHelper";
import { assert } from 'node:console';
import { Arch, getArchPriority, getDeviceArch } from './deviceArch';
import { createHash } from 'crypto';

class ServiceCheckError extends Error {
    readonly component: string
    readonly stage: string

    constructor(component: string, stage: string = "all") {
        super(`Service ${component} check failed at stage ${stage}`);
        this.name = "ServiceCheckError";
        this.component = component
        this.stage = stage
    }
}

export interface GenericService {
    name: string

    /**
     * Check first, then repair/install if check fails
     * @throws any error if repair/install throws
     */
    ensureInstalled(): Promise<void>

    /**
     * @throws ServiceCheckError if check fails
     */
    check(): Promise<void>

    /**
     * Fresh install
     * @throws any error
     */
    install(): Promise<void>

    /**
     * Repair install
     * @param checkError error that caused the repair
     * @throws any error
     */
    repair(checkError: ServiceCheckError): Promise<void>
}

export abstract class GenericServiceImpl implements GenericService {
    name: string

    readonly appLogger = appLoggerInstance
    readonly baseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../../");

    constructor(name: string) {
        this.name = name
    }

    async ensureInstalled(): Promise<void> {
        try {
            await this.check()
        } catch (e) {
            if (e instanceof ServiceCheckError) {
                await this.repair(e)
            } else {
                await this.install()
            }
        }
    }

    abstract check(): Promise<void>
    abstract install(): Promise<void>
    abstract repair(checkError: ServiceCheckError): Promise<void>

    log(msg: string) {
        this.appLogger.info(msg, this.name)
    }

    logError(msg: string) {
        this.appLogger.error(msg, this.name, true)
    }
}

abstract class ExecutableService extends GenericServiceImpl {
    dir: string

    constructor(name: string, dir: string) {
        super(name)
        this.dir = dir
    }

    abstract getExePath(): string

    async run(args: string[] = [], extraEnv?: {}, workDir?: string): Promise<string> {
        const exePath = existingFileOrError(this.getExePath())
        return spawnProcessAsync(exePath, args, (data) => this.log(data), extraEnv, workDir)
    }
}

export class PythonService extends ExecutableService {
    constructor(readonly dir: string) {
        super("python", dir)
    }

    getExePath(): string {
        return path.resolve(path.join(this.dir, "python.exe"))
    }

    async check(): Promise<void> {
        this.log("checking")
        try {
            await this.run(["--version"])
        } catch (e) {
            this.log(`warning: ${e}`)
            throw new ServiceCheckError(this.name)
        }
    }

    async install(): Promise<void> {
        this.log("start installing")
        await this.clonePythonEnv()
    }

    async repair(checkError: ServiceCheckError): Promise<void> {
        assert(checkError.component === this.name)
        await this.install()
    }

    readonly prototypicalEnvDir = app.isPackaged ? path.join(this.baseDir, "prototype-python-env") : path.join(this.baseDir, "build-envs/online/prototype-python-env");
    private async clonePythonEnv(): Promise<void> {
        existingFileOrError(this.prototypicalEnvDir)
        if (filesystem.existsSync(this.dir)) {
            this.log(`removing existing python env at ${this.dir}`)
            filesystem.removeSync(this.dir)
        }
        this.log(`copying prototypical python env to ${this.dir}`)
        await filesystem.copy(this.prototypicalEnvDir, this.dir)
    }
}

export class PipService extends ExecutableService {
    readonly python: PythonService = new PythonService(this.dir)

    constructor(readonly pythonEnvDir: string) {
        super("pip", pythonEnvDir)
    }

    getExePath(): string {
        return this.python.getExePath()
    }

    async run(args: string[] = [], extraEnv?: {}, workDir?: string): Promise<string> {
        return this.python.run(["-m", "pip", ...args], extraEnv, workDir)
    }

    async check(): Promise<void> {
        this.log("checking")
        try {
            await this.python.check()
            await this.run(["--version"])
            await this.run(["show", "setuptools"])
            return
        } catch (e) {
            this.log(`warning: ${e}`)
            if (e instanceof ServiceCheckError)
                throw e
            if (e instanceof Error && e.message.includes("setuptools"))
                throw new ServiceCheckError(this.name, "setuptools")
            throw new ServiceCheckError(this.name)
        }
    }

    async install(): Promise<void> {
        this.log("start installing")
        await this.python.ensureInstalled()
        await this.getPip()
        await this.run(["install", "setuptools"])
    }

    async repair(checkError: ServiceCheckError): Promise<void> {
        this.log("repairing")
        if (checkError.component !== this.name) {
            await this.python.repair(checkError)
        }

        switch (checkError.stage) {
        default:
            await this.getPip()
            // fallthrough
        case "setuptools":
            await this.run(["install", "setuptools"])
        }
    }

    private async getPip(): Promise<void> {
        const getPipScript = existingFileOrError(path.join(this.dir, "get-pip.py"))
        await this.python.run([getPipScript])
    }

    async installRequirementsTxt(requirementsTxtPath: string): Promise<void> {
        await this.run(["install", "-r", requirementsTxtPath])
    }

    async checkRequirementsTxt(requirementsTxtPath: string): Promise<void> {
        await this.python.run(["-c", `import pkg_resources; pkg_resources.require([s for s in open(r'${requirementsTxtPath}') if s and s[0].isalpha()])`]).catch((e) => {
            throw new Error(`requirements check failed`)
        })
    }
}

export class UvPipService extends PipService {
    readonly pip: PipService = new PipService(this.dir)
    readonly python: PythonService = this.pip.python

    constructor(readonly pythonEnvDir: string) {
        super(pythonEnvDir)
        this.name = "uvpip"
    }

    async run(args: string[] = [], extraEnv?: {}, workDir?: string): Promise<string> {
        return this.python.run(["-m", "uv", "pip", ...args], extraEnv, workDir)
    }

    async check(): Promise<void> {
        this.log("checking")
        try {
            await this.pip.check()
            await this.run(["--version"])
        } catch (e) {
            this.log(`warning: ${e}`)
            if (e instanceof ServiceCheckError)
                throw e
            throw new ServiceCheckError(this.name)
        }
    }

    async install(): Promise<void> {
        this.log("start installing")
        await this.pip.ensureInstalled()
        await this.pip.run(["install", "uv"])
    }

    async repair(checkError: ServiceCheckError): Promise<void> {
        this.log("repairing")
        if (checkError.component !== this.name) {
            await this.pip.repair(checkError)
        }
        await this.pip.run(["install", "uv"])
    }
}

export class LsLevelZeroService extends ExecutableService {
    readonly uvPip: UvPipService = new UvPipService(this.dir)
    readonly requirementsTxtPath = path.resolve(path.join(this.baseDir, "service/requirements-ls_level_zero.txt"));
    readonly srcExePath = path.resolve(path.join(this.baseDir, "service/tools/ls_level_zero.exe"));

    private allLevelZeroDevices: {name: string, device_id: number, arch: Arch}[] = [];
    private selectedDeviceIdx: number = -1;

    constructor(readonly pythonEnvDir: string) {
        super("lslevelzero", pythonEnvDir)
    }

    getExePath(): string {
        return path.resolve(path.join(this.dir, "Library/bin/ls_level_zero.exe"))
    }

    async run(args: string[] = [], extraEnv?: {}, workDir?: string): Promise<string> {
        // reset ONEAPI_DEVICE_SELECTOR to ensure full device discovery
        const env = {
            ...extraEnv,
            ONEAPI_DEVICE_SELECTOR: "level_zero:*"
        }
        return super.run(args, env, workDir)
    }

    async check(): Promise<void> {
        this.log("checking")
        try {
            await this.uvPip.check()
            await this.uvPip.checkRequirementsTxt(this.requirementsTxtPath)
            await this.run()
        } catch (e) {
            this.log(`warning: ${e}`)
            if (e instanceof ServiceCheckError)
                throw e
            if (e instanceof Error && e.message.includes("requirements check failed"))
                throw new ServiceCheckError(this.name, "requirements")
            throw new ServiceCheckError(this.name, "main")
        }
    }

    async install(): Promise<void> {
        this.log("start installing")
        await this.uvPip.ensureInstalled()
        await this.installRequirements()
        await this.cloneLsLevelZero()
    }

    async repair(checkError: ServiceCheckError): Promise<void> {
        this.log("repairing")
        if (checkError.component !== this.name) {
            await this.uvPip.repair(checkError)
        }

        switch (checkError.stage) {
        default:
        case "requirements":
            await this.installRequirements()
            // fallthrough
        case "main":
            await this.cloneLsLevelZero()
        }
    }

    async installRequirements(): Promise<void> {
        await this.uvPip.installRequirementsTxt(this.requirementsTxtPath)
    }
    private async cloneLsLevelZero(): Promise<void> {
        existingFileOrError(this.srcExePath)
        if (filesystem.existsSync(this.getExePath())) {
            filesystem.removeSync(this.getExePath())
        }
        this.log(`copying ls-level-zero to ${this.getExePath()}`)
        await filesystem.copy(this.srcExePath, this.getExePath())
    }


    async detectDevice(): Promise<Arch> {
        if (this.selectedDeviceIdx >= 0 && this.selectedDeviceIdx < this.allLevelZeroDevices.length) {
            return this.allLevelZeroDevices[this.selectedDeviceIdx]?.arch ?? 'unknown';
        }

        this.log("Detecting device");
        try {
            const devices = JSON.parse(await this.run());
            this.allLevelZeroDevices = devices.map((d: {id: number, name: string, device_id: number}) => {
                return {name: d.name, device_id: d.device_id, arch: getDeviceArch(d.device_id)};
            });
            this.selectBestDevice();
            return this.allLevelZeroDevices[this.selectedDeviceIdx]?.arch ?? 'unknown';
        } catch (e) {
            this.logError(`Failed to detect device due to ${e}`);
            return 'unknown';
        }
    }

    private selectBestDevice(): number {
        let priority = -1;
        for (let i = 0; i < this.allLevelZeroDevices.length; i++) {
            const device = this.allLevelZeroDevices[i];
            const deviceArchPriority = getArchPriority(device?.arch ?? 'unknown');
            if (deviceArchPriority > priority) {
                this.selectedDeviceIdx = i;
                priority = deviceArchPriority;
            }
        }
        return this.selectedDeviceIdx;
    }

    async getDeviceSelectorEnv(): Promise<{ONEAPI_DEVICE_SELECTOR: string}> {
        if (this.selectedDeviceIdx < 0 || this.selectedDeviceIdx >= this.allLevelZeroDevices.length) {
            await this.detectDevice();
        }

        if (this.selectedDeviceIdx < 0) {
            this.logError("No supported device");
            return {ONEAPI_DEVICE_SELECTOR: "level_zero:*"};
        }

        return {ONEAPI_DEVICE_SELECTOR: `level_zero:${this.selectedDeviceIdx}`};
    }
}

export class GitService extends ExecutableService {
    constructor() {
        super("git", "")
        this.dir = path.resolve(path.join(this.baseDir, "portable-git"))
    }

    getExePath(): string {
        return path.resolve(path.join(this.dir, "cmd/git.exe"))
    }

    async run(args: string[] = [], extraEnv?: {}, workDir?: string): Promise<string> {
        // Explicitly specify the cert file bundled with portable git,
        // to avoid being affected by the system git configuration.
        const env = {
            ...extraEnv,
            GIT_SSL_CAINFO: path.resolve(path.join(this.dir, "mingw64/etc/ssl/certs/ca-bundle.crt"))
        }
        return super.run(args, env, workDir)
    }

    async check(): Promise<void> {
        this.log("checking")
        try {
            await this.run(["--version"])
        } catch (e) {
            this.log(`warning: ${e}`)
            throw new ServiceCheckError(this.name)
        }
    }

    async install(): Promise<void> {
        this.log("start installing")
        await this.downloadGitZip()
        await this.unzipGit()

        // cleanup
        if (filesystem.existsSync(this.zipPath)) {
            filesystem.removeSync(this.zipPath)
        }
    }

    async repair(checkError: ServiceCheckError): Promise<void> {
        assert(checkError.component === this.name)
        await this.install()
    }

    // https://github.com/git-for-windows/git/releases/tag/v2.47.1.windows.1
    readonly remoteUrl = "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/MinGit-2.47.1-64-bit.zip"
    readonly sha256 = "50b04b55425b5c465d076cdb184f63a0cd0f86f6ec8bb4d5860114a713d2c29a"
    readonly zipPath = path.resolve(path.join(this.baseDir, "portable-git.zip"))

    private async checkGitZip(): Promise<boolean> {
        if (!filesystem.existsSync(this.zipPath)) {
            return false;
        }
        const sha256sum = await filesystem.readFile(this.zipPath).then((data) => createHash("sha256").update(data).digest("hex"));
        return sha256sum === this.sha256;
    }

    private async downloadGitZip(): Promise<void> {
        this.log("downloading git archive");
        if (await this.checkGitZip()) {
            this.log("Using existing git archive");
            return;
        }

        // Reuse existing zip if checksum matches
        if (filesystem.existsSync(this.zipPath)) {
            this.logError("Removing broken git archive");
            filesystem.removeSync(this.zipPath);
        }

        // Using electron net for better proxy support
        const response = await net.fetch(this.remoteUrl);
        if (!response.ok || response.status !== 200 || !response.body) {
            throw new Error(`Failed to download git: ${response.statusText}`);
        }
        const buffer = await response.arrayBuffer();
        await filesystem.writeFile(this.zipPath, Buffer.from(buffer));
        if (!await this.checkGitZip()) {
            throw new Error(`Checksum mismatch: ${this.zipPath}`);
        }
    }

    private async unzipGit(): Promise<void> {
        const extract = require("extract-zip");
        await extract(this.zipPath, {dir: this.dir});
    }
}


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
                this.isSetUp = true
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
}
