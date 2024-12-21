import path from "node:path";
import * as fs from 'fs-extra'
import { spawn } from "node:child_process";


export function existingFileOrError(filePath: string) {
    const resolvedFilePath = path.resolve(filePath)
    if (fs.existsSync(resolvedFilePath)) {
        return resolvedFilePath
    }
    throw Error(`File at ${resolvedFilePath} does not exist`)
}
export async function spawnProcessAsync(command: string, args: string[] = [],
    logHandler: (data: string) => void = () => { }, extraEnv?: {}, workDir?: string
): Promise<string> {
    logHandler(`Spawning command ${command} ${args.join(' ')}`);
    if (extraEnv) {
        logHandler(`Extra env: ${JSON.stringify(extraEnv)}`);
    }
    const spawnedProcess = spawn(command, args, {
        windowsHide: true,
        cwd: workDir ?? process.cwd(),
        env: {
            ...process.env,
            ...extraEnv,
        }
    });

    const stdOut: string[] = [];

    spawnedProcess.stdout.on("data", (data: string | Buffer) => { logHandler(data.toString('utf8')); stdOut.push(data.toString('utf8')); });
    spawnedProcess.stderr.on("data", (data) => { logHandler(data.toString('utf8')) });

    return new Promise<string>((resolve, reject) => {
        spawnedProcess.on("exit", (code) => {
            if (code === 0) {
                resolve(stdOut.join('\n'));
            } else {
                reject(new Error(`command ${command} ${args} failed ${code}`));
            }
        });
        spawnedProcess.on("error", (err) => {
            reject(err);
        });
    });
}

export async function copyFileWithDirs(src: string, dest: string) {
    const stats = await fs.promises.lstat(src);
    if (stats.isSymbolicLink()) {
        const linkTarget = await fs.promises.readlink(src);
        src = linkTarget;
    }
    const destDir = path.dirname(dest);
    await fs.promises.mkdir(destDir, { recursive: true });
    await fs.promises.cp(src, dest, { recursive: true, force: true });
}