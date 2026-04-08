import { appLoggerInstance } from '../logging/logger.ts'
import path from 'node:path'
import * as fs from 'fs-extra'
import { copyFileWithDirs, existingFileOrError, spawnProcessAsync } from './osProcessHelper.ts'
import { app } from 'electron'
import { execSync } from 'node:child_process'

const logger = appLoggerInstance
const processLogHandler = (data: string) => {
  logger.info(data, logSourceName, true)
}
const logSourceName = 'updateIntelPresets'

const resourcesBaseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../../')
const modesBaseDir = path.resolve(
  app.isPackaged
    ? path.join(process.resourcesPath, 'modes')
    : path.join(__dirname, '../../../modes/'),
)

const gitExePath = path.join(resourcesBaseDir, 'portable-git', 'cmd', 'git.exe')
const presetDirSpareGitRepoPath = path.join(modesBaseDir, '..', 'presets_intel')

const gitRef = app.getVersion()

export async function updateIntelPresets(
  remoteRepository: string,
  mode: string,
  variant: string,
  presetDirTargetPath: string,
): Promise<UpdatePresetsFromIntelResult> {
  const intelPresetDirPath = path.join(presetDirSpareGitRepoPath, 'modes', mode, variant)
  const presetDirBakTargetPath = `${presetDirTargetPath}_bak`
  const sparseCheckoutPattern = `modes/${mode}/${variant}/*`
  try {
    await fetchNewIntelPresets(remoteRepository, sparseCheckoutPattern)
    await backUpCurrentPresets(presetDirTargetPath, presetDirBakTargetPath)
    await replaceCurrentPresetsWithIntelPresets(presetDirTargetPath, intelPresetDirPath)
    await filterPartnerPresets(presetDirTargetPath)
    return {
      result: 'success',
      backupDir: presetDirBakTargetPath,
    }
  } catch (e) {
    // Check if this is the expected case where git ref doesn't exist
    if (e instanceof Error && e.message.startsWith('GitRefNotFound:')) {
      logger.info(
        `Preset update skipped cleanly - git ref does not exist (expected for fresh releases)`,
        logSourceName,
        true,
      )
      return {
        result: 'noUpdate',
      }
    }

    // Handle other errors as before
    logger.error(`updating intel presets failed due to ${e}`, logSourceName, true)
    if (!fs.existsSync(presetDirTargetPath)) {
      logger.info(`restoring previous presets from  ${presetDirBakTargetPath}`, logSourceName, true)
      await copyFileWithDirs(presetDirBakTargetPath, presetDirTargetPath)
    }
    return {
      result: 'error',
    }
  }
}

async function fetchNewIntelPresets(remoteRepository: string, sparseCheckoutPattern: string) {
  const remoteRepoUrl = `https://github.com/${remoteRepository}`
  logger.info(`fetching intel presets from ${remoteRepoUrl} and ref ${gitRef}`, logSourceName, true)
  const gitExe = existingFileOrError(gitExePath)
  const gitWorkDir = presetDirSpareGitRepoPath
  await prepareSparseGitRepoDir(gitWorkDir)
  await prepareSparseGitCheckout(gitWorkDir, gitExe, remoteRepoUrl, sparseCheckoutPattern)

  // Check if the git ref exists before attempting checkout
  const refExists = await checkGitRefExists(gitExe, gitWorkDir, gitRef)
  if (!refExists) {
    logger.info(
      `Git ref '${gitRef}' does not exist in remote repository. Skipping preset update - this is expected for freshly released versions.`,
      logSourceName,
      true,
    )
    throw new Error(`GitRefNotFound: ${gitRef}`)
  }

  await spawnProcessAsync(gitExe, ['fetch', 'origin'], processLogHandler, {}, gitWorkDir)
  await spawnProcessAsync(gitExe, ['checkout', gitRef], processLogHandler, {}, gitWorkDir)
  await spawnProcessAsync(gitExe, ['pull'], processLogHandler, {}, gitWorkDir)
  logger.info(
    `cloned current intel presets from ${gitRef} into ${presetDirSpareGitRepoPath}`,
    logSourceName,
    true,
  )
}

async function backUpCurrentPresets(presetDirTargetPath: string, presetDirBakTargetPath: string) {
  await copyFileWithDirs(presetDirTargetPath, presetDirBakTargetPath)
  logger.info(`backed up current user presets at ${presetDirBakTargetPath}`, logSourceName, true)
  return
}

async function replaceCurrentPresetsWithIntelPresets(
  presetDirTargetPath: string,
  intelPresetDirPath: string,
) {
  if (fs.existsSync(presetDirTargetPath)) {
    logger.warn(`removing previous preset dir at ${presetDirTargetPath}`, logSourceName, true)
    await fs.promises.rm(presetDirTargetPath, { recursive: true, force: true })
  }
  await fs.promises.mkdir(presetDirTargetPath, { recursive: true })
  await copyFileWithDirs(intelPresetDirPath, presetDirTargetPath)
  logger.info(
    `repopulated preset dir with intel presets at ${presetDirTargetPath}`,
    logSourceName,
    true,
  )
}

async function prepareSparseGitRepoDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    await fs.promises.mkdir(dirPath, { recursive: true })
    logger.info(`Created containment directory at ${dirPath}`, logSourceName, true)
    return
  }
  logger.info(`reusing existing dir ${dirPath} for fetching remote presets`, logSourceName, true)
}

async function prepareSparseGitCheckout(
  workDir: string,
  gitExe: string,
  remoteRepoUrl: string,
  sparseCheckoutPattern: string,
) {
  const sparseCheckoutConfigFile = path.join(workDir, '.git', 'info', 'sparse-checkout')
  if (!fs.existsSync(sparseCheckoutConfigFile)) {
    await spawnProcessAsync(gitExe, ['init'], processLogHandler, {}, workDir)
    await spawnProcessAsync(
      gitExe,
      ['config', 'core.sparseCheckout', 'true'],
      processLogHandler,
      {},
      workDir,
    )
    await spawnProcessAsync(
      gitExe,
      ['remote', 'add', '-f', 'origin', remoteRepoUrl],
      processLogHandler,
      {},
      workDir,
    )
    await fs.promises.writeFile(sparseCheckoutConfigFile, sparseCheckoutPattern, {
      encoding: 'utf-8',
      flag: 'w',
    })
  } else {
    await spawnProcessAsync(
      gitExe,
      ['remote', 'set-url', 'origin', remoteRepoUrl],
      processLogHandler,
      {},
      workDir,
    )
  }
  logger.info(`using existing sparse checkout config`, logSourceName, true)
}

async function checkGitRefExists(gitExe: string, workDir: string, ref: string): Promise<boolean> {
  try {
    // Use git ls-remote to check if the ref exists on the remote repository
    const output = await spawnProcessAsync(
      gitExe,
      ['ls-remote', '--heads', '--tags', 'origin', ref],
      () => {}, // Silent log handler for this check
      {},
      workDir,
    )

    // If the output contains the ref, it exists
    const refExists = output.trim().length > 0 && output.includes(ref)
    logger.info(
      `Git ref '${ref}' ${refExists ? 'exists' : 'does not exist'} in remote repository`,
      logSourceName,
      true,
    )
    return refExists
  } catch (error) {
    logger.warn(
      `Failed to check if git ref '${ref}' exists: ${error}. Assuming it does not exist.`,
      logSourceName,
      true,
    )
    return false
  }
}

export async function filterPartnerPresets(presetDirTargetPath: string) {
  if (!app.isPackaged) return
  const presets = await fs.promises.readdir(presetDirTargetPath, { withFileTypes: true })
  const acerPresets = presets.filter((p) => p.name.startsWith('Acer'))
  const acerVisionArtIsInstalled = await getFromRegistry(
    'HKLM:\\SOFTWARE\\Acer\\AICO2',
    'AICO2Installer',
  )
  if (!acerVisionArtIsInstalled) {
    for (const preset of acerPresets) {
      await fs.promises.rm(path.join(presetDirTargetPath, preset.name))
    }
  } else {
    logger.info(`Acer Vision Art detected, keeping Acer presets`, logSourceName, true)
  }
}

async function getFromRegistry(regPath: string, key: string) {
  const script = `
  $ErrorActionPreference = 'Stop'
  try {
    $value = Get-ItemProperty -Path ${regPath} -Name ${key}
    if ($value -ne $null) {
      Write-Output $value.${key}
    } else {
      Write-Error "Value not found."
    }
  } catch {
    Write-Error "Error: $_"
  }
`
  try {
    const version = execSync(script, { encoding: 'utf-8', shell: 'powershell.exe' })
    return version.length > 0
  } catch (_error: unknown) {
    return false
  }
}
