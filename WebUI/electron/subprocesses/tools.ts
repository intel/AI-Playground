import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const binary = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name)

// Use execFile (no shell) so paths containing spaces are passed correctly on all platforms.
const winExtract = (zipPath: string, extractTo: string) =>
  execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractTo}' -Force`,
  ])
const unixExtract = (zipPath: string, extractTo: string) =>
  execFileAsync('tar', ['-xf', zipPath, '-C', extractTo])
export const extract = process.platform === 'win32' ? winExtract : unixExtract
