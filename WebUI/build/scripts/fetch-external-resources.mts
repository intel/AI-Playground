#!/usr/bin/env node
/**
 * Fetch Python package resources for AI Playground build
 * Downloads required resources to fixed ./build/resources/ directory
 * Uses built-in fetch API and fixed directory structure
 */

import {
  existsSync,
  mkdirSync,
  createWriteStream,
  renameSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'fs'
import { pipeline } from 'stream/promises'
import { getBuildPaths } from './build-paths.mts'
import path, { normalize } from 'path'
import z from 'zod'
import { execSync } from 'child_process'
import AdmZip from 'adm-zip'

const target = z
  .enum(['win32', 'darwin', 'linux'])
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
 * Records, per resource key, the exact pinned URL that was last successfully
 * downloaded. The version lives in the URL (e.g. `.../26.01/7zr.exe`), so
 * comparing the recorded URL against the currently pinned one tells us whether
 * a cached resource is stale. Stored alongside the resources; the whole
 * directory is gitignored, so this is purely local build state.
 */
type ResourceManifest = Record<string, string>

const MANIFEST_PATH = path.join(buildPaths.resourcesDir, '.resource-versions.json')

function readManifest(): ResourceManifest {
  try {
    if (existsSync(MANIFEST_PATH)) {
      return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as ResourceManifest
    }
  } catch (error) {
    console.warn(
      `⚠️  Could not read resource manifest (${MANIFEST_PATH}); treating all resources as outdated: ${error}`,
    )
  }
  return {}
}

function writeManifest(manifest: ResourceManifest): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
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
 * Download a resource unless a cached copy at the pinned version already exists.
 *
 * The cached archive's basename is constant across versions (e.g.
 * `7z2601-linux-x64.tar.xz`, `uv-...tar.gz`), so an existence check alone would
 * happily reuse an archive from a previous, now-outdated pin. We therefore also
 * require the manifest to record the same URL; on a version bump we drop the
 * stale cache and re-fetch the exact pinned version.
 */
async function downloadFileIfNeeded(
  key: string,
  url: string,
  manifest: ResourceManifest,
): Promise<DownloadResult> {
  const fileName = getBaseFileName(url)
  const expectedFilePath = path.join(buildPaths.tmpDir, fileName)
  const upToDate = manifest[key] === url

  if (upToDate && existsSync(expectedFilePath)) {
    console.log(`⏭️  Skipping ${key} - cached copy already at pinned version (${url})`)
    return { url, filePath: expectedFilePath, success: true }
  }

  if (!upToDate && existsSync(expectedFilePath)) {
    console.log(
      `♻️  ${key}: pinned version changed (${manifest[key] ?? 'none'} → ${url}); re-downloading`,
    )
    rmSync(expectedFilePath)
  }

  return await downloadFile(url, expectedFilePath)
}

/**
 * Check whether a command is available on PATH (Linux/macOS).
 */
function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Detect the system package manager and return the command to install the
 * C/C++ build toolchain + Python dev headers + cmake needed to build
 * source-only Python wheels on Linux (e.g. insightface's mesh_core_cython).
 */
function getLinuxToolchainInstallCommand(): string | undefined {
  const managers: { probe: string; packages: string; install: (pkgs: string) => string }[] = [
    {
      probe: 'apt-get',
      packages: 'build-essential python3-dev cmake',
      // `|| true` so a failing `update` (e.g. clock skew making Release files
      // "not valid yet", or transient mirror errors) does not short-circuit
      // the install, which can still succeed from cached package lists.
      // `Acquire::Check-Date=false` tolerates a wrong system clock.
      install: (pkgs) =>
        `apt-get update -o Acquire::Check-Date=false || true; apt-get install -y ${pkgs}`,
    },
    {
      probe: 'dnf',
      packages: 'gcc-c++ gcc make python3-devel cmake',
      install: (pkgs) => `dnf install -y ${pkgs}`,
    },
    {
      probe: 'pacman',
      packages: 'base-devel cmake',
      install: (pkgs) => `pacman -S --needed --noconfirm ${pkgs}`,
    },
    {
      probe: 'zypper',
      packages: 'gcc-c++ gcc make python3-devel cmake',
      install: (pkgs) => `zypper install -y ${pkgs}`,
    },
  ]

  for (const manager of managers) {
    if (commandExists(manager.probe)) {
      return manager.install(manager.packages)
    }
  }
  return undefined
}

/**
 * Ensure a C/C++ build toolchain is available on Linux so that source-only
 * Python wheels (notably insightface==0.7.3, which has no Linux wheel and
 * compiles a Cython C++ extension) build successfully during backend setup.
 *
 * Best effort: auto-installs via the detected package manager when possible,
 * otherwise prints actionable manual instructions. Never fails the fetch.
 */
function ensureLinuxBuildToolchain(): void {
  if (target.data !== 'linux') return

  // Require the GNU compilers specifically (gcc/g++), not just the generic
  // cc/c++ aliases: source-only wheels like insightface invoke the GNU
  // compiler recorded in CPython's sysconfig (e.g. `x86_64-linux-gnu-g++`),
  // which a clang-only or partial toolchain does NOT provide.
  const requiredCommands = ['gcc', 'g++', 'make', 'cmake']
  const missing = requiredCommands.filter((cmd) => !commandExists(cmd))

  if (missing.length === 0) {
    console.log('✅ Linux build toolchain present (gcc, g++, make, cmake)')
    return
  }

  console.log(
    `🔧 Linux build toolchain incomplete (missing: ${missing.join(', ')}). ` +
      'Required to build source-only wheels such as insightface.',
  )

  const installCommand = getLinuxToolchainInstallCommand()
  if (!installCommand) {
    console.warn(
      '⚠️  Could not detect a supported package manager (apt-get/dnf/pacman/zypper).\n' +
        '    Please install a C/C++ compiler, Python dev headers and cmake manually,\n' +
        '    e.g. on Debian/Ubuntu: sudo apt install -y build-essential python3-dev cmake',
    )
    return
  }

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  // When not root, run through interactive `sudo` so the user can enter their
  // password. stdio is inherited so the prompt is visible and answerable.
  const finalCommand = isRoot ? installCommand : `sudo sh -c ${JSON.stringify(installCommand)}`

  if (!isRoot && !commandExists('sudo')) {
    console.warn(
      '⚠️  Build toolchain is missing and `sudo` is not available to install it.\n' +
        '    Run this once as root, then re-run the backend install:\n' +
        `      sh -c ${JSON.stringify(installCommand)}`,
    )
    return
  }

  console.log(`📦 Installing Linux build toolchain (you may be prompted for your sudo password):`)
  console.log(`    ${installCommand}`)
  try {
    execSync(finalCommand, { stdio: 'inherit' })
    console.log('✅ Linux build toolchain installed.')
  } catch {
    console.warn(
      '⚠️  Toolchain install failed or was cancelled.\n' +
        '    Run this once manually, then re-run the backend install:\n' +
        `      sudo sh -c ${JSON.stringify(installCommand)}`,
    )
  }
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

    // On Linux, ensure a C/C++ build toolchain is present so source-only
    // wheels (e.g. insightface) compile during backend setup.
    ensureLinuxBuildToolchain()

    // Resources to fetch, each with a stable key used to track its installed
    // version in the manifest.
    const resourceList = [
      { key: 'uv', url: buildPaths.resourceUrls.uv },
      { key: 'sevenZip', url: buildPaths.resourceUrls.sevenZipExe },
      ...(buildPaths.resourceUrls.xpuSmiWinZip
        ? [{ key: 'xpuSmi', url: buildPaths.resourceUrls.xpuSmiWinZip }]
        : []),
    ]

    // Download all required files, re-fetching any whose pinned version changed.
    const manifest = readManifest()
    const downloads = await Promise.all(
      resourceList.map((resource) => downloadFileIfNeeded(resource.key, resource.url, manifest)),
    )

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

    // extract downloads if packed - handle tar.gz, tar.xz on darwin/linux, zip on win32
    for (const download of downloads) {
      if (
        (target.data === 'darwin' || target.data === 'linux') &&
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

    // move uv binary to resourcesDir/uv.exe (all platforms use uv.exe name for consistency)
    const uvSourcePaths: Record<string, string> = {
      darwin: path.join(buildPaths.tmpDir, 'uv-aarch64-apple-darwin', 'uv'),
      linux: path.join(buildPaths.tmpDir, 'uv-x86_64-unknown-linux-gnu', 'uv'),
    }
    if (target.data in uvSourcePaths) {
      const uvBinaryPath = uvSourcePaths[target.data]
      const destinationPath = path.join(buildPaths.resourcesDir, 'uv.exe')
      if (existsSync(uvBinaryPath)) {
        renameSync(uvBinaryPath, destinationPath)
        console.log(`✅ Moved ${uvBinaryPath} to ${destinationPath}`)
      } else {
        console.error(`❌ UV binary not found: ${uvBinaryPath}`)
      }
    }

    // move 7zip binary to resourcesDir/7zr.exe (all platforms use 7zr.exe name for consistency)
    const sevenZipSourcePaths: Record<string, string> = {
      darwin: path.join(buildPaths.tmpDir, '7zz'),
      linux: path.join(buildPaths.tmpDir, '7zz'),
      win32: path.join(buildPaths.tmpDir, '7zr.exe'),
    }
    {
      const sevenZrPath = sevenZipSourcePaths[target.data]
      const destinationPath = path.join(buildPaths.resourcesDir, '7zr.exe')
      if (existsSync(sevenZrPath)) {
        renameSync(sevenZrPath, destinationPath)
        console.log(`✅ Moved ${sevenZrPath} to ${destinationPath}`)
      } else {
        console.error(`❌ 7zr binary not found: ${sevenZrPath}`)
      }
    }

    // xpu-smi: Win32-only zip contains xpu-smi.exe + xpum.dll; keep file names as-is.
    if (target.data === 'win32') {
      const xpuSmiExe = path.join(buildPaths.resourcesDir, 'xpu-smi.exe')
      const xpumDll = path.join(buildPaths.resourcesDir, 'xpum.dll')
      if (existsSync(xpuSmiExe) && existsSync(xpumDll)) {
        console.log(`✅ Found xpu-smi resources: ${xpuSmiExe}, ${xpumDll}`)
      } else {
        console.log('ℹ️  xpu-smi assets not found after extraction (skipping)')
      }
    }

    // Record the pinned version of every resource only after a fully successful
    // fetch+extract, so a failed run never marks a resource as up-to-date.
    for (const resource of resourceList) {
      manifest[resource.key] = resource.url
    }
    writeManifest(manifest)
    console.log(`📝 Recorded resource versions in ${MANIFEST_PATH}`)

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
