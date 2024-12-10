import path from "node:path";
import * as fs from 'fs-extra'
import {spawnSync} from "node:child_process";


export function existingFileOrError(filePath: string) {
    const resolvedFilePath = path.resolve(filePath)
    if(fs.existsSync(resolvedFilePath)) {
        return resolvedFilePath
    }
    throw Error(`File at ${resolvedFilePath} does not exist`)
}

export function spawnProcessSync(command: string, args: string[] = [], options: { cwd?: string; env?: { [key: string]: string }[]; } = {}): string {
    try {
        const result = spawnSync(command, args, {
            windowsHide : true,
            cwd : options.cwd,
            env: Object.assign(options.env || [])
        });
        if (result.status !== 0) {
            throw Error(`Command failed with exit code ${result.status}: ${result.stderr}`);
        }
        return result.stdout.toString('utf8').trim();
    } catch (error) {
        console.error(`Failure during execution of process ${command}: ${error}`)
        throw error;
    }
}
