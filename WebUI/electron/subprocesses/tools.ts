import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const binary = (name: string) => process.platform === 'win32' ? `${name}.exe` : name;

const winExtract = (zipPath: string, extractTo: string) => execAsync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractTo}' -Force"`);
const unixExtract = (zipPath: string, extractTo: string) => execAsync(`tar -xf '${zipPath}' -C '${extractTo}'`);
export const extract = process.platform === 'win32' ? winExtract : unixExtract;