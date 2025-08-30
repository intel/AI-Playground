#!/usr/bin/env node
/**
 * Fetch Python package resources for AI Playground build
 * Downloads required resources to fixed ./build/resources/ directory
 * Uses built-in fetch API and fixed directory structure
 */

import { existsSync, mkdirSync, createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'
import { getBuildPaths } from './build-paths.mts'
import { normalize } from 'path'

// Get build paths configuration
const buildPaths = getBuildPaths()
const { buildDir: BUILD_DIR, resourcesDir: RESOURCES_DIR } = buildPaths
const {
  embeddablePython: EMBEDDABLE_PYTHON_URL,
  getPipScript: GET_PIP_SCRIPT_URL,
  sevenZipExe: SEVEN_ZR_EXE_URL,
} = buildPaths.resourceUrls

interface DownloadResult {
  url: string
  filePath: string
  success: boolean
  error?: string
}

/**
 * Get base filename from URL
 */
function getBaseFileName(url: string): string {
  const urlPathSegments = url.split('/')
  return urlPathSegments[urlPathSegments.length - 1]
}

/**
 * Download file using built-in fetch API
 */
async function downloadFile(url: string, targetPath: string): Promise<DownloadResult> {
  try {
    console.log(`Downloading ${url} to ${targetPath}`)

    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    if (!response.body) {
      throw new Error('Response body is null')
    }

    const fileStream = createWriteStream(targetPath)
    await pipeline(response.body, fileStream)

    console.log(`✅ Downloaded ${targetPath} successfully!`)
    return { url, filePath: targetPath, success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`❌ Error downloading ${url}: ${errorMessage}`)
    return { url, filePath: targetPath, success: false, error: errorMessage }
  }
}

/**
 * Download file if not already present
 */
async function downloadFileIfNotPresent(url: string): Promise<DownloadResult> {
  const fileName = getBaseFileName(url)
  const expectedFilePath = buildPaths.resourcesDir + '/' + fileName

  if (existsSync(expectedFilePath)) {
    console.log(`⏭️  Skipping ${url} - ${expectedFilePath} already exists`)
    return { url, filePath: expectedFilePath, success: true }
  }

  return await downloadFile(url, expectedFilePath)
}

/**
 * Prepare target directories
 */
function prepareDirectories(): void {
  console.log('📁 Preparing build directories...')

  // Create build directories if they don't exist
  if (!existsSync(BUILD_DIR)) {
    mkdirSync(BUILD_DIR, { recursive: true })
    console.log(`Created directory: ${BUILD_DIR}`)
  }

  if (!existsSync(RESOURCES_DIR)) {
    mkdirSync(RESOURCES_DIR, { recursive: true })
    console.log(`Created directory: ${RESOURCES_DIR}`)
  }
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
  console.log('🚀 Starting Python package resources fetch...')
  console.log(`📂 Repository Root: ${buildPaths.repoRoot}`)
  console.log(`📂 Target directory: ${buildPaths.resourcesDir}`)

  try {
    // Prepare directories
    prepareDirectories()

    // Download all required files
    const downloads = await Promise.all([
      downloadFileIfNotPresent(EMBEDDABLE_PYTHON_URL),
      downloadFileIfNotPresent(GET_PIP_SCRIPT_URL),
      downloadFileIfNotPresent(SEVEN_ZR_EXE_URL),
    ])

    // Check for any download failures
    const failures = downloads.filter((result) => !result.success)
    if (failures.length > 0) {
      console.error('❌ Some downloads failed:')
      failures.forEach((failure) => {
        console.error(`  - ${failure.url}: ${failure.error}`)
      })
      process.exit(1)
    }

    console.log('✅ All Python package resources fetched successfully!')
    console.log(`📂 Resources available in: ${buildPaths.resourcesDir}`)
  } catch (error) {
    console.error('❌ Fatal error during resource fetch:', error)
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
