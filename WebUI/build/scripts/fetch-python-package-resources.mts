#!/usr/bin/env node
/**
 * Fetch Python package resources for AI Playground build
 * Downloads required resources to fixed ./build/resources/ directory
 * Uses built-in fetch API and fixed directory structure
 */

import { existsSync, mkdirSync, createWriteStream, renameSync } from 'fs'
import { pipeline } from 'stream/promises'
import { getBuildPaths } from './build-paths.mts'
import path, { normalize } from 'path'
import z from 'zod'
import { execSync } from 'child_process'
import AdmZip from 'adm-zip'

const target = z
  .enum(['win32', 'darwin'])
  .safeParse(process.env.TARGET_PLATFORM || process.platform)
if (!target.success) {
  console.error(`❌ Unsupported TARGET_PLATFORM: ${target}`)
  process.exit(1)
}

// Get build paths configuration
const buildPaths = getBuildPaths(target.data)

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
  const expectedFilePath = path.join(buildPaths.tmpDir, fileName)

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
  if (!existsSync(buildPaths.buildDir)) {
    mkdirSync(buildPaths.buildDir, { recursive: true })
    console.log(`Created directory: ${buildPaths.buildDir}`)
  }

  if (!existsSync(buildPaths.resourcesDir)) {
    mkdirSync(buildPaths.resourcesDir, { recursive: true })
    console.log(`Created directory: ${buildPaths.resourcesDir}`)
  }
  if (!existsSync(buildPaths.tmpDir)) {
    mkdirSync(buildPaths.tmpDir, { recursive: true })
    console.log(`Created directory: ${buildPaths.tmpDir}`)
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
      downloadFileIfNotPresent(buildPaths.resourceUrls.uv),
      downloadFileIfNotPresent(buildPaths.resourceUrls.sevenZipExe),
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

    // extract uv binary from downloaded archive and move to

    // extract downloads if packed - handle tar.gz, tar.xz on darwin, zip on win32
    for (const download of downloads) {
      if (
        target.data === 'darwin' &&
        (download.filePath.endsWith('.tar.gz') || download.filePath.endsWith('.tar.xz'))
      ) {
        console.log(`📦 Extracting ${download.filePath}...`)
        const extractCommand = `tar -xf ${download.filePath} -C ${path.join(buildPaths.tmpDir)}`
        try {
          execSync(extractCommand)
          console.log(`✅ Extracted successfully!`)
        } catch (error) {
          console.error(`❌ Extraction failed for ${download.filePath}: ${error}`)
          process.exit(1)
        }
      } else if (target.data === 'win32' && download.filePath.endsWith('.zip')) {
        console.log(`📦 Extracting ${download.filePath}...`)
        try {
          const zip = new AdmZip(download.filePath)
          zip.extractAllTo(buildPaths.resourcesDir, true)
          console.log(`✅ Extracted successfully!`)
        } catch (error) {
          console.error(`❌ Extraction failed for ${download.filePath}: ${error}`)
          process.exit(1)
        }
      }
    }

    // move uv-aarch64-apple-darwin/uv to resourcesDir/uv.exe on darwin
    if (target.data === 'darwin') {
      const uvBinaryPath = path.join(buildPaths.tmpDir, 'uv-aarch64-apple-darwin', 'uv')
      const destinationPath = path.join(buildPaths.resourcesDir, 'uv.exe')
      if (existsSync(uvBinaryPath)) {
        renameSync(uvBinaryPath, destinationPath)
        console.log(`✅ Moved ${uvBinaryPath} to ${destinationPath}`)
      } else {
        console.error(`❌ UV binary not found: ${uvBinaryPath}`)
      }
    }

    // move 7zz to resourcesDir/7zr.exe on darwin
    if (target.data === 'darwin') {
      const sevenZrPath = path.join(buildPaths.tmpDir, '7zz')
      const destinationPath = path.join(buildPaths.resourcesDir, '7zr.exe')
      if (existsSync(sevenZrPath)) {
        renameSync(sevenZrPath, destinationPath)
        console.log(`✅ Moved ${sevenZrPath} to ${destinationPath}`)
      } else {
        console.error(`❌ 7zr binary not found: ${sevenZrPath}`)
      }
    }

    // move 7zr.exe to resourcesDir/7zr.exe on win32
    if (target.data === 'win32') {
      const sevenZrPath = path.join(buildPaths.tmpDir, '7zr.exe')
      const destinationPath = path.join(buildPaths.resourcesDir, '7zr.exe')
      const devModePath = path.join(buildPaths.repoRoot, '7zr.exe')
      if (existsSync(sevenZrPath)) {
        renameSync(sevenZrPath, destinationPath)
        console.log(`✅ Moved ${sevenZrPath} to ${destinationPath}`)

        // Also copy to repo root for development mode
        try {
          const { copyFileSync } = await import('fs')
          copyFileSync(destinationPath, devModePath)
          console.log(`✅ Copied 7zr.exe to ${devModePath} for development mode`)
        } catch (error) {
          console.warn(`⚠️  Warning: Could not copy 7zr.exe to repo root: ${error}`)
        }
      } else {
        console.error(`❌ 7zr binary not found: ${sevenZrPath}`)
      }
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
