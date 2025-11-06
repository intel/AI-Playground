import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'fs'
import { appLoggerInstance } from '../logging/logger'
import { isPackageInstalled as uvIsPackageInstalled, installPypiPackage as uvInstallPackage, installRequirementsTxt } from './uvBasedBackends/uv'

const execAsync = promisify(exec)

// Backend name for ComfyUI
const COMFYUI_BACKEND = 'ComfyUI'

export interface ComfyUICustomNodeRepoId {
  username: string
  repoName: string
  gitRef?: string
}

const REACTOR_SFW_PATCH = `from transformers import pipeline
from PIL import Image
import logging

SCORE = 0.965 # 0.965 and less - is safety content

logging.getLogger('transformers').setLevel(logging.ERROR)
from scripts.reactor_logger import logger

def nsfw_image(img_path: str, model_path: str):
    with Image.open(img_path) as img:
        predict = pipeline("image-classification", model=model_path)
        result = predict(img)
        logger.status(result)
        # Find the element with 'nsfw' label
        for item in result:
            if item["label"] == "nsfw":
                # Return True if nsfw score is above threshold (indicating NSFW content)
                # Return False if nsfw score is below threshold (indicating safe content)
                return True if item["score"] > SCORE else False
        # If no 'nsfw' label found, consider it safe
        return False
`

/**
 * Get the git binary path based on platform
 */
export function getGitBinaryPath(): string {
  if (process.platform === 'win32') {
    return path.join(process.resourcesPath, '..', 'portable-git', 'cmd', 'git.exe')
  }
  return 'git'
}

/**
 * Check if git is installed
 */
export async function isGitInstalled(): Promise<boolean> {
  if (process.platform === 'win32') {
    return fs.existsSync(getGitBinaryPath())
  }
  try {
    await execAsync('git --version')
    return true
  } catch {
    return false
  }
}

/**
 * Check if ComfyUI is installed
 */
export function isComfyUIInstalled(comfyUiRootPath: string): boolean {
  return fs.existsSync(comfyUiRootPath)
}

/**
 * Remove existing filesystem resource
 */
function removeExistingResource(targetPath: string): void {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true })
    appLoggerInstance.info(`Removed existing resource: ${targetPath}`, 'comfyui-tools')
  }
}

/**
 * Install a git repository
 */
async function installGitRepo(gitRepoUrl: string, targetDir: string): Promise<void> {
  try {
    removeExistingResource(targetDir)
    const gitPath = getGitBinaryPath()
    await execAsync(`"${gitPath}" clone ${gitRepoUrl} "${targetDir}"`)
    appLoggerInstance.info(`Cloned ${gitRepoUrl} into ${targetDir}`, 'comfyui-tools')
  } catch (error) {
    appLoggerInstance.error(
      `Git clone failed with exception: ${error}. Cleaning up failed resources.`,
      'comfyui-tools',
    )
    removeExistingResource(targetDir)
    throw error
  }
}

/**
 * Checkout a specific git ref
 */
async function checkoutGitRef(repoDir: string, gitRef?: string): Promise<void> {
  if (!gitRef || !gitRef.trim()) {
    appLoggerInstance.info(`No valid git ref provided for ${repoDir}`, 'comfyui-tools')
    const currentRef = await getGitRef(repoDir)
    appLoggerInstance.warn(`Repo ${repoDir} remains in ref ${currentRef}`, 'comfyui-tools')
    return
  }

  try {
    const gitPath = getGitBinaryPath()
    await execAsync(`"${gitPath}" checkout ${gitRef}`, { cwd: repoDir })
    appLoggerInstance.info(`Checked out ${gitRef} in ${repoDir}`, 'comfyui-tools')
  } catch (error) {
    appLoggerInstance.warn(
      `Git checkout of ${gitRef} failed for repo ${repoDir} due to: ${error}`,
      'comfyui-tools',
    )
    const currentRef = await getGitRef(repoDir)
    appLoggerInstance.warn(`Repo ${repoDir} remains in ref ${currentRef}`, 'comfyui-tools')
  }
}

/**
 * Get the current git ref (commit hash)
 */
export async function getGitRef(repoDir: string): Promise<string | undefined> {
  try {
    const gitPath = getGitBinaryPath()
    const { stdout } = await execAsync(`"${gitPath}" rev-parse HEAD`, { cwd: repoDir })
    return stdout.trim()
  } catch (error) {
    appLoggerInstance.warn(`Resolving git ref in ${repoDir} failed due to: ${error}`, 'comfyui-tools')
    return undefined
  }
}

/**
 * Install pip requirements from requirements.txt using uv
 */
async function installPipRequirements(requirementsTxtPath: string): Promise<void> {
  appLoggerInstance.info(
    `Installing python requirements from ${requirementsTxtPath} using uv`,
    'comfyui-tools',
  )

  if (!fs.existsSync(requirementsTxtPath)) {
    appLoggerInstance.warn(`Specified ${requirementsTxtPath} does not exist`, 'comfyui-tools')
    return
  }

  try {
    await installRequirementsTxt(COMFYUI_BACKEND, requirementsTxtPath)
    appLoggerInstance.info('Python requirements installation completed', 'comfyui-tools')
  } catch (error) {
    appLoggerInstance.error(
      `Failed to install requirements from ${requirementsTxtPath}: ${error}`,
      'comfyui-tools',
    )
    throw error
  }
}

/**
 * Check if a Python package is installed using uv
 */
export async function isPackageInstalled(packageSpecifier: string): Promise<boolean> {
  try {
    return await uvIsPackageInstalled(COMFYUI_BACKEND, packageSpecifier)
  } catch (error) {
    appLoggerInstance.error(`Failed to check if package is installed: ${error}`, 'comfyui-tools')
    return false
  }
}

/**
 * Install a Python package via uv pip
 */
export async function installPypiPackage(packageSpecifier: string): Promise<void> {
  if (await isPackageInstalled(packageSpecifier)) {
    appLoggerInstance.info(
      `Package ${packageSpecifier} already installed. Omitting installation`,
      'comfyui-tools',
    )
    return
  }

  try {
    appLoggerInstance.info(
      `Installing python package ${packageSpecifier} using uv`,
      'comfyui-tools',
    )
    await uvInstallPackage(COMFYUI_BACKEND, packageSpecifier)
    appLoggerInstance.info('Python package installation completed', 'comfyui-tools')
  } catch (error) {
    appLoggerInstance.error(`Failed to install package ${packageSpecifier}: ${error}`, 'comfyui-tools')
    throw error
  }
}

/**
 * Check if a custom node is installed
 */
export function isCustomNodeInstalled(
  nodeRepoRef: ComfyUICustomNodeRepoId,
  comfyUiRootPath: string,
): boolean {
  const expectedCustomNodePath = path.join(
    comfyUiRootPath,
    'custom_nodes',
    nodeRepoRef.repoName,
  )
  return fs.existsSync(expectedCustomNodePath)
}

/**
 * Patch custom node if required (specific workarounds)
 */
function patchCustomNodeIfRequired(
  customNodePath: string,
  nodeRepoData: ComfyUICustomNodeRepoId,
): void {
  const repoIdentifier =
    `${nodeRepoData.username}/${nodeRepoData.repoName}@${nodeRepoData.gitRef}`.toLowerCase()

  // Apply specific patches for known issues
  if (repoIdentifier === 'gourieff/comfyui-reactor@d2318ad140582c6d0b68c51df342319b502006ed') {
    const reactorSfwPath = path.join(customNodePath, 'scripts', 'reactor_sfw.py')
    fs.writeFileSync(reactorSfwPath, REACTOR_SFW_PATCH, 'utf-8')
    appLoggerInstance.info(`Patched ${reactorSfwPath} with custom logic`, 'comfyui-tools')
  }
}

/**
 * Download and install a ComfyUI custom node
 */
export async function downloadCustomNode(
  nodeRepoData: ComfyUICustomNodeRepoId,
  comfyUiRootPath: string,
): Promise<boolean> {
  if (isCustomNodeInstalled(nodeRepoData, comfyUiRootPath)) {
    appLoggerInstance.info(`Node repo ${JSON.stringify(nodeRepoData)} already exists. Omitting`, 'comfyui-tools')
    return true
  }

  try {
    const expectedGitUrl = `https://github.com/${nodeRepoData.username}/${nodeRepoData.repoName}`
    const expectedCustomNodePath = path.join(
      comfyUiRootPath,
      'custom_nodes',
      nodeRepoData.repoName,
    )
    const potentialNodeRequirements = path.join(expectedCustomNodePath, 'requirements.txt')

    // Install the git repo
    await installGitRepo(expectedGitUrl, expectedCustomNodePath)

    // Checkout specific git ref if provided
    await checkoutGitRef(expectedCustomNodePath, nodeRepoData.gitRef)

    // Apply patches if needed
    patchCustomNodeIfRequired(expectedCustomNodePath, nodeRepoData)

    // Install pip requirements using uv
    await installPipRequirements(potentialNodeRequirements)

    appLoggerInstance.info(
      `Successfully installed custom node ${nodeRepoData.username}/${nodeRepoData.repoName}`,
      'comfyui-tools',
    )
    return true
  } catch (error) {
    appLoggerInstance.error(
      `Failed to install custom comfy node ${nodeRepoData.username}/${nodeRepoData.repoName} due to: ${error}`,
      'comfyui-tools',
    )
    return false
  }
}

/**
 * Uninstall a ComfyUI custom node
 */
export async function uninstallCustomNode(
  nodeRepoData: ComfyUICustomNodeRepoId,
  comfyUiRootPath: string,
): Promise<boolean> {
  const customNodePath = path.join(comfyUiRootPath, 'custom_nodes', nodeRepoData.repoName)

  if (!fs.existsSync(customNodePath)) {
    appLoggerInstance.warn(
      `Custom node ${nodeRepoData.repoName} not found at ${customNodePath}`,
      'comfyui-tools',
    )
    return false
  }

  try {
    removeExistingResource(customNodePath)
    appLoggerInstance.info(
      `Successfully uninstalled custom node ${nodeRepoData.username}/${nodeRepoData.repoName}`,
      'comfyui-tools',
    )
    return true
  } catch (error) {
    appLoggerInstance.error(
      `Failed to uninstall custom node ${nodeRepoData.username}/${nodeRepoData.repoName}: ${error}`,
      'comfyui-tools',
    )
    return false
  }
}

/**
 * List all installed custom nodes
 */
export function listInstalledCustomNodes(comfyUiRootPath: string): string[] {
  const customNodesDir = path.join(comfyUiRootPath, 'custom_nodes')

  if (!fs.existsSync(customNodesDir)) {
    appLoggerInstance.warn(`Custom nodes directory not found: ${customNodesDir}`, 'comfyui-tools')
    return []
  }

  try {
    const entries = fs.readdirSync(customNodesDir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    appLoggerInstance.error(`Failed to list custom nodes: ${error}`, 'comfyui-tools')
    return []
  }
}
