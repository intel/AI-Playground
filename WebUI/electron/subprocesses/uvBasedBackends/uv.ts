import { app } from 'electron'
import { appLoggerInstance } from '../../logging/logger.ts'
import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'
import z from 'zod'

export const aipgBaseDir = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, '../../../')
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
  },
})

const uv = (uvCommand: string[], logger: ReturnType<typeof loggerFor>) =>
  new Promise<void>((resolve, reject) => {
    logger.info(`Spawning UV process with command: ${uvCommand.join(' ')}`)
    const uvProcess = spawn(uvPath, uvCommand, {
      env: { ...process.env, UV_NO_ENV_FILE: '1', UV_NO_CONFIG: '1', VIRTUAL_ENV: undefined },
    })

    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []

    uvProcess.stdout.on('data', (data: Buffer) => {
      const text = data.toString()
      stdoutChunks.push(text)
      logger.info(`UV: ${text}`)
    })

    uvProcess.stderr.on('data', (data: Buffer) => {
      const text = data.toString()
      stderrChunks.push(text)
      logger.error(`UV Error: ${text}`)
    })

    uvProcess.on('close', (code: number) => {
      if (code === 0) {
        logger.info(`UV process completed successfully`)
        resolve()
      } else {
        const stdout = stdoutChunks.join('').trim()
        const stderr = stderrChunks.join('').trim()
        const errorMessage = stderr || stdout || `UV process exited with code ${code}`
        logger.error(`UV process exited with code ${code}`)
        reject(new Error(errorMessage))
      }
    })
  })

const uvWithJsonOutput = (uvCommand: string[], logger: ReturnType<typeof loggerFor>) =>
  new Promise<{ exitCode: number; jsonOutput: unknown; stdout: string; stderr: string }>(
    (resolve, reject) => {
      logger.info(`Spawning UV process with command: ${uvCommand.join(' ')}`)
      const uvProcess = spawn(uvPath, uvCommand, {
        env: { ...process.env, UV_NO_ENV_FILE: '1', UV_NO_CONFIG: '1', VIRTUAL_ENV: undefined },
      })

      let stdout = ''
      let stderr = ''
      let jsonOutput: unknown = null

      uvProcess.stdout.on('data', (data: Buffer) => {
        const output = data.toString()
        stdout += output
        logger.info(`UV: ${output}`)
      })

      uvProcess.stderr.on('data', (data: Buffer) => {
        const output = data.toString()
        stderr += output
        logger.error(`UV Error: ${output}`)
      })

      uvProcess.on('close', (code: number) => {
        // Try to parse JSON from complete stdout after process closes
        // This handles cases where JSON might be split across multiple chunks
        try {
          // Look for JSON in stdout - it might be on a single line or multiple lines
          const lines = stdout.trim().split('\n')
          for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
              jsonOutput = JSON.parse(trimmed)
              break
            }
          }
          // If no single-line JSON found, try parsing the entire stdout as JSON
          if (!jsonOutput && stdout.trim().startsWith('{')) {
            jsonOutput = JSON.parse(stdout.trim())
          }
        } catch {
          // Not JSON or invalid JSON, jsonOutput remains null
          logger.warn('Could not parse JSON output from uv command')
        }

        resolve({ exitCode: code, jsonOutput, stdout, stderr })
      })

      uvProcess.on('error', (error) => {
        reject(error)
      })
    },
  )

/**
 * Detect if an error message indicates a UV cache hash mismatch
 */
const isHashMismatchError = (errorMessage: string): boolean => {
  // Check for various hash mismatch patterns
  return (
    /hash mismatch/i.test(errorMessage) ||
    /failed to download.*hash mismatch/is.test(errorMessage) ||
    /expected:[\s\S]*sha256:[\s\S]*computed:[\s\S]*sha256:/i.test(errorMessage)
  )
}

/**
 * Detect if an error message indicates a Python version compatibility issue
 */
const isPythonVersionError = (errorMessage: string): boolean => {
  return (
    /cannot install on python version/i.test(errorMessage) ||
    /only versions.*are supported/i.test(errorMessage) ||
    /requires python.*but.*is installed/i.test(errorMessage)
  )
}

/**
 * Detect if we need to regenerate the lockfile due to various issues
 */
const needsLockfileRegeneration = (errorMessage: string): boolean => {
  return isHashMismatchError(errorMessage) || isPythonVersionError(errorMessage)
}

export const installBackend = async (backend: string, onCacheCorruptionDetected?: () => void) => {
  const logger = loggerFor(`uv.sync.${backend}`)
  await assertUv(logger)
  const uvCommand = ['sync', '--directory', aipgBaseDir, '--project', backend]
  logger.info(`Installing backend: ${backend} with ${JSON.stringify(uvCommand)}`)

  try {
    return await uv(uvCommand, logger)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)

    // Log the error message for debugging
    logger.error(`Installation failed, analyzing error message (length: ${errorMessage.length})`)

    // Check for lockfile regeneration needs
    const needsRegen = needsLockfileRegeneration(errorMessage)
    const isHashMatch = isHashMismatchError(errorMessage)
    const isPyVersion = isPythonVersionError(errorMessage)

    logger.info(
      `Error analysis: needsRegen=${needsRegen}, hashMismatch=${isHashMatch}, pythonVersion=${isPyVersion}`,
    )

    if (needsRegen) {
      if (isHashMatch) {
        logger.warn('Hash mismatch detected - package hashes have changed on the server')
      } else if (isPyVersion) {
        logger.warn('Python version incompatibility detected in locked dependencies')
        logger.warn(
          "This usually means the lockfile was created with packages that don't support the current Python version",
        )
      }

      logger.warn('Regenerating lockfile with fresh package versions...')
      onCacheCorruptionDetected?.()

      // Delete the existing lock file to force complete regeneration
      const lockFilePath = path.join(aipgBaseDir, backend, 'uv.lock')
      try {
        if (fs.existsSync(lockFilePath)) {
          logger.info(`Removing old lock file: ${lockFilePath}`)
          fs.unlinkSync(lockFilePath)
        }
      } catch (unlinkError) {
        logger.warn(`Failed to remove lock file: ${unlinkError}`)
        // Continue anyway, --upgrade should handle it
      }

      // Use --upgrade to regenerate the lockfile with fresh package versions
      // and --no-cache to ensure we download fresh packages
      const regenerateCommand = [...uvCommand, '--upgrade', '--no-cache']
      logger.info(`Retrying with: ${JSON.stringify(regenerateCommand)}`)
      return await uv(regenerateCommand, logger)
    }

    // If we don't need regeneration, just throw the original error
    logger.error('Error does not match regeneration criteria, re-throwing')
    throw error
  }
}

export const checkBackend = async (backend: string) => {
  const logger = loggerFor(`uv.check.${backend}`)
  await assertUv(logger)
  const uvCommand = ['sync', '--check', '--directory', aipgBaseDir, '--project', backend]
  logger.info(`Checking backend: ${backend} with ${JSON.stringify(uvCommand)}`)

  return uv(uvCommand, logger)
}

export interface BackendCheckDetails {
  venvExists: boolean
  action: 'create' | 'check' | 'sync' | 'unknown'
  needsInstallation: boolean
  envMismatch: boolean
  exitCode: number
  jsonOutput?: unknown
  stdout?: string
  stderr?: string
}

/**
 * Check backend environment with detailed information about state
 * For ComfyUI, this checks if venv exists rather than exact lockfile match
 */
export const checkBackendWithDetails = async (
  backend: string,
  venvPath: string,
): Promise<BackendCheckDetails> => {
  const logger = loggerFor(`uv.check-details.${backend}`)
  await assertUv(logger)

  // Check if venv directory exists
  let venvExists = false
  try {
    await fs.promises.access(venvPath, fs.constants.F_OK)
    venvExists = true
    logger.info(`Venv directory exists at ${venvPath}`)
  } catch {
    logger.info(`Venv directory does not exist at ${venvPath}`)
    venvExists = false
  }

  // Run uv sync --check with JSON output
  const uvCommand = [
    'sync',
    '--check',
    '--output-format',
    'json',
    '--directory',
    aipgBaseDir,
    '--project',
    backend,
  ]
  logger.info(`Checking backend with details: ${backend} with ${JSON.stringify(uvCommand)}`)

  try {
    const result = await uvWithJsonOutput(uvCommand, logger)
    const parsedResult = z
      .object({
        sync: z.object({
          action: z.enum(['create', 'check', 'sync', 'unknown']),
        }),
      })
      .parse(result.jsonOutput)
    const action = parsedResult.sync.action

    // If exit code is 0, environment is in sync
    if (result.exitCode === 0) {
      return {
        venvExists,
        action,
        needsInstallation: false,
        envMismatch: false,
        exitCode: result.exitCode,
        jsonOutput: result.jsonOutput,
        stdout: result.stdout,
        stderr: result.stderr,
      }
    }

    // Exit code != 0 means environment doesn't match
    // If action is 'create', venv doesn't exist yet
    // If action is 'check', venv exists but doesn't match
    const needsInstallation = !venvExists || action === 'create'
    const envMismatch = venvExists && action === 'check'

    return {
      venvExists,
      action,
      needsInstallation,
      envMismatch,
      exitCode: result.exitCode,
      jsonOutput: result.jsonOutput,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  } catch (error) {
    // If command fails completely, assume environment needs installation if venv doesn't exist
    logger.error(`Failed to check backend details: ${error}`)
    return {
      venvExists,
      action: 'unknown',
      needsInstallation: !venvExists,
      envMismatch: venvExists, // If venv exists but check failed, it's a mismatch
      exitCode: -1,
    }
  }
}

export const installWheel = async (backend: string, wheelPath: string) => {
  const logger = loggerFor(`uv.wheel.${backend}`)
  await assertUv(logger)
  const uvCommand = ['pip', 'install', '--directory', path.join(aipgBaseDir, backend), wheelPath]
  logger.info(`Installing wheel: ${wheelPath} with ${JSON.stringify(uvCommand)}`)

  return uv(uvCommand, logger)
}

/**
 * Check if a Python package is installed in a backend's environment
 */
export const isPackageInstalled = async (
  backend: string,
  packageName: string,
): Promise<boolean> => {
  const logger = loggerFor(`uv.check-package.${backend}`)
  await assertUv(logger)

  // Extract package name from package specifier (handle .whl files and version specs)
  let pkgName = packageName
  if (packageName.endsWith('.whl')) {
    pkgName = packageName.split('/').pop()?.split('-')[0] || packageName
  } else {
    pkgName = packageName.split('==')[0].split('>=')[0].split('<=')[0].trim()
  }

  try {
    // Use uv pip show to check if package is installed
    // This returns exit code 0 if package exists, non-zero if not
    const uvCommand = ['pip', 'show', '--directory', path.join(aipgBaseDir, backend), pkgName]
    logger.info(`Checking if package ${pkgName} is installed`)

    await uv(uvCommand, logger)
    return true
  } catch (_error) {
    // Package not found - this is expected behavior, not an error
    logger.info(`Package ${pkgName} is not installed`)
    return false
  }
}

/**
 * Install a Python package using uv pip
 */
export const installPypiPackage = async (
  backend: string,
  packageSpecifier: string,
): Promise<void> => {
  const logger = loggerFor(`uv.install-package.${backend}`)
  await assertUv(logger)

  let pipSpecifier = packageSpecifier

  // Handle .whl files - download if it's a URL
  if (packageSpecifier.endsWith('.whl') && packageSpecifier.startsWith('http')) {
    const fileName = packageSpecifier.split('/').pop() || 'package.whl'
    const downloadPath = path.join(aipgBaseDir, backend, fileName)

    logger.info(`Downloading .whl file from ${packageSpecifier}`)
    const response = await fetch(packageSpecifier)

    if (!response.ok) {
      throw new Error(`Failed to fetch ${packageSpecifier}: ${response.statusText}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    await fs.promises.writeFile(downloadPath, buffer)
    pipSpecifier = downloadPath
  }
  const uvCommand = ['add', '--directory', path.join(aipgBaseDir, backend), pipSpecifier]
  logger.info(`Installing package ${packageSpecifier}`)

  await uv(uvCommand, logger)

  // Clean up downloaded .whl file if it was a local download
  if (packageSpecifier.endsWith('.whl') && packageSpecifier.startsWith('http')) {
    try {
      await fs.promises.unlink(pipSpecifier)
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Install requirements from requirements.txt using uv pip
 */
export const installRequirementsTxt = async (
  backend: string,
  requirementsTxtPath: string,
): Promise<void> => {
  const logger = loggerFor(`uv.install-requirements.${backend}`)
  await assertUv(logger)

  // Check if requirements.txt exists
  try {
    await fs.promises.access(requirementsTxtPath, fs.constants.R_OK)
  } catch {
    logger.warn(`Requirements file not found: ${requirementsTxtPath}`)
    return
  }

  const uvCommand = [
    'add',
    '--directory',
    path.join(aipgBaseDir, backend),
    '-r',
    requirementsTxtPath,
  ]
  logger.info(`Installing requirements from ${requirementsTxtPath}`)

  await uv(uvCommand, logger)
}
