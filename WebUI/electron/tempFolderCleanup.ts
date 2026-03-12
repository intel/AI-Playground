import fs from 'node:fs'
import path from 'node:path'
import { appLoggerInstance } from './logging/logger.ts'

const logger = appLoggerInstance
const LOG_SOURCE = 'tmpCleanup'

// Matches temp folders created by model_downloader.py getTmpPath(), e.g.
// fd824df26f56f9a3_tmp, 0a1b2c3d4e5f6789_tmp, etc.
export const TMP_FOLDER_PATTERN = /^[0-9a-f]{16}_tmp$/
const REQUIRED_PARENT_FOLDER = 'models'

export async function findTempFolders(baseDir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(baseDir, { recursive: true, withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && TMP_FOLDER_PATTERN.test(e.name))
      .map((e) => path.join(e.parentPath, e.name))
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

export async function cleanupTempFolders(baseDir: string): Promise<void> {
  try {
    logger.info(`[tmpCleanup] Attempting to clean up temp folders in: ${baseDir}`, LOG_SOURCE)

    try {
      await fs.promises.access(baseDir)
    } catch {
      logger.warn(`[tmpCleanup] Base directory does not exist: ${baseDir}`, LOG_SOURCE)
      return
    }

    if (!path.normalize(baseDir).split(path.sep).includes(REQUIRED_PARENT_FOLDER)) {
      logger.warn(
        `[tmpCleanup] Base directory does not contain a ${REQUIRED_PARENT_FOLDER} folder. This should not happen, aborting.`,
        LOG_SOURCE,
      )
      return
    }

    const tempFolders = await findTempFolders(baseDir)

    if (tempFolders.length === 0) {
      logger.info(`[tmpCleanup] No temp folders found.`, LOG_SOURCE)
      return
    }

    logger.info(`[tmpCleanup] Found the following temp folder(s):`, LOG_SOURCE)
    for (const tempFolder of tempFolders) {
      logger.info(`[tmpCleanup] - ${tempFolder}`, LOG_SOURCE)
    }

    for (const tempFolder of tempFolders) {
      try {
        logger.info(`[tmpCleanup] Removing: ${tempFolder}`, LOG_SOURCE)
        await fs.promises.rm(tempFolder, { recursive: true, force: true })
      } catch (error) {
        logger.error(
          `[tmpCleanup] Failed to remove ${tempFolder}: ${error instanceof Error ? error.message : String(error)}`,
          LOG_SOURCE,
        )
      }
    }
  } catch (err) {
    logger.error(
      `Fatal error in cleanupTempFolders: ${err instanceof Error ? err.message : String(err)}`,
      LOG_SOURCE,
    )
  }
}
