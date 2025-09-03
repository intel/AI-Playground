import path from 'node:path'
import * as fs from 'fs-extra'
import { spawn } from 'node:child_process'

export function existingFileOrError(filePath: string) {
  const resolvedFilePath = path.resolve(filePath)
  if (fs.existsSync(resolvedFilePath)) {
    return resolvedFilePath
  }
  throw Error(`File at ${resolvedFilePath} does not exist`)
}
export interface ProcessResult {
  stdout: string
  stderr: string
  exitCode: number
  command: string
  args: string[]
  duration: number
  timestamp: string
}

export class ProcessError extends Error {
  readonly result: ProcessResult

  constructor(result: ProcessResult) {
    super(
      `Command failed: ${result.command} ${result.args.join(' ')} (exit code: ${result.exitCode})`,
    )
    this.name = 'ProcessError'
    this.result = result
  }
}

export async function spawnProcessAsync(
  command: string,
  args: string[] = [],
  logHandler: (data: string) => void = () => {},
  extraEnv?: object,
  workDir?: string,
): Promise<string> {
  const startTime = Date.now()
  const timestamp = new Date().toISOString()

  logHandler(`Spawning command ${command} ${args.join(' ')}`)
  if (extraEnv) {
    logHandler(`Extra env: ${JSON.stringify(extraEnv)}`)
  }

  const spawnedProcess = spawn(command, args, {
    windowsHide: true,
    cwd: workDir ?? process.cwd(),
    env: {
      ...process.env,
      ...extraEnv,
    },
  })

  const stdOut: string[] = []
  const stdErr: string[] = []

  spawnedProcess.stdout.on('data', (data: string | Buffer) => {
    const output = data.toString('utf8')
    logHandler(output)
    stdOut.push(output)
  })

  spawnedProcess.stderr.on('data', (data: string | Buffer) => {
    const output = data.toString('utf8')
    logHandler(output)
    stdErr.push(output)
  })

  return new Promise<string>((resolve, reject) => {
    spawnedProcess.on('exit', (code) => {
      const duration = Date.now() - startTime
      const result: ProcessResult = {
        stdout: stdOut.join(''),
        stderr: stdErr.join(''),
        exitCode: code ?? -1,
        command,
        args,
        duration,
        timestamp,
      }

      if (code === 0) {
        resolve(result.stdout)
      } else {
        reject(new ProcessError(result))
      }
    })

    spawnedProcess.on('error', (err) => {
      const duration = Date.now() - startTime
      const result: ProcessResult = {
        stdout: stdOut.join(''),
        stderr: stdErr.join('') + `\nProcess error: ${err.message}`,
        exitCode: -1,
        command,
        args,
        duration,
        timestamp,
      }
      reject(new ProcessError(result))
    })
  })
}

export async function copyFileWithDirs(src: string, dest: string) {
  const stats = await fs.promises.lstat(src)
  if (stats.isSymbolicLink()) {
    const linkTarget = await fs.promises.readlink(src)
    src = linkTarget
  }
  const destDir = path.dirname(dest)
  await fs.promises.mkdir(destDir, { recursive: true })
  await fs.promises.cp(src, dest, { recursive: true, force: true })
}
