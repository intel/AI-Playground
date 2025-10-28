#!/usr/bin/env node
/**
 * Prepare Python environment for AI Playground build
 * Creates Python environment from embeddable Python in fixed ./build/python-env/ directory
 * Uses fixed directory structure and proper error handling
 */

import { existsSync, mkdirSync, rmSync, readdirSync, writeFileSync, copyFileSync } from 'fs'
import { join, normalize } from 'path'
import { execSync, spawnSync } from 'child_process'
import AdmZip from 'adm-zip'
import { getBuildPaths } from './build-paths.mts'
import z from 'zod'

const target = z.enum(['win32', 'darwin']).safeParse(process.env.TARGET_PLATFORM || process.platform)
if (!target.success) {
  console.error(`❌ Unsupported TARGET_PLATFORM: ${target}`)
  process.exit(1)
}

// Get build paths configuration
const buildPaths = getBuildPaths(target.data)
const {
  resourcesDir: RESOURCES_DIR,
  pythonEnvDir: PYTHON_ENV_DIR,
  buildDir,
  resourceFiles,
  pythonEnvDir,
} = buildPaths

interface PythonEnvConfig {
  pythonEmbedZipFile: string
  getPipFile: string
}

/**
 * Verify all required files exist
 */
function verifyFilesExist(): PythonEnvConfig {
  console.log('🔍 Verifying all required files exist...')

  if (!existsSync(RESOURCES_DIR)) {
    console.error(`❌ Resources directory not found: ${RESOURCES_DIR}`)
    console.error('Please run fetch-python-package-resources.ts first')
    process.exit(1)
  }

  const resourceFiles = readdirSync(RESOURCES_DIR)

  // Find Python embed zip file
  const pythonEmbedZipFile =
    RESOURCES_DIR +
    '/' +
    (resourceFiles.find(
      (fileName) => fileName.startsWith('python-3.12.10') && fileName.endsWith('.zip'),
    ) || '')

  if (!existsSync(pythonEmbedZipFile)) {
    console.error('❌ Python embeddable zip file not found in resources directory')
    console.error(`Expected pattern: python-3.12.10-*.zip in ${RESOURCES_DIR}`)
    process.exit(1)
  }

  // Find get-pip.py file
  const getPipFile = buildPaths.resourceFiles.getPipFile
  if (!existsSync(getPipFile)) {
    console.error(`❌ get-pip.py not found: ${getPipFile}`)
    process.exit(1)
  }

  console.log('✅ All required files exist')
  return { pythonEmbedZipFile, getPipFile }
}

/**
 * Prepare Python environment directory
 */
function preparePythonEnvDir(): void {
  if (existsSync(PYTHON_ENV_DIR)) {
    console.log(`🗑️  Removing existing Python environment: ${PYTHON_ENV_DIR}`)
    rmSync(PYTHON_ENV_DIR, { recursive: true })
  }

  mkdirSync(PYTHON_ENV_DIR, { recursive: true })
  console.log(`📁 Created Python environment directory: ${PYTHON_ENV_DIR}`)
}

/**
 * Create Python environment from embeddable Python zip
 */
function createPythonEnvFromEmbeddableZip(pythonEmbedZipFile: string): void {
  console.log('📦 Extracting embeddable Python...')

  try {
    const pythonEmbed = new AdmZip(pythonEmbedZipFile)
    pythonEmbed.extractAllTo(PYTHON_ENV_DIR, true)
    console.log(`✅ Extracted embeddable Python to: ${PYTHON_ENV_DIR}`)
  } catch (error) {
    console.error(`❌ Failed to extract Python zip: ${error}`)
    process.exit(1)
  }

  // Configure Python path
  console.log('⚙️  Configuring Python environment paths...')

  try {
    // Find the Python version by looking for python*._pth file
    const files = readdirSync(PYTHON_ENV_DIR)
    const pthFilePattern = /^python(\d+)\._pth$/
    let pythonVersion: string | null = null
    let pthFileName: string | null = null

    for (const file of files) {
      const match = file.match(pthFilePattern)
      if (match) {
        pythonVersion = match[1]
        pthFileName = file
        break
      }
    }

    if (!pythonVersion || !pthFileName) {
      console.error('❌ Could not find python*._pth file in the target directory')
      process.exit(1)
    }

    console.log(`🐍 Found Python version: ${pythonVersion} (${pthFileName})`)

    const pthFile = join(PYTHON_ENV_DIR, pthFileName)
    const pthContent = `python${pythonVersion}.zip
.

# Uncomment to run site.main() automatically
import site
`
    writeFileSync(pthFile, pthContent)
    console.log(`✅ Configured Python paths in ${pthFileName}`)
  } catch (error) {
    console.error(`❌ Failed to configure Python paths: ${error}`)
    process.exit(1)
  }
}

/**
 * Install pip in the Python environment
 */
function installPip(getPipFile: string): void {
  console.log('📦 Installing pip...')

  try {
    // Copy get-pip.py to Python environment
    const getPipDest = join(PYTHON_ENV_DIR, 'get-pip.py')
    copyFileSync(getPipFile, getPipDest)
    console.log(`📋 Copied get-pip.py to: ${getPipDest}`)

    // Install pip
    const pythonExe = join(PYTHON_ENV_DIR, 'python.exe')
    if (!existsSync(pythonExe)) {
      console.error(`❌ Python executable not found: ${pythonExe}`)
      process.exit(1)
    }

    console.log('⚙️  Running pip installation...')
    execSync(`"${pythonExe}" "${getPipDest}"`, {
      stdio: 'inherit',
      cwd: PYTHON_ENV_DIR,
    })
    console.log('✅ Pip installed successfully')

    // Install uv package manager
    console.log('📦 Installing uv package manager...')
    execSync(`"${pythonExe}" -m pip install uv`, {
      stdio: 'inherit',
      cwd: PYTHON_ENV_DIR,
    })
    console.log('✅ UV package manager installed successfully')
  } catch (error) {
    console.error(`❌ Failed to install pip: ${error}`)
    process.exit(1)
  }
}

/**
 * Compress Python environment using 7-Zip
 */
function compressPythonEnvironment(): void {
  const targetArchive = resourceFiles.pythonEnvArchive

  console.log(`📦 Compressing Python environment...`)
  console.log(`   Source: ${pythonEnvDir}`)
  console.log(`   Target: ${targetArchive}`)

  try {
    // Remove existing archive
    if (existsSync(targetArchive)) {
      console.log(`🗑️  Removing existing archive: ${targetArchive}`)
      rmSync(targetArchive, { recursive: true })
    }

    // Compress Python environment
    const result = spawnSync(
      resourceFiles.sevenZipExe,
      ['a', targetArchive, join(pythonEnvDir, '*')],
      {
        stdio: 'inherit',
        cwd: buildDir,
      },
    )

    if (result.status !== 0) {
      console.error('❌ Failed to compress Python environment')
      process.exit(1)
    }

    console.log(`✅ Python environment compressed to: ${targetArchive}`)
  } catch (error) {
    console.error(`❌ Error compressing Python environment: ${error}`)
    process.exit(1)
  }
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
  console.log('🚀 Starting Python environment preparation...')
  console.log(`📂 Repository Root: ${buildPaths.repoRoot}`)
  console.log(`📂 Target directory: ${buildPaths.pythonEnvDir}`)

  try {
    // Verify all required files exist
    const config = verifyFilesExist()

    // Prepare Python environment directory
    preparePythonEnvDir()

    // Create Python environment from embeddable zip
    createPythonEnvFromEmbeddableZip(config.pythonEmbedZipFile)

    // Install pip
    installPip(config.getPipFile)

    // Compress Python environment
    compressPythonEnvironment()

    console.log('✅ Python environment prepared successfully!')
    console.log(`📂 Environment available at: ${buildPaths.pythonEnvDir}`)
  } catch (error) {
    console.error('❌ Fatal error during Python environment preparation:', error)
    process.exit(1)
  }
}

// Execute main function
if (normalize(import.meta.url) === normalize(`file://${process.argv[1]}`)) {
  main().catch((error) => {
    console.error('❌ Unhandled error:', error)
    process.exit(1)
  })
}
