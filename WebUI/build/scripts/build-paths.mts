/**
 * Shared build path configuration for AI Playground
 * Ensures all build scripts use consistent directory paths
 * All paths are relative to the repository root
 */

import { resolve, join, sep } from 'path'

/**
 * Get the repository root directory
 * This function works regardless of where the script is called from
 */
function getRepoRoot(): string {
  // When called from WebUI directory, go up one level to reach repo root
  // When called from repo root, stay at current level
  const currentDir = process.cwd()

  // Check if we're in the WebUI subdirectory
  if (currentDir.endsWith('WebUI') || currentDir.includes('WebUI' + sep)) {
    return resolve(currentDir, '..')
  }

  // Otherwise assume we're at repo root
  return currentDir
}

// Repository root directory
export const REPO_ROOT = getRepoRoot()

// Build directories (all relative to repo root)
export const BUILD_DIR = join(REPO_ROOT, 'build')
export const RESOURCES_DIR = join(BUILD_DIR, 'resources')
export const PYTHON_ENV_DIR = join(BUILD_DIR, 'python-env')
export const ELECTRON_DIR = join(BUILD_DIR, 'electron')

// WebUI build directories
export const WEBUI_NODE_MODULES_DIR = join(REPO_ROOT, 'WebUI', 'node_modules')
export const WEBUI_BUILD_DIR = join(REPO_ROOT, 'WebUI', 'build')
export const WEBUI_BUILD_SCRIPTS_DIR = join(WEBUI_BUILD_DIR, 'scripts')
export const WEBUI_EXTERNAL_DIR = join(REPO_ROOT, 'WebUI', 'external')

// Backend service directories (all relative to repo root)
export const SERVICE_DIR = join(REPO_ROOT, 'service')
export const LLAMACPP_DIR = join(REPO_ROOT, 'LlamaCPP')
export const OPENVINO_DIR = join(REPO_ROOT, 'OpenVINO')
export const DEVICE_SERVICE_DIR = join(REPO_ROOT, 'device-service')
export const SHARED_BACKEND_DIR = join(REPO_ROOT, 'backend-shared')

// Resource file paths
export const SEVEN_ZIP_EXE = join(RESOURCES_DIR, '7zr.exe')
export const GET_PIP_FILE = join(RESOURCES_DIR, 'get-pip.py')
export const PYTHON_ENV_ARCHIVE = join(RESOURCES_DIR, 'prototype-python-env.7z')

// Resource URLs
export const EMBEDDABLE_PYTHON_URL = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip'
export const GET_PIP_SCRIPT_URL = 'https://bootstrap.pypa.io/get-pip.py'
export const SEVEN_ZR_EXE_URL = 'https://github.com/ip7z/7zip/releases/download/25.01/7zr.exe'

/**
 * Build configuration interface
 */
export interface BuildPaths {
  repoRoot: string
  buildDir: string
  resourcesDir: string
  pythonEnvDir: string
  electronDir: string
  webUIExternalDir: string
  webUIBuildDir: string
  webUINodeModulesDir: string
  backendDirs: {
    service: string
    llamaCpp: string
    openVINO: string
    deviceService: string
    sharedBackend: string
  }
  resourceFiles: {
    sevenZipExe: string
    getPipFile: string
    pythonEnvArchive: string
  }
  resourceUrls: {
    embeddablePython: string
    getPipScript: string
    sevenZipExe: string
  }
}

/**
 * Get complete build paths configuration
 */
export function getBuildPaths(): BuildPaths {
  return {
    repoRoot: REPO_ROOT,
    buildDir: BUILD_DIR,
    resourcesDir: RESOURCES_DIR,
    pythonEnvDir: PYTHON_ENV_DIR,
    electronDir: ELECTRON_DIR,
    webUIExternalDir: WEBUI_EXTERNAL_DIR,
    webUIBuildDir: WEBUI_BUILD_DIR,
    webUINodeModulesDir: WEBUI_NODE_MODULES_DIR,
    backendDirs: {
      service: SERVICE_DIR,
      llamaCpp: LLAMACPP_DIR,
      openVINO: OPENVINO_DIR,
      deviceService: DEVICE_SERVICE_DIR,
      sharedBackend: SHARED_BACKEND_DIR,
    },
    resourceFiles: {
      sevenZipExe: SEVEN_ZIP_EXE,
      getPipFile: GET_PIP_FILE,
      pythonEnvArchive: PYTHON_ENV_ARCHIVE,
    },
    resourceUrls: {
      embeddablePython: EMBEDDABLE_PYTHON_URL,
      getPipScript: GET_PIP_SCRIPT_URL,
      sevenZipExe: SEVEN_ZR_EXE_URL,
    },
  }
}

/**
 * Log build paths for debugging
 */
export function logBuildPaths(): void {
  const paths = getBuildPaths()
  console.log('📂 Build Paths Configuration:')
  console.log(`   Repository Root: ${paths.repoRoot}`)
  console.log(`   Build Directory: ${paths.buildDir}`)
  console.log(`   Resources Directory: ${paths.resourcesDir}`)
  console.log(`   Python Environment: ${paths.pythonEnvDir}`)
  console.log(`   WebUI External Directory: ${paths.webUIExternalDir}`)
  console.log(`   Electron Build: ${paths.electronDir}`)
}
