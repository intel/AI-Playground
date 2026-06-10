import { app } from 'electron'
import { appLoggerInstance } from '../../logging/logger.ts'
import { packagedResourcesRoot } from '../../aipgRoot.ts'
import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'
import z from 'zod'

export const aipgBaseDir = app.isPackaged
  ? packagedResourcesRoot()
  : path.join(__dirname, '../../../')
export const buildResources = app.isPackaged
  ? aipgBaseDir
  : path.join(aipgBaseDir, 'build', 'resources')
// The fetch-external-resources script stores the uv binary as `uv.exe` on ALL
// platforms (including Linux/macOS) for naming consistency — do not use binary().
export const uvPath = path.join(buildResources, 'uv.exe')
const uvEnv = (extraEnv: Record<string, string> = {}) => ({
  ...process.env,
  UV_NO_ENV_FILE: '1',
  UV_NO_CONFIG: '1',
  UV_PYTHON_INSTALL_DIR: path.join(aipgBaseDir, 'python-interpreter'),
  VIRTUAL_ENV: undefined,
  ...extraEnv,
})

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

const uv = (
  uvCommand: string[],
  logger: ReturnType<typeof loggerFor>,
  extraEnv?: Record<string, string>,
) =>
  new Promise<void>((resolve, reject) => {
    logger.info(`Spawning UV process with command: ${uvCommand.join(' ')}`)
    const uvProcess = spawn(uvPath, uvCommand, {
      env: uvEnv(extraEnv),
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

const uvWithJsonOutput = (
  uvCommand: string[],
  logger: ReturnType<typeof loggerFor>,
  extraEnv?: Record<string, string>,
) =>
  new Promise<{ exitCode: number; jsonOutput: unknown; stdout: string; stderr: string }>(
    (resolve, reject) => {
      logger.info(`Spawning UV process with command: ${uvCommand.join(' ')}`)
      const uvProcess = spawn(uvPath, uvCommand, {
        env: uvEnv(extraEnv),
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
 * Run a uv command and resolve with its raw stdout (used for commands like
 * `uv python find` whose output is a plain path rather than JSON).
 */
const uvWithStdout = (
  uvCommand: string[],
  logger: ReturnType<typeof loggerFor>,
  extraEnv?: Record<string, string>,
) =>
  new Promise<string>((resolve, reject) => {
    logger.info(`Spawning UV process with command: ${uvCommand.join(' ')}`)
    const uvProcess = spawn(uvPath, uvCommand, { env: uvEnv(extraEnv) })
    let stdout = ''
    let stderr = ''
    uvProcess.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    uvProcess.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    uvProcess.on('close', (code: number) => {
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `UV process exited with code ${code}`))
      }
    })
    uvProcess.on('error', (error) => reject(error))
  })

/**
 * Ensure a specific managed CPython version is installed and return the path to
 * its interpreter executable.
 *
 * This is used to supply a genuine, ABI-correct CPython runtime to native
 * binaries that are linked against a specific `libpythonX.Y.so` (e.g. the OVMS
 * ubuntu24 build needs libpython3.12), independent of whatever Python the host
 * distribution ships. The interpreter (and its matching stdlib + shared
 * library) lands under `UV_PYTHON_INSTALL_DIR` (aipgBaseDir/python-interpreter).
 *
 * @param version - Requested version, e.g. '3.12' or '3.12.8'.
 * @returns Absolute path to the managed python executable (e.g. `.../bin/python3.12`).
 */
export const ensureManagedPython = async (version: string): Promise<string> => {
  const logger = loggerFor(`uv.python.${version}`)
  await assertUv(logger)
  // Force managed interpreters so we never pick up an incompatible system Python.
  const onlyManagedEnv = { UV_PYTHON_PREFERENCE: 'only-managed' }
  logger.info(`Ensuring managed CPython ${version} is installed`)
  await uv(['python', 'install', version], logger, onlyManagedEnv)
  const interpreterPath = (
    await uvWithStdout(['python', 'find', version], logger, onlyManagedEnv)
  ).trim()
  logger.info(`Managed CPython ${version} interpreter resolved to: ${interpreterPath}`)
  return interpreterPath
}

/**
 * Install Python packages into a flat target directory using `uv pip install --target`.
 * Packages installed this way are importable when the target directory is on sys.path
 * (e.g. via PYTHONPATH). Used to provision third-party packages for native binaries
 * that embed Python but do not ship all required dependencies (e.g. OVMS needs jinja2
 * for chat-template rendering but does not bundle it).
 *
 * @param packages - Package names or `name==version` specifiers to install.
 * @param targetDir - Directory where packages are installed; must be on sys.path.
 * @param pythonInterpreter - Path to the Python interpreter to resolve dependencies
 *   against (optional; omit to let uv use its default managed interpreter).
 */
export const uvPipInstallToTarget = async (
  packages: string[],
  targetDir: string,
  pythonInterpreter?: string,
): Promise<void> => {
  const logger = loggerFor('uv.pip.install')
  await assertUv(logger)
  const args = ['pip', 'install', ...packages, '--target', targetDir]
  if (pythonInterpreter) {
    args.push('--python', pythonInterpreter)
  }
  await uv(args, logger)
}

/**
 * Detect if an error message indicates a UV cache hash mismatch
 */
const isHashMismatchError = (errorMessage: string): boolean => {
  return /hash mismatch/i.test(errorMessage)
}

export const ensureBackendVenv = async (backend: string, extraEnv?: Record<string, string>) => {
  const logger = loggerFor(`uv.venv.${backend}`)
  await assertUv(logger)
  const uvVenvCommand = [
    'venv',
    '--directory',
    aipgBaseDir,
    '--project',
    backend,
    '--allow-existing',
    '--relocatable',
  ]
  logger.info(`Ensuring venv for backend: ${backend} with ${JSON.stringify(uvVenvCommand)}`)
  await uv(uvVenvCommand, logger, extraEnv)
}

/**
 * Install packages from requirements.txt into the backend venv using `uv pip`
 * (does not mutate pyproject.toml dependencies — unlike `uv add -r`).
 */
export const pipInstallRequirementsFromFile = async (
  backend: string,
  requirementsTxtPath: string,
  onCacheCorruptionDetected?: () => void,
  extraEnv?: Record<string, string>,
  reinstallPackages?: string[],
) => {
  const logger = loggerFor(`uv.pip-req.${backend}`)
  await assertUv(logger)
  const projectDir = path.join(aipgBaseDir, backend)
  const uvCommand = ['pip', 'install', '--directory', projectDir, '-r', requirementsTxtPath]
  if (reinstallPackages) {
    for (const pkg of reinstallPackages) {
      uvCommand.push('--reinstall-package', pkg)
    }
  }
  logger.info(`pip install -r via uv: ${JSON.stringify(uvCommand)}`)
  try {
    await uv(uvCommand, logger, extraEnv)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (isHashMismatchError(errorMessage)) {
      logger.warn('Hash mismatch in UV cache during pip install, retrying with --no-cache')
      onCacheCorruptionDetected?.()
      await uv([...uvCommand, '--no-cache'], logger, extraEnv)
      return
    }
    throw error
  }
}

export const installBackend = async (
  backend: string,
  onCacheCorruptionDetected?: () => void,
  extraEnv?: Record<string, string>,
) => {
  const logger = loggerFor(`uv.sync.${backend}`)
  await assertUv(logger)
  const uvVenvCommand = [
    'venv',
    '--directory',
    aipgBaseDir,
    '--project',
    backend,
    '--allow-existing',
    '--relocatable',
  ]
  const uvSyncCommand = ['sync', '--directory', aipgBaseDir, '--project', backend]
  logger.info(
    `Installing backend: ${backend} with ${JSON.stringify(uvVenvCommand)} and ${JSON.stringify(uvSyncCommand)}`,
  )
  try {
    await uv(uvVenvCommand, logger, extraEnv)
    return await uv(uvSyncCommand, logger, extraEnv)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)

    if (isHashMismatchError(errorMessage)) {
      logger.warn('Hash mismatch detected in UV cache, retrying with --no-cache')
      onCacheCorruptionDetected?.()
      await uv(uvVenvCommand, logger, extraEnv)
      const noCacheCommand = [...uvSyncCommand, '--no-cache']
      return await uv(noCacheCommand, logger, extraEnv)
    }

    throw error
  }
}

export type UvExtra = 'xpu' | 'cuda' | 'cpu'

/**
 * Install a backend using uv sync with a specific extra (e.g. 'xpu', 'cuda', 'cpu').
 */
export const installBackendWithExtra = async (
  backend: string,
  extra: UvExtra,
  onCacheCorruptionDetected?: () => void,
  extraEnv?: Record<string, string>,
) => {
  const logger = loggerFor(`uv.sync-extra.${backend}.${extra}`)
  await assertUv(logger)
  const uvVenvCommand = [
    'venv',
    '--directory',
    aipgBaseDir,
    '--project',
    backend,
    '--allow-existing',
    '--relocatable',
  ]
  const uvSyncCommand = ['sync', '--directory', aipgBaseDir, '--project', backend, '--extra', extra]
  logger.info(
    `Installing backend w/ extra: ${backend} (${extra}) with ${JSON.stringify(uvVenvCommand)} and ${JSON.stringify(uvSyncCommand)}`,
  )
  try {
    await uv(uvVenvCommand, logger, extraEnv)
    return await uv(uvSyncCommand, logger, extraEnv)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)

    if (isHashMismatchError(errorMessage)) {
      logger.warn('Hash mismatch detected in UV cache during sync-extra, retrying with --no-cache')
      onCacheCorruptionDetected?.()
      await uv(uvVenvCommand, logger, extraEnv)
      const noCacheCommand = [...uvSyncCommand, '--no-cache']
      return await uv(noCacheCommand, logger, extraEnv)
    }

    throw error
  }
}

export const checkBackend = async (backend: string, extra?: UvExtra) => {
  const logger = loggerFor(`uv.check.${backend}`)
  await assertUv(logger)
  const uvCommand = ['sync', '--check', '--directory', aipgBaseDir, '--project', backend]
  // Resolve against the same optional-dependency extra the backend was installed
  // with (e.g. 'xpu'). Without it, uv resolves the base deps — generic torch,
  // which pulls the CUDA index on Linux — and reports a spurious mismatch
  // against an xpu/cpu venv.
  if (extra) uvCommand.push('--extra', extra)
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
  options?: { skipLockfileCheck?: boolean },
  extra?: UvExtra,
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

  if (options?.skipLockfileCheck && venvExists) {
    logger.info(`Skipping uv lockfile check for ${backend} (flexible ComfyUI deps mode)`)
    return {
      venvExists: true,
      action: 'check',
      needsInstallation: false,
      envMismatch: false,
      exitCode: 0,
    }
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
  // Match the installed optional-dependency extra (e.g. 'xpu') so the resolution
  // compares against the same torch variant that was actually installed.
  // Otherwise uv resolves the base deps (generic torch → CUDA index on Linux)
  // and reports a phantom xpu→cuda mismatch.
  if (extra) uvCommand.push('--extra', extra)
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
  const uvCommand = [
    'pip',
    'install',
    '--no-deps',
    '--directory',
    path.join(aipgBaseDir, backend),
    wheelPath,
  ]
  logger.info(`Installing wheel: ${wheelPath} with ${JSON.stringify(uvCommand)}`)

  return uv(uvCommand, logger)
}

export const installExtraWheels = async (backend: string) => {
  const logger = loggerFor(`uv.wheels.${backend}`)
  const wheelDir = app.isPackaged ? aipgBaseDir : path.join(aipgBaseDir, 'WebUI', 'external')
  logger.info(`Scanning for extra wheels in ${wheelDir}`)
  let entries: string[]
  try {
    entries = await fs.promises.readdir(wheelDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.info(`No extra wheels directory found at ${wheelDir}`)
      return
    }
    throw error
  }
  const wheelFiles = entries.filter((e) => e.endsWith('.whl'))
  logger.info(`Found extra wheels: ${JSON.stringify(wheelFiles)}`)
  for (const whl of wheelFiles) {
    await installWheel(backend, path.join(wheelDir, whl))
  }
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
  extraEnv?: Record<string, string>,
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

  await uv(uvCommand, logger, extraEnv)

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
  extraEnv?: Record<string, string>,
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

  await uv(uvCommand, logger, extraEnv)
}
