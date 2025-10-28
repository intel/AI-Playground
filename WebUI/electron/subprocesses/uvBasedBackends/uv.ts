import { app } from 'electron'
import { appLoggerInstance } from '../../logging/logger.ts'
import path from 'path'
import fs from 'fs'

export const aipgBaseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../../')
const buildResources = app.isPackaged ? aipgBaseDir : path.join(aipgBaseDir, 'build', 'resources')
const uvPath = path.join(buildResources, 'uv.exe')

const assertUv = async (logger: ReturnType<typeof loggerFor>) => {
  try {
    await fs.promises.access(uvPath, fs.constants.X_OK)
    logger.info(`Found UV executable at ${uvPath}`)
  } catch {
    logger.error(`UV executable not found at ${uvPath}`)
    throw new Error('UV executable not found')
  }
}

const loggerFor = (source: string) => ({
  info: (message: string) => {
    appLoggerInstance.info(message, source)
  },
  error: (message: string) => {
    appLoggerInstance.error(message, source)
  },
  warn: (message: string) => {
    appLoggerInstance.warn(message, source)
  }
})

const uv = (uvCommand: string[], logger: ReturnType<typeof loggerFor>) => 
  new Promise<void>((resolve, reject) => {
    const { spawn } = require('child_process')
    const uvProcess = spawn(uvPath, uvCommand)

    uvProcess.stdout.on('data', (data: Buffer) => {
      logger.info(`UV: ${data.toString()}`)
    })

    uvProcess.stderr.on('data', (data: Buffer) => {
      logger.error(`UV Error: ${data.toString()}`)
    })

    uvProcess.on('close', (code: number) => {
      if (code === 0) {
        logger.info(`UV process completed successfully`)
        resolve()
      } else {
        logger.error(`UV process exited with code ${code}`)
        reject(new Error(`UV process exited with code ${code}`))
      }
    })
  })

export const installBackend = async (backend: string) => {
  const logger = loggerFor(`uv.sync.${backend}`)
  await assertUv(logger)
  const uvCommand = ['sync', '--directory', aipgBaseDir, '--project', backend]
  logger.info(`Installing backend: ${backend} with ${JSON.stringify(uvCommand)}`)

  return uv(uvCommand, logger)
}

export const checkBackend = async (backend: string) => {
  const logger = loggerFor(`uv.check.${backend}`)
  await assertUv(logger)
  const uvCommand = ['sync', '--check', '--directory', aipgBaseDir, '--project', backend]
  logger.info(`Checking backend: ${backend} with ${JSON.stringify(uvCommand)}`)

  return uv(uvCommand, logger)
}

export const installWheel = async (backend: string, wheelPath: string) => {
  const logger = loggerFor(`uv.wheel.${backend}`)
  await assertUv(logger)
  const uvCommand = ['pip', 'install', '--directory', path.join(aipgBaseDir, backend), wheelPath]
  logger.info(`Installing wheel: ${wheelPath} with ${JSON.stringify(uvCommand)}`)
}