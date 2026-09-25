import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { app, net } from 'electron'
import { appLoggerInstance } from '../logging/logger.ts'

// signal-cli (https://github.com/AsamK/signal-cli) is GPL-3.0. We download it
// and run it as a separate, out-of-process program over a local socket — no
// linking and no shared code — so it stays a mere-aggregation dependency (see
// notices-disclaimers.md). This module owns locating / fetching that binary;
// the Python SignalChannel supervises the daemon and speaks JSON-RPC to it.

const execFileAsync = promisify(execFile)

/** Pinned signal-cli release. Signal expires clients after ~3 months, so bump
 *  this periodically. */
export const SIGNAL_CLI_VERSION = '0.14.8'

const releaseAssetUrl = (asset: string): string =>
  `https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/${asset}`

/** Per-account signal-cli state (keys, attachments). Passed to the backend so
 *  the daemon and this process agree on where the linked account lives. */
export function signalCliDataDir(): string {
  return path.join(app.getPath('userData'), 'signal-cli-data')
}

function installRoot(): string {
  return path.join(app.getPath('userData'), 'signal-cli', SIGNAL_CLI_VERSION)
}

/** Asset name + in-archive binary path for the current platform. Linux/macOS
 *  use the GraalVM native build (no JRE needed); Windows falls back to the JVM
 *  distribution, whose launcher requires a Java 21+ runtime on PATH. */
function platformAsset(): { asset: string; binaryRelPath: string; native: boolean } {
  const v = SIGNAL_CLI_VERSION
  if (process.platform === 'linux') {
    return {
      asset: `signal-cli-${v}-Linux-native.tar.gz`,
      binaryRelPath: 'signal-cli',
      native: true,
    }
  }
  if (process.platform === 'darwin') {
    return {
      asset: `signal-cli-${v}-macOS-native.tar.gz`,
      binaryRelPath: 'signal-cli',
      native: true,
    }
  }
  return {
    asset: `signal-cli-${v}.tar.gz`,
    binaryRelPath: path.join(`signal-cli-${v}`, 'bin', 'signal-cli.bat'),
    native: false,
  }
}

/** Resolved path to the signal-cli launcher. An AIPG_SIGNAL_CLI_PATH override
 *  (e.g. a system install in dev) wins; otherwise the managed install location.
 *  The file may not exist yet — call `ensureSignalCli()` first. */
export function signalCliBinaryPath(): string {
  const override = process.env.AIPG_SIGNAL_CLI_PATH
  if (override) return override
  return path.join(installRoot(), platformAsset().binaryRelPath)
}

export function isSignalCliInstalled(): boolean {
  try {
    return fs.existsSync(signalCliBinaryPath())
  } catch {
    return false
  }
}

async function extractTarGz(archive: string, dest: string): Promise<void> {
  // `tar` ships with Windows 10+ (bsdtar) and every unix, and unlike
  // Expand-Archive it handles .tar.gz — signal-cli publishes no .zip.
  await execFileAsync('tar', ['-xf', archive, '-C', dest])
}

/** Download + extract signal-cli if it is not already present. Idempotent and
 *  safe to call on every Signal setup. Returns the resolved binary path. */
export async function ensureSignalCli(
  onLog?: (line: string) => void,
): Promise<{ success: boolean; path?: string; error?: string }> {
  const log = (message: string) => {
    onLog?.(message)
    appLoggerInstance.info(message, 'signal-cli')
  }
  if (process.env.AIPG_SIGNAL_CLI_PATH) {
    return { success: true, path: process.env.AIPG_SIGNAL_CLI_PATH }
  }
  if (isSignalCliInstalled()) return { success: true, path: signalCliBinaryPath() }

  const { asset, native } = platformAsset()
  const root = installRoot()
  const archivePath = path.join(root, asset)
  try {
    fs.mkdirSync(root, { recursive: true })
    log(`Downloading ${asset}…`)
    const res = await net.fetch(releaseAssetUrl(asset))
    if (!res.ok) {
      return { success: false, error: `signal-cli download failed: HTTP ${res.status}` }
    }
    fs.writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()))
    log('Extracting signal-cli…')
    await extractTarGz(archivePath, root)
    fs.rmSync(archivePath, { force: true })

    const binaryPath = signalCliBinaryPath()
    if (!fs.existsSync(binaryPath)) {
      return {
        success: false,
        error: `signal-cli binary missing after extraction (${binaryPath})`,
      }
    }
    if (native && process.platform !== 'win32') {
      try {
        fs.chmodSync(binaryPath, 0o755)
      } catch (e) {
        appLoggerInstance.warn(`Could not chmod signal-cli: ${e}`, 'signal-cli')
      }
    }
    log('signal-cli ready.')
    return { success: true, path: binaryPath }
  } catch (e) {
    return { success: false, error: String(e) }
  } finally {
    try {
      fs.rmSync(archivePath, { force: true })
    } catch {
      // best-effort cleanup
    }
  }
}
