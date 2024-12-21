import * as filesystem from 'fs-extra';
import { app } from 'electron';
import path from "node:path";
import { appLoggerInstance } from "../logging/logger.ts";
import { existingFileOrError, spawnProcessAsync } from "./osProcessHelper";
import { assert } from 'node:console';
import { getArchPriority, getDeviceArch } from './deviceArch';

class ServiceCheckError extends Error {
    readonly component: string
    readonly stage: string

    constructor(component: string, stage: string = "main") {
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
    readonly dir: string

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
            this.logError(`failed to check due to ${e}`)
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
            this.logError(`failed to check due to ${e}`)
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
        case "main":
            await this.getPip()
            // fallthrough
        case "pkg_resources":
            await this.run(["install", "setuptools"])
            break
        default:
            throw new Error(`unknown stage ${checkError.stage}`)
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
            this.logError(`failed to check due to ${e}`)
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

    readonly requirementsTxtPath = path.resolve(path.join(this.baseDir, "service/requirements-ls_level_zero.txt"));
    async check(): Promise<void> {
        this.log("checking")
        try {
            await this.uvPip.check()
            await this.uvPip.checkRequirementsTxt(this.requirementsTxtPath)
            await this.run()
        } catch (e) {
            this.logError(`failed to check due to ${e}`)
            if (e instanceof ServiceCheckError)
                throw e
            if (e instanceof Error && e.message.includes("requirements check failed"))
                throw new ServiceCheckError(this.name, "requirements")
            throw new ServiceCheckError(this.name)
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
        case "requirements":
            await this.installRequirements()
            // fallthrough
        case "main":
            await this.cloneLsLevelZero()
            break
        default:
            throw new Error(`unknown stage ${checkError.stage}`)
        }
    }

    async installRequirements(): Promise<void> {
        await this.uvPip.installRequirementsTxt(this.requirementsTxtPath)
    }

    readonly srcExePath = path.resolve(path.join(this.baseDir, "service/tools/ls_level_zero.exe"));
    private async cloneLsLevelZero(): Promise<void> {
        existingFileOrError(this.srcExePath)
        if (filesystem.existsSync(this.getExePath())) {
            filesystem.removeSync(this.getExePath())
        }
        this.log(`copying ls-level-zero to ${this.getExePath()}`)
        await filesystem.copy(this.srcExePath, this.getExePath())
    }

    private allLevelZeroDevices: {name: string, device_id: number, arch: string}[] = [];
    private selectedDeviceIdx: number = -1;

    async detectDevice(): Promise<string> {
        if (this.selectedDeviceIdx >= 0 && this.selectedDeviceIdx < this.allLevelZeroDevices.length) {
            return this.allLevelZeroDevices[this.selectedDeviceIdx].arch;
        }

        this.log("Detecting device");
        try {
            const devices = JSON.parse(await this.run());
            this.allLevelZeroDevices = devices.map((d: {id: number, name: string, device_id: number}) => {
                return {name: d.name, device_id: d.device_id, arch: getDeviceArch(d.device_id)};
            });
            this.selectBestDevice();
            return this.allLevelZeroDevices[this.selectedDeviceIdx].arch;
        } catch (e) {
            this.logError(`Failed to detect device due to ${e}`);
            throw e;
        }
    }

    selectBestDevice(): number {
        let priority = -1;
        for (let i = 0; i < this.allLevelZeroDevices.length; i++) {
            const device = this.allLevelZeroDevices[i];
            const deviceArchPriority = getArchPriority(device.arch);
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