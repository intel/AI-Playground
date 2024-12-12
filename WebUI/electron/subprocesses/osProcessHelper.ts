import path from "node:path";
import * as fs from 'fs-extra'
import {spawn, spawnSync} from "node:child_process";


export function existingFileOrError(filePath: string) {
    const resolvedFilePath = path.resolve(filePath)
    if (fs.existsSync(resolvedFilePath)) {
        return resolvedFilePath
    }
    throw Error(`File at ${resolvedFilePath} does not exist`)
}

export function spawnProcessSync(command: string, args: string[] = [],
                                 logHandler: (data: string) => void = () => {},
): string {
    try {
        logHandler(`Spawning synchronous command ${command} ${args}`)
        const result = spawnSync(command, args, {
            windowsHide: true,
        });
        const stdOut = result.stdout.toString('utf8').trim();
        const stdErr = result.stderr.toString('utf8').trim();
        logHandler(stdOut)
        logHandler(stdErr)
        if (result.status !== 0) {
            throw Error(`Command failed with exit code ${result.status}: ${result.stderr}`);
        }
        return stdOut
    } catch (error) {
        throw error;
    }
}

export async function spawnProcessAsync(command: string, args: string[] = [],
                                        logHandler: (data: string) => void = () => {},
): Promise<void> {
    logHandler(`Spawning command ${command} ${args}`)
    const process = spawn(command, args, {
        windowsHide: true,
    });

    process.stdout.on("data", (data) => { logHandler(data) });
    process.stderr.on("data", (data) => { logHandler(data) });

    return new Promise<void>((resolve, reject) => {
        process.on("exit", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`command ${command} ${args} failed ${code}`));
            }
        });
    });
}

export function copyFileWithDirs(src :string, dest: string) {
    const destDir = path.dirname(dest);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copySync(src, dest, {recursive: true});
}