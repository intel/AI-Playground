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
const logSourceName = 'updateIntelWorkflows'

const resourcesBaseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../../')
const externalRes = path.resolve(
  app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../external/'),
)

const gitExePath = path.join(resourcesBaseDir, 'portable-git', 'cmd', 'git.exe')
const workflowDirTargetPath = path.join(externalRes, 'workflows')
const workflowDirSpareGitRepoPath = path.join(externalRes, 'workflows_intel')
const intelWorkflowDirPath = path.join(
  workflowDirSpareGitRepoPath,
  'WebUI',
  'external',
  'workflows',
)
const workflowDirBakTargetPath = path.join(externalRes, 'workflows_bak')

const gitRef = app.getVersion()

export async function updateIntelWorkflows(
  remoteRepository: string,
): Promise<UpdateWorkflowsFromIntelResult> {
  try {
    await fetchNewIntelWorkflows(remoteRepository)
    await backUpCurrentWorkflows()
    await replaceCurrentWorkflowsWithIntelWorkflows()
    return {
      result: 'success',
      backupDir: workflowDirBakTargetPath,
    }
  } catch (e) {
    // Check if this is the expected case where git ref doesn't exist
    if (e instanceof Error && e.message.startsWith('GitRefNotFound:')) {
      logger.info(
        `Workflow update skipped cleanly - git ref does not exist (expected for fresh releases)`,
        logSourceName,
        true,
      )
      return {
        result: 'noUpdate',
      }
    }

    // Handle other errors as before
    logger.error(`updating intel workflows failed due to ${e}`, logSourceName, true)
    if (!fs.existsSync(workflowDirTargetPath)) {
      logger.info(
        `restoring previous workflows from  ${workflowDirBakTargetPath}`,
        logSourceName,
        true,
      )
      await copyFileWithDirs(intelWorkflowDirPath, workflowDirTargetPath)
    }
    return {
      result: 'error',
    }
  } finally {
    await filterPartnerWorkflows()
  }
}

async function fetchNewIntelWorkflows(remoteRepository: string) {
  const remoteRepoUrl = `https://github.com/${remoteRepository}`
  logger.info(
    `fetching intel workflows from ${remoteRepoUrl} and ref ${gitRef}`,
    logSourceName,
    true,
  )
  const gitExe = existingFileOrError(gitExePath)
  const gitWorkDir = workflowDirSpareGitRepoPath
  await prepareSparseGitRepoDir(gitWorkDir)
  await prepareSparseGitCheckout(gitWorkDir, gitExe, remoteRepoUrl)

  // Check if the git ref exists before attempting checkout
  const refExists = await checkGitRefExists(gitExe, gitWorkDir, gitRef)
  if (!refExists) {
    logger.info(
      `Git ref '${gitRef}' does not exist in remote repository. Skipping workflow update - this is expected for freshly released versions.`,
      logSourceName,
      true,
    )
    throw new Error(`GitRefNotFound: ${gitRef}`)
  }

  await spawnProcessAsync(gitExe, ['fetch', 'origin'], processLogHandler, {}, gitWorkDir)
  await spawnProcessAsync(gitExe, ['checkout', gitRef], processLogHandler, {}, gitWorkDir)
  await spawnProcessAsync(gitExe, ['pull'], processLogHandler, {}, gitWorkDir)
  logger.info(
    `cloned current intel workflows from ${gitRef} into ${workflowDirBakTargetPath}`,
    logSourceName,
    true,
  )
}

async function backUpCurrentWorkflows() {
  await copyFileWithDirs(workflowDirTargetPath, workflowDirBakTargetPath)
  logger.info(
    `backed up current user workflows at ${workflowDirBakTargetPath}`,
    logSourceName,
    true,
  )
  return
}

async function replaceCurrentWorkflowsWithIntelWorkflows() {
  if (fs.existsSync(workflowDirTargetPath)) {
    logger.warn(`removing previous workflow dir at ${workflowDirTargetPath}`, logSourceName, true)
    await fs.promises.rm(workflowDirTargetPath, { recursive: true, force: true })
  }
  await fs.promises.mkdir(workflowDirTargetPath, { recursive: true })
  await copyFileWithDirs(intelWorkflowDirPath, workflowDirTargetPath)
  logger.info(
    `repopulated workflow dir with intel workflows at ${workflowDirTargetPath}`,
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
  logger.info(`reusing existing dir ${dirPath} for fetching remote workflows`, logSourceName, true)
}

async function prepareSparseGitCheckout(workDir: string, gitExe: string, remoteRepoUrl: string) {
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
    await fs.promises.writeFile(sparseCheckoutConfigFile, 'WebUI/external/workflows/*', {
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

async function filterPartnerWorkflows() {
  const workflows = await fs.promises.readdir(workflowDirTargetPath, { withFileTypes: true })
  const acerWorkflows = workflows.filter((wf) => wf.name.startsWith('Acer'))
  const acerVisionArtIsInstalled = await getFromRegistry(
    'HKLM:\\SOFTWARE\\Acer\\AICO2',
    'AICO2Installer',
  )
  if (!acerVisionArtIsInstalled) {
    for (const wf of acerWorkflows) {
      await fs.promises.rm(path.join(workflowDirTargetPath, wf.name))
    }
  } else {
    logger.info(`Acer Vision Art detected, keeping Acer workflows`, logSourceName, true)
  }
}

async function getFromRegistry(path: string, key: string) {
  const script = `
  $ErrorActionPreference = 'Stop'
  try {
    $value = Get-ItemProperty -Path ${path} -Name ${key}
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
