import { ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import fs from 'fs'
import * as filesystem from 'fs-extra'
import { spawnProcessAsync } from './osProcessHelper.ts'
import {
  LongLivedPythonApiService,
  GitService,
  installHijacks,
  patchFile,
  createEnhancedErrorDetails,
} from './service.ts'
import {
  aipgBaseDir,
  checkBackend,
  checkBackendWithDetails,
  ensureBackendVenv,
  installBackendWithExtra,
  installExtraWheels,
  pipInstallRequirementsFromFile,
} from './uvBasedBackends/uv.ts'
import {
  COMFYUI_DEPS_MARKER_FILENAME,
  normalizeComfyUiRef,
  useLockedComfyUiDeps,
  type ComfyUiDepsMarker,
} from './comfyUiRevision.ts'
import { ProcessError } from './osProcessHelper.ts'
import { getMediaDir } from '../util.ts'
import {
  clearLevelZeroRuntimeCache,
  cudaVisibleDevicesEnv,
  levelZeroDeviceSelectorEnv,
  linuxHasIntelGpuPciDevice,
  linuxHasLevelZeroRuntime,
} from './deviceDetection.ts'
import {
  getMissingPackages,
  hasAptGet,
  hasPkexec,
  parseAptMissingPackages,
  resolvePackageList,
  runPkexecInstall,
  waitForTerminalInstall,
} from './linuxPackageInstaller.ts'
import { BrowserWindow, app, dialog } from 'electron'
import { LocalSettings } from '../main.ts'
import { downloadCustomNode, configureComfyUiManagerSecurityLevel } from './comfyuiTools.ts'
import { getBundledComfyUiGitRefSync } from '../remoteUpdates.ts'
type Device = Omit<InferenceDevice, 'selected'>

export type ComfyUiVariant = 'xpu' | 'cuda' | 'cpu'

export const COMFYUI_DEFAULT_PARAMETERS = '--lowvram --reserve-vram 6.0'

const UPSTREAM_PYPROJECT_BACKUP = 'pyproject.toml.aipg-upstream'

// ---------------------------------------------------------------------------
// Linux Intel-GPU runtime detection (XPU variant)
// ---------------------------------------------------------------------------
// Delegates to the shared, distro-robust + logged Level Zero detector so the
// XPU vs CPU decision is consistent across backends and visible in the logs.
function linuxHasIntelGpuRuntime(): boolean {
  return linuxHasLevelZeroRuntime()
}

// Library-path entries prepended to LD_LIBRARY_PATH when the XPU variant is
// active on Linux. Only existing directories are returned.
function getLinuxOneApiLibPaths(): string[] {
  const candidates = [
    // Note: compiler/latest/lib is intentionally excluded — its libintelocl.so
    // overrides the system ze_loader and breaks XPU device detection.
    // libsycl is already bundled inside the ComfyUI venv.
    '/opt/intel/oneapi/mkl/latest/lib',
    '/opt/intel/oneapi/mkl/latest/lib/intel64',
    '/opt/intel/oneapi/tbb/latest/lib',
    '/opt/intel/oneapi/tbb/latest/lib/intel64/gcc4.8',
    '/usr/lib/x86_64-linux-gnu',
  ]
  return candidates.filter((p) => fs.existsSync(p))
}

// ---------------------------------------------------------------------------
// Linux Intel GPU system dependency installation (Level Zero / XPU)
// ---------------------------------------------------------------------------
// These packages are not in the standard Ubuntu archive; they come from
// Intel's GPU repository (https://repositories.intel.com/gpu/ubuntu).
// Package names differ between Ubuntu 22.04 (Jammy) and 24.04 (Noble).
const LINUX_INTEL_GPU_ALT_PACKAGES: string[][] = [
  // Level Zero ICD loader
  ['libze1', 'level-zero'],
  // Level Zero Intel GPU driver — the part that lets Level Zero enumerate the GPU.
  // This is distinct from the loader: without it, libze_loader.so is present but
  // torch.xpu.device_count() returns 0.
  ['libze-intel-gpu1', 'intel-level-zero-gpu'],
]
// Always try to install alongside the Level Zero packages.
const LINUX_INTEL_GPU_UNCONDITIONAL_PACKAGES: string[] = ['intel-opencl-icd']

// Bash script run (as root via pkexec) before the apt-get install step.
// Adds Intel's GPU repository if neither the Noble nor Jammy package names
// are already available in apt. Safe to re-run (idempotent).
const INTEL_GPU_APT_REPO_SCRIPT = `
# Add Intel GPU repository if Level Zero packages are not yet in apt
if ! apt-cache show libze1 >/dev/null 2>&1 && ! apt-cache show level-zero >/dev/null 2>&1; then
  apt-get install -y --no-install-recommends ca-certificates gpg wget
  wget -qO /tmp/intel-graphics.key https://repositories.intel.com/gpu/intel-graphics.key
  gpg --dearmor -o /usr/share/keyrings/intel-graphics.gpg /tmp/intel-graphics.key
  rm -f /tmp/intel-graphics.key
  . /etc/os-release
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/intel-graphics.gpg] https://repositories.intel.com/gpu/ubuntu \${VERSION_CODENAME} unified" > /etc/apt/sources.list.d/intel-gpu.list
  apt-get update
fi`.trim()

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Returns the renderer Origin used for ComfyUI's --enable-cors-header. In
 * dev the renderer runs on the Vite dev server origin; packaged builds load
 * the renderer from `file://`, which the browser sends as `Origin: null`.
 */
function getRendererOrigin(): string {
  if (!app.isPackaged) {
    const devUrl = process.env['VITE_DEV_SERVER_URL']
    if (devUrl) {
      try {
        const u = new URL(devUrl)
        return `${u.protocol}//${u.host}`
      } catch {
        /* fall through */
      }
    }
  }
  return 'null'
}

/**
 * Sanitize the user-supplied ComfyUI parameter string from settings so that
 * malicious or accidental values cannot expand the attack surface:
 *
 * - drop any `--listen <addr>` / `--listen=<addr>` whose address is not a
 *   loopback host (`127.0.0.1`, `localhost`, `::1`),
 * - drop any `--enable-cors-header [origin]` user override (we always
 *   re-append our locked-down origin after user params),
 * - drop any flag value of `0.0.0.0`.
 */
export function sanitizeUserComfyUiParameters(raw: string, warn?: (msg: string) => void): string[] {
  const tokens = raw.split(/\s+/).filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    // --listen=<value> form
    if (t.startsWith('--listen=')) {
      const value = t.slice('--listen='.length)
      if (!LOOPBACK_HOSTS.has(value)) {
        warn?.(`Refusing user-supplied --listen=${value}; only loopback addresses are allowed`)
        continue
      }
      out.push(t)
      continue
    }
    if (t === '--listen') {
      const value = tokens[i + 1]
      if (value === undefined || value.startsWith('--')) {
        // bare --listen with no arg defaults to 0.0.0.0 in ComfyUI -> reject
        warn?.('Refusing bare --listen; only loopback addresses are allowed')
        continue
      }
      if (!LOOPBACK_HOSTS.has(value)) {
        warn?.(`Refusing user-supplied --listen ${value}; only loopback addresses are allowed`)
        i++ // skip the value too
        continue
      }
      out.push(t, value)
      i++
      continue
    }
    // --enable-cors-header=<value> form
    if (t.startsWith('--enable-cors-header=')) {
      warn?.(`Dropping user-supplied ${t}; CORS origin is forced by AI Playground`)
      continue
    }
    if (t === '--enable-cors-header') {
      // Skip the optional origin arg if present (heuristic: next token doesn't start with --).
      const next = tokens[i + 1]
      warn?.('Dropping user-supplied --enable-cors-header; CORS origin is forced by AI Playground')
      if (next !== undefined && !next.startsWith('--')) {
        i++
      }
      continue
    }
    out.push(t)
  }
  return out
}

export class ComfyUiBackendService extends LongLivedPythonApiService {
  constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
    super(name, port, win, settings)

    this.serviceIsSetUp().then(async (setUp) => {
      this.isSetUp = setUp
      if (this.isSetUp) {
        await this.updateCachedVersion()
        this.setStatus('notYetStarted')
      }
      this.appLogger.info(`Service ${this.name} isSetUp: ${this.isSetUp}`, this.name)
    })
  }
  readonly isRequired = false
  readonly serviceFolder = 'ComfyUI'
  readonly baseDir = path.resolve(aipgBaseDir)
  readonly serviceDir = path.resolve(path.join(this.baseDir, this.serviceFolder))
  readonly pythonEnvDir = path.resolve(path.join(this.serviceDir, '.venv'))
  devices: InferenceDevice[] = [{ id: '*', name: 'Auto select device', selected: true }]
  readonly git = new GitService()
  healthEndpointUrl = `${this.baseUrl}/queue`

  private readonly remoteUrl = 'https://github.com/comfyanonymous/ComfyUI.git'
  private revision = getBundledComfyUiGitRefSync()
  private environmentMismatchError: ErrorDetails | null = null

  private comfyUiParametersString: string = COMFYUI_DEFAULT_PARAMETERS
  private comfyUiVariant: ComfyUiVariant = 'xpu'
  private variantMismatchToastSent = false

  // Tri-state record of whether a torch.xpu device probe has positively
  // confirmed at least one usable Intel GPU. `null` = not probed yet (or last
  // probe never ran), `true` = >=1 usable XPU device, `false` = 0 devices.
  // spawnAPIProcess() requires `true` before launching as the XPU variant, so a
  // transient/stale `comfyUiVariant === 'xpu'` can never start a doomed XPU
  // process on a machine whose GPU is not actually usable (e.g. Resizable BAR
  // disabled -> device_count() == 0).
  private usableXpuConfirmed: boolean | null = null

  // Per-launch loopback auth token, regenerated on every spawn. Consumed by
  // the bundled `aipg-auth` ComfyUI custom_node middleware which rejects any
  // request without a matching Bearer header / ?token= query / session cookie.
  private loopbackAuthToken: string = randomBytes(32).toString('hex')

  getLoopbackAuthToken(): string {
    return this.loopbackAuthToken
  }

  private readonly variantMarkerPath = path.join(this.serviceDir, 'aipg-variant.json')

  private readInstalledVariant(): ComfyUiVariant | null {
    try {
      if (!filesystem.existsSync(this.variantMarkerPath)) return null
      const raw = filesystem.readFileSync(this.variantMarkerPath, 'utf-8')
      const parsed = JSON.parse(raw) as { variant?: string }
      const v = parsed.variant
      if (v === 'xpu' || v === 'cuda' || v === 'cpu') return v
      return null
    } catch {
      return null
    }
  }

  private writeVariantMarker(variant: ComfyUiVariant): void {
    filesystem.writeFileSync(this.variantMarkerPath, JSON.stringify({ variant }), 'utf-8')
  }

  private getDesiredVariant(): ComfyUiVariant {
    if (this.settings.productMode === 'nvidia') return 'cuda'
    if (process.platform === 'win32') return 'xpu'
    if (process.platform === 'linux' && linuxHasIntelGpuRuntime()) return 'xpu'
    return 'cpu'
  }

  private getEffectiveVariant(): ComfyUiVariant {
    if (this.settings.productMode) return this.getDesiredVariant()
    const restored = this.readInstalledVariant()
    if (restored) return restored
    return this.getDesiredVariant()
  }

  /**
   * On Linux: if an Intel GPU PCI device is present, ensure the Level Zero
   * loader and GPU driver packages are installed. Without the GPU driver
   * (libze-intel-gpu1 / intel-level-zero-gpu), torch.xpu.device_count()
   * returns 0 even when the PCI device is visible, causing ComfyUI to crash.
   *
   * Uses the same pkexec / terminal-emulator pattern as OpenVINO's dependency
   * installer. Clears the cached Level Zero detection result after a successful
   * install so the next call to linuxHasLevelZeroRuntime() picks up the new state.
   */
  private async ensureLinuxIntelGpuDependencies(
    onProgress?: (message: string) => Promise<void> | void,
  ): Promise<void> {
    if (process.platform !== 'linux') return
    if (!linuxHasIntelGpuPciDevice()) return

    const hasApt = await hasAptGet()
    if (!hasApt) {
      this.appLogger.warn(
        'apt-get not found; skipping automatic Intel GPU (Level Zero) dependency install',
        this.name,
      )
      return
    }

    const packageList = await resolvePackageList(
      LINUX_INTEL_GPU_ALT_PACKAGES,
      LINUX_INTEL_GPU_UNCONDITIONAL_PACKAGES,
    )
    const missingPackages = await getMissingPackages(packageList)

    if (missingPackages.length === 0) {
      this.appLogger.info('Intel GPU (Level Zero) Linux packages are already installed', this.name)
      return
    }

    this.appLogger.info(
      `Intel GPU packages missing: ${missingPackages.join(', ')}`,
      this.name,
      true,
    )

    const packageListText = missingPackages.map((p) => `- ${p}`).join('\n')
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'warning',
      buttons: ['Install now', 'Cancel setup'],
      defaultId: 0,
      cancelId: 1,
      title: 'Install Intel GPU drivers',
      message: 'ComfyUI requires Intel GPU (Level Zero) packages before it can use the XPU.',
      detail:
        `Missing packages:\n${packageListText}\n\n` +
        'AI Playground will request administrator permission and install these packages automatically. ' +
        'The Intel GPU repository will be added if it is not already configured.',
    })

    if (response === 1) {
      this.appLogger.info(
        'User cancelled Intel GPU dependency install; ComfyUI will run on CPU',
        this.name,
        true,
      )
      return
    }

    await onProgress?.('Installing Intel GPU (Level Zero) packages')

    const pkexecAvailable = await hasPkexec()
    let installSuccess = false

    if (pkexecAvailable) {
      const result = await runPkexecInstall(missingPackages, INTEL_GPU_APT_REPO_SCRIPT)
      installSuccess = result.success
      if (!result.success) {
        const aptMissing = parseAptMissingPackages(result.output)
        if (aptMissing.length > 0) {
          this.appLogger.error(
            `Intel GPU install failed. Packages not found in apt: ${aptMissing.join(', ')}. ` +
              'Check that the Intel GPU repository is reachable.',
            this.name,
            true,
          )
        } else {
          this.appLogger.error(`Intel GPU install failed: ${result.output}`, this.name, true)
        }
      }
    } else {
      await onProgress?.('pkexec unavailable, falling back to terminal installer')
      installSuccess = await waitForTerminalInstall(missingPackages, INTEL_GPU_APT_REPO_SCRIPT)
      if (installSuccess) {
        // Give apt a moment to register the newly installed packages
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
    }

    if (installSuccess) {
      // Invalidate the cached Level Zero detection so getDesiredVariant() picks
      // up the newly installed GPU driver on the next call.
      clearLevelZeroRuntimeCache()
      this.appLogger.info(
        'Intel GPU packages installed successfully; Level Zero cache cleared',
        this.name,
        true,
      )
    }
  }

  async serviceIsSetUp(): Promise<boolean> {
    this.appLogger.info(`Checking if comfyUI directories exist`, this.name)
    const dirsExist = filesystem.existsSync(this.serviceDir)
    this.appLogger.info(`Checking if comfyUI directories exist: ${dirsExist}`, this.name)
    if (!dirsExist) return false

    const installedVersion = await this.getCurrentVersion()
    if (installedVersion) {
      this.appLogger.info(`comfyUI version ${installedVersion} detected`, this.name)
      this.revision = installedVersion
    }

    const installedVariant = this.readInstalledVariant()
    const desiredVariant = this.getDesiredVariant()
    if (installedVariant && installedVariant !== desiredVariant) {
      this.appLogger.info(
        `ComfyUI variant mismatch: installed '${installedVariant}' but '${desiredVariant}' is required for current mode. Reinstallation needed.`,
        this.name,
      )
      if (!this.variantMismatchToastSent) {
        this.variantMismatchToastSent = true
        this.win.webContents.send('show-toast', {
          type: 'warning',
          message: `ComfyUI needs reinstallation to switch from ${installedVariant.toUpperCase()} to ${desiredVariant.toUpperCase()} backend.`,
        })
      }
      return false
    }

    try {
      const marker = await this.readDepsMarker()
      const normRev = normalizeComfyUiRef(this.revision)
      const markerMatches = marker?.revision === normRev

      if (marker?.mode === 'flexible') {
        if (!markerMatches) {
          this.appLogger.info(
            `ComfyUI deps marker revision ${marker.revision} != target ${normRev}, needs reinstall`,
            this.name,
          )
          return false
        }
      }

      const skipLockfileCheck = marker?.mode === 'flexible' && markerMatches

      const checkDetails = await checkBackendWithDetails(
        this.serviceFolder,
        this.pythonEnvDir,
        skipLockfileCheck ? { skipLockfileCheck: true } : undefined,
      )

      // If venv doesn't exist, service is not set up
      if (!checkDetails.venvExists) {
        this.appLogger.info(
          `Service ${this.name} venv does not exist, needs installation`,
          this.name,
        )
        return false
      }

      // If venv exists but environment mismatch detected, set error details and still allow startup
      if (checkDetails.envMismatch) {
        this.appLogger.warn(
          `Service ${this.name} venv exists but environment doesn't match expected state. Will attempt startup but recommend reinstallation.`,
          this.name,
        )

        // Set error details recommending reinstallation
        // Include stderr from uv check which contains helpful information about what packages would be changed
        const stderrInfo = checkDetails.stderr
          ? `\n\n=== UV Check Output ===\n${checkDetails.stderr}`
          : ''
        const stdoutInfo = checkDetails.stdout
          ? `\n\n=== UV Check Details ===\n${checkDetails.stdout}`
          : ''

        this.environmentMismatchError = {
          command: 'ComfyUI environment check',
          exitCode: checkDetails.exitCode,
          stdout:
            `Virtual environment detected at: ${this.pythonEnvDir}\n` +
            `Environment check failed (exit code: ${checkDetails.exitCode})\n` +
            `Sync action: ${checkDetails.action}\n\n` +
            `The Python environment exists but doesn't match the expected configuration.\n` +
            `This may cause ComfyUI to fail during startup.\n\n` +
            `Recommendation: Reinstall ComfyUI to ensure the environment matches the expected state.${stdoutInfo}`,
          stderr: `Environment mismatch detected. The virtual environment at ${this.pythonEnvDir} exists but doesn't match the expected lockfile state.${stderrInfo}`,
          timestamp: new Date().toISOString(),
          duration: 0,
        }
      } else {
        // Clear environment mismatch error if environment is in sync
        this.environmentMismatchError = null
      }

      // Venv exists, allow startup attempt (even if mismatch detected)
      this.appLogger.info(`Service ${this.name} venv exists, allowing startup attempt`, this.name)
      return true
    } catch (error) {
      // If check fails completely, assume not set up
      this.appLogger.error(`Failed to check ${this.name} environment: ${error}`, this.name)
      return false
    }
  }

  isSetUp = false

  async updateSettings(settings: ServiceSettings): Promise<void> {
    if (settings.version) {
      this.revision = settings.version
      this.appLogger.info(`applied new comfyUI version ${this.revision}`, this.name)
    }
    if (typeof settings.comfyUiParameters === 'string') {
      this.comfyUiParametersString = settings.comfyUiParameters
      this.appLogger.info(
        `applied new comfyUI startup parameters: ${this.comfyUiParametersString}`,
        this.name,
      )
    }
  }

  async getCurrentVersion(): Promise<string | undefined> {
    try {
      try {
        const tag = await this.git.run(
          ['-C', this.serviceDir, 'describe', '--tags', '--exact-match'],
          {},
          this.serviceDir,
        )
        const t = tag.trim()
        if (t) return normalizeComfyUiRef(t)
      } catch {
        /* not exactly on a tag */
      }
      const hash = await this.git.run(
        ['-C', this.serviceDir, 'rev-parse', '--short', 'HEAD'],
        {},
        this.serviceDir,
      )
      return normalizeComfyUiRef(hash.trim())
    } catch (e) {
      this.appLogger.error(`failed to get comfyUI version: ${e}`, this.name)
      return undefined
    }
  }

  async getInstalledVersion(): Promise<{ version?: string; releaseTag?: string } | undefined> {
    if (!this.isSetUp) return undefined
    try {
      const versionFilePath = path.join(this.serviceDir, 'comfyui_version.py')
      if (filesystem.existsSync(versionFilePath)) {
        const versionFileContent = await filesystem.readFile(versionFilePath, 'utf-8')
        const versionMatch = versionFileContent.match(/__version__\s*=\s*["']([^"']+)["']/)
        if (versionMatch && versionMatch[1]) {
          const version = versionMatch[1]
          // Check if it's a version tag (v0.3.76) or git hash
          if (version.startsWith('v')) {
            return { version }
          } else {
            return { version: `v${version}` }
          }
        }
      }
    } catch (e) {
      this.appLogger.error(`failed to get installed ComfyUI version: ${e}`, this.name)
    }
    return undefined
  }

  private async readDepsMarker(): Promise<ComfyUiDepsMarker | null> {
    const markerPath = path.join(this.serviceDir, COMFYUI_DEPS_MARKER_FILENAME)
    try {
      const raw = await fs.promises.readFile(markerPath, 'utf-8')
      const parsed = JSON.parse(raw) as ComfyUiDepsMarker
      if (parsed.mode !== 'locked' && parsed.mode !== 'flexible') return null
      if (typeof parsed.revision !== 'string') return null
      return parsed
    } catch {
      return null
    }
  }

  private async writeDepsMarker(marker: ComfyUiDepsMarker): Promise<void> {
    const markerPath = path.join(this.serviceDir, COMFYUI_DEPS_MARKER_FILENAME)
    await fs.promises.writeFile(markerPath, JSON.stringify(marker, null, 2), 'utf-8')
  }

  private async checkoutMatchesRevision(requested: string): Promise<boolean> {
    try {
      const want = (
        await this.git.run(
          ['-C', this.serviceDir, 'rev-parse', `${requested}^{commit}`],
          {},
          this.serviceDir,
        )
      ).trim()
      const head = (
        await this.git.run(['-C', this.serviceDir, 'rev-parse', 'HEAD'], {}, this.serviceDir)
      ).trim()
      return want.toLowerCase() === head.toLowerCase()
    } catch {
      return false
    }
  }

  private async restoreComfyUiPyprojectAndLockFromHead(): Promise<void> {
    try {
      await this.git.run(
        ['-C', this.serviceDir, 'checkout', 'HEAD', '--', 'pyproject.toml'],
        {},
        this.serviceDir,
      )
    } catch {
      this.appLogger.info('restore pyproject.toml from HEAD skipped (missing or failed)', this.name)
    }
    try {
      await this.git.run(
        ['-C', this.serviceDir, 'checkout', 'HEAD', '--', 'uv.lock'],
        {},
        this.serviceDir,
      )
    } catch {
      this.appLogger.info('restore uv.lock from HEAD skipped (missing or failed)', this.name)
    }
  }

  private async installComfyUiFlexibleDeps(reinstallTorch = false): Promise<void> {
    const flexiblePyprojectSource = path.join(
      aipgBaseDir,
      'comfyui-deps',
      'pyproject-flexible-venv.toml',
    )
    const pyprojectTarget = path.join(this.serviceDir, 'pyproject.toml')
    const backupPath = path.join(this.serviceDir, UPSTREAM_PYPROJECT_BACKUP)
    const requirementsPath = path.join(this.serviceDir, 'requirements.txt')

    if (!(await filesystem.pathExists(requirementsPath))) {
      throw new Error(
        `ComfyUI has no requirements.txt at ${requirementsPath}. This ComfyUI ref may use pyproject-only deps — use the pinned version ${getBundledComfyUiGitRefSync()} (see shipped backend-versions.json) or extend the installer.`,
      )
    }

    await this.restoreComfyUiPyprojectAndLockFromHead()

    const uvLockInTree = path.join(this.serviceDir, 'uv.lock')
    if (await filesystem.pathExists(uvLockInTree)) {
      await filesystem.remove(uvLockInTree)
    }

    if (await filesystem.pathExists(backupPath)) {
      await filesystem.remove(backupPath)
    }

    let hadUpstreamPyproject = false
    if (await filesystem.pathExists(pyprojectTarget)) {
      await filesystem.move(pyprojectTarget, backupPath)
      hadUpstreamPyproject = true
    }

    await filesystem.copyFile(flexiblePyprojectSource, pyprojectTarget)

    try {
      await ensureBackendVenv(this.serviceFolder)
      this.appLogger.info(
        'Installing ComfyUI core deps from requirements.txt (flexible / non-pinned ref)',
        this.name,
      )
      await pipInstallRequirementsFromFile(
        this.serviceFolder,
        requirementsPath,
        () => {
          this.win.webContents.send('show-toast', {
            type: 'warning',
            message:
              'UV cache corruption detected while installing ComfyUI requirements. Retrying without cache — this may take longer.',
          })
        },
        this.getTorchBackendEnv(),
        reinstallTorch ? ['torch', 'torchvision', 'torchaudio'] : undefined,
      )
    } finally {
      try {
        await filesystem.remove(pyprojectTarget)
      } catch {
        /* ignore */
      }
      if (hadUpstreamPyproject) {
        await filesystem.move(backupPath, pyprojectTarget)
      } else {
        await filesystem.copyFile(flexiblePyprojectSource, pyprojectTarget)
      }
    }
  }

  get_info(): ApiServiceInformation {
    const baseInfo = super.get_info()

    // Always show environment mismatch error if it exists, even if there's a startup error
    // This guides users toward a potential fix (reinstallation)
    if (this.environmentMismatchError) {
      if (baseInfo.errorDetails) {
        // Merge environment mismatch with startup error
        const mergedError: ErrorDetails = {
          command: baseInfo.errorDetails.command || this.environmentMismatchError.command,
          exitCode: baseInfo.errorDetails.exitCode ?? this.environmentMismatchError.exitCode,
          stdout: [
            '=== Environment Mismatch Warning ===',
            this.environmentMismatchError.stdout,
            '',
            '=== Startup Error Details ===',
            baseInfo.errorDetails.stdout || 'No stdout output',
          ].join('\n'),
          stderr: [
            '=== Environment Mismatch Warning ===',
            this.environmentMismatchError.stderr,
            '',
            '=== Startup Error Details ===',
            baseInfo.errorDetails.stderr || 'No stderr output',
          ].join('\n'),
          timestamp: baseInfo.errorDetails.timestamp || this.environmentMismatchError.timestamp,
          duration: baseInfo.errorDetails.duration ?? this.environmentMismatchError.duration,
          pipFreezeOutput:
            baseInfo.errorDetails.pipFreezeOutput || this.environmentMismatchError.pipFreezeOutput,
        }
        return {
          ...baseInfo,
          errorDetails: mergedError,
        }
      } else {
        // Only environment mismatch error, no startup error
        return {
          ...baseInfo,
          errorDetails: this.environmentMismatchError,
        }
      }
    }

    return baseInfo
  }

  async *set_up(): AsyncIterable<SetupProgress> {
    this.appLogger.info('setting up service', this.name)
    this.setStatus('installing')

    // Install Level Zero packages before variant detection so that
    // getEffectiveVariant() → linuxHasLevelZeroRuntime() sees them.
    if (process.platform === 'linux') {
      yield {
        serviceName: this.name,
        step: 'linux dependencies',
        status: 'executing',
        debugMessage: 'checking and installing Intel GPU (Level Zero) packages',
      }
      await this.ensureLinuxIntelGpuDependencies((msg) => this.appLogger.info(msg, this.name))
    }

    this.comfyUiVariant = this.getEffectiveVariant()

    const checkServiceDir = async (): Promise<boolean> => {
      if (!filesystem.existsSync(this.serviceDir)) {
        return false
      }

      try {
        const matches = await this.checkoutMatchesRevision(this.revision)
        if (matches) {
          this.appLogger.info('comfyUI already cloned at requested revision, skipping', this.name)
          return true
        }
        this.appLogger.info(
          `ComfyUI checkout does not match requested revision ${this.revision}. Removing...`,
          this.name,
        )
        throw new Error('Version mismatch')
      } catch (_e) {
        try {
          filesystem.removeSync(this.serviceDir)
        } finally {
          return false
        }
      }
    }

    const setupComfyUiBaseService = async (): Promise<void> => {
      installHijacks()
      if (await checkServiceDir()) {
        this.appLogger.info('comfyUI already cloned, skipping', this.name)
      } else {
        await this.git.run(['clone', this.remoteUrl, this.serviceDir])
        await this.git.run(['-C', this.serviceDir, 'checkout', this.revision], {}, this.serviceDir)
      }

      const comfyUIDepsDir = path.join(aipgBaseDir, 'comfyui-deps')
      const pyprojectSource = path.join(comfyUIDepsDir, 'pyproject.toml')
      const pyprojectTarget = path.join(this.serviceDir, 'pyproject.toml')
      const uvLockTarget = path.join(this.serviceDir, 'uv.lock')
      const useLocked = useLockedComfyUiDeps(this.revision, getBundledComfyUiGitRefSync())
      const normRev = normalizeComfyUiRef(this.revision)
      const existingMarker = await this.readDepsMarker()
      const markerMatches = existingMarker?.revision === normRev
      const installedVariant = this.readInstalledVariant()
      const variantChanged = installedVariant !== null && installedVariant !== this.comfyUiVariant

      if (variantChanged) {
        this.appLogger.info(
          `ComfyUI variant changed from '${installedVariant}' to '${this.comfyUiVariant}', forcing dependency reinstall`,
          this.name,
        )
      }

      if (useLocked) {
        let needsInstall = true
        if (existingMarker?.mode === 'locked' && markerMatches && !variantChanged) {
          try {
            await checkBackend(this.serviceFolder)
            needsInstall = false
            this.appLogger.info('ComfyUI locked deps already synced, skipping', this.name)
          } catch {
            needsInstall = true
          }
        }

        if (needsInstall) {
          this.appLogger.info(
            `Copying bundled pyproject.toml and uv.lock for ${getBundledComfyUiGitRefSync()}`,
            this.name,
          )
          await filesystem.copyFile(pyprojectSource, pyprojectTarget)
          // Don't copy the bundled uv.lock anymore. We need to support different PyTorch variants
          // (xpu/cuda/cpu) depending on selected productMode, so we let uv resolve the lock in-tree.
          try {
            if (await filesystem.pathExists(uvLockTarget)) {
              await filesystem.remove(uvLockTarget)
            }
          } catch {
            /* ignore */
          }
          this.appLogger.info(
            `Installing ComfyUI dependencies for variant '${this.comfyUiVariant}' using uv sync --extra (locked)`,
            this.name,
          )
          await installBackendWithExtra(this.serviceFolder, this.comfyUiVariant, () => {
            this.win.webContents.send('show-toast', {
              type: 'warning',
              message:
                'UV cache corruption detected. Retrying installation without cache. This may take longer. You can manually clear the cache at %LOCALAPPDATA%/uv/cache',
            })
          })
        }
        await this.writeDepsMarker({ mode: 'locked', revision: normRev })
      } else {
        let needsInstall = true
        if (
          existingMarker?.mode === 'flexible' &&
          markerMatches &&
          !variantChanged &&
          filesystem.existsSync(this.pythonEnvDir)
        ) {
          needsInstall = false
          this.appLogger.info(
            'ComfyUI flexible deps already installed for this revision, skipping',
            this.name,
          )
        }

        if (needsInstall) {
          this.win.webContents.send('show-toast', {
            type: 'warning',
            message:
              'Installing custom ComfyUI versions may not be compatible with the bundled workflows. If you encounter issues, please clear the version override and reinstall the ComfyUI backend.',
          })
          await this.installComfyUiFlexibleDeps(variantChanged)
        }
        await this.writeDepsMarker({ mode: 'flexible', revision: normRev })
      }
    }

    const configureComfyUI = async (): Promise<void> => {
      try {
        if (this.comfyUiVariant === 'xpu') {
          this.appLogger.info('patching hijacks into comfyUI model_management (xpu)', this.name)
          try {
            await patchFile(
              path.join(this.serviceDir, 'comfy/model_management.py'),
              'from comfy.model_management import get_model',
              ['from ipex_to_cuda import ipex_init', 'ipex_init()'],
            )
          } catch (patchErr) {
            // Newer ComfyUI / torch+xpu versions don't need the ipex_to_cuda
            // bridge (and may not contain the anchor line). Don't fail setup.
            this.appLogger.info(
              `ipex_to_cuda patch skipped (not applicable to this ComfyUI version): ${patchErr}`,
              this.name,
            )
          }
        } else {
          // If a previous install injected ipex_to_cuda, remove it for non-XPU variants.
          const mmPath = path.join(this.serviceDir, 'comfy/model_management.py')
          if (filesystem.existsSync(mmPath)) {
            const cur = await filesystem.readFile(mmPath, 'utf-8')
            const next = cur
              .replace(/^from ipex_to_cuda import ipex_init\r?\n/m, '')
              .replace(/^ipex_init\(\)\r?\n/m, '')
            if (next !== cur) {
              await filesystem.writeFile(mmPath, next, 'utf-8')
              this.appLogger.info(
                `Removed ipex_to_cuda lines from model_management.py for variant '${this.comfyUiVariant}'`,
                this.name,
              )
            }
          }
        }

        this.appLogger.info('Configuring extra model paths for comfyUI', this.name)
        const extraModelPathsYaml = path.join(this.serviceDir, 'extra_model_paths.yaml')
        const comfyUIModelsPath = path.join('..', 'models/ComfyUI')
        const extraModelsYaml = `aipg:
  base_path: ${comfyUIModelsPath}
  checkpoints: checkpoints
  loras: |
    loras
    lora
  vae: vae
  text_encoders: |
    text_encoders
    clip
  clip_vision: clip_vision
  style_models: style_models
  embeddings: embeddings
  diffusers: diffusers
  vae_approx: vae_approx
  controlnet: |
    controlnet
    t2i_adapter
  gligen: gligen
  upscale_models: |
    upscale_models
    latent_upscale_models
  hypernetworks: hypernetworks
  photomaker: photomaker
  classifiers: classifiers
  model_patches: model_patches
  audio_encoders: audio_encoders
  diffusion_models: |
    diffusion_models
    unet
  insightface: insightface
  facerestore_models: facerestore_models
  nsfw_detector: nsfw_detector
  inpaint: inpaint`
        fs.promises.writeFile(extraModelPathsYaml, extraModelsYaml, {
          encoding: 'utf-8',
          flag: 'w',
        })
        this.appLogger.info(
          `Configured extra model paths for comfyUI at ${extraModelPathsYaml} as ${extraModelsYaml} `,
          this.name,
        )
      } catch (configError) {
        this.appLogger.error(
          `Failed to configure extra model paths for comfyUI: ${configError}`,
          this.name,
        )
        // Re-throw ProcessError instances to preserve enhanced error details
        if (configError instanceof ProcessError) {
          throw configError
        }
        // For other errors, wrap with context
        throw new Error(`Failed to configure extra model paths for comfyUI: ${configError}`)
      }
    }

    const installBuiltinCustomNodes = async (): Promise<void> => {
      try {
        const builtinCustomNodesDir = path.join(aipgBaseDir, 'comfyui-deps', 'custom_nodes')

        if (!filesystem.existsSync(builtinCustomNodesDir)) {
          this.appLogger.info(
            `No builtin custom nodes directory found at ${builtinCustomNodesDir}, skipping`,
            this.name,
          )
          return
        }

        this.appLogger.info(
          `Installing builtin custom nodes from ${builtinCustomNodesDir}`,
          this.name,
        )

        const targetCustomNodesDir = path.join(this.serviceDir, 'custom_nodes')

        if (!filesystem.existsSync(targetCustomNodesDir)) {
          this.appLogger.info(
            `Creating custom_nodes directory at ${targetCustomNodesDir}`,
            this.name,
          )
          await filesystem.ensureDir(targetCustomNodesDir)
        }

        const entries = await filesystem.readdir(builtinCustomNodesDir, { withFileTypes: true })

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const sourcePath = path.join(builtinCustomNodesDir, entry.name)
            const targetPath = path.join(targetCustomNodesDir, entry.name)

            this.appLogger.info(
              `Copying builtin custom node ${entry.name} from ${sourcePath} to ${targetPath}`,
              this.name,
            )

            await filesystem.copy(sourcePath, targetPath, { overwrite: true })

            this.appLogger.info(
              `Successfully installed builtin custom node ${entry.name}`,
              this.name,
            )
          }
        }

        this.appLogger.info(`Builtin custom nodes installation complete`, this.name)
      } catch (error) {
        this.appLogger.error(`Failed to install builtin custom nodes: ${error}`, this.name)
        throw new Error(`Failed to install builtin custom nodes: ${error}`)
      }
    }

    let currentStep = 'start'

    try {
      currentStep = 'start'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'starting to set up comfyUI environment',
      }

      await this.git.ensureInstalled()

      currentStep = 'install comfyUI'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `installing comfyUI base repo`,
      }
      await setupComfyUiBaseService()
      if (this.comfyUiVariant === 'xpu') {
        await installExtraWheels(this.serviceFolder)
      } else {
        this.appLogger.info(
          `Skipping bundled extra wheels for variant '${this.comfyUiVariant}'`,
          this.name,
        )
      }

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `installation of comfyUI base repo complete`,
      }

      currentStep = 'configure comfyUI'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `configuring comfyUI base repo`,
      }
      await configureComfyUI()
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `configured comfyUI base repo`,
      }

      currentStep = 'install builtin custom nodes'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'installing builtin custom nodes',
      }
      await installBuiltinCustomNodes()
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'builtin custom nodes installation complete',
      }

      currentStep = 'install comfyUI manager'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'installing ComfyUI Manager custom node',
      }
      try {
        const managerNode = {
          username: 'Comfy-Org',
          repoName: 'ComfyUI-Manager',
        }
        await downloadCustomNode(managerNode, this.serviceDir, {
          extraEnv: this.getTorchBackendEnv(),
          skipExtraWheels: this.comfyUiVariant !== 'xpu',
        })
        // Lock Manager down to security_level=strong so that even an attacker
        // who reaches ComfyUI's loopback port cannot use the Manager API to
        // install arbitrary git-URL custom nodes / pip packages — the same
        // RCE primitive demonstrated in the CWE-494 report against the
        // ai-backend's deleted /api/comfyUi/loadCustomNodes endpoint.
        await configureComfyUiManagerSecurityLevel(this.serviceDir, 'strong')
        yield {
          serviceName: this.name,
          step: currentStep,
          status: 'executing',
          debugMessage: 'ComfyUI Manager installation complete',
        }
      } catch (error) {
        // Log warning but don't fail setup
        this.appLogger.warn(
          `Failed to install ComfyUI Manager: ${error}. Continuing setup.`,
          this.name,
        )
      }

      // Locked ref: uv.lock + pyproject; other refs: requirements.txt + UV torch config
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'dependencies configured',
      }
      this.writeVariantMarker(this.comfyUiVariant)
      this.isSetUp = true
      await this.updateCachedVersion()
      this.setStatus('notYetStarted')
      currentStep = 'end'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'success',
        debugMessage: `service set up completely`,
      }
    } catch (e) {
      this.appLogger.warn(`Set up of service failed due to ${e}`, this.name, true)
      this.appLogger.warn(`Aborting set up of ${this.name} service environment`, this.name, true)
      this.setStatus('installationFailed')

      const errorDetails = await createEnhancedErrorDetails(e, `${currentStep} operation`)
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'failed',
        debugMessage: `Failed to setup comfyUI service due to ${e}`,
        errorDetails,
      }
    }
  }

  private get torchBackendValue(): string {
    if (this.comfyUiVariant === 'cuda') return 'cu128'
    if (this.comfyUiVariant === 'cpu') return 'cpu'
    if (process.platform === 'win32') return 'xpu'
    if (process.platform === 'linux' && linuxHasIntelGpuRuntime()) return 'xpu'
    return 'cpu'
  }

  get comfyUiVariantName(): ComfyUiVariant {
    return this.comfyUiVariant
  }

  getTorchBackendEnv(): Record<string, string> {
    return { UV_TORCH_BACKEND: this.torchBackendValue }
  }

  private getCommonEnvVars(): Record<string, string> {
    const envVars: Record<string, string> = {
      PATH: [
        // Windows: Conda Library/bin + bundled Git cmd directory.
        // Linux/macOS: the venv's bin directory.
        ...(process.platform === 'win32'
          ? [path.join(this.pythonEnvDir, 'Library', 'bin'), path.join(this.git.dir, 'cmd')]
          : [path.join(this.pythonEnvDir, 'bin')]),
        process.env.PATH,
      ].join(path.delimiter),
      PYTHONNOUSERSITE: 'true',
      SYCL_ENABLE_DEFAULT_CONTEXTS: '1',
      SYCL_CACHE_PERSISTENT: '1',
      PYTHONIOENCODING: 'utf-8',
      HF_ENDPOINT: this.settings.huggingfaceEndpoint,
      AIPG_OPENVINO_IMAGE_MODELS: path.join(this.baseDir, 'models', 'openvino-image'),
      PIP_CONFIG_FILE: process.platform === 'win32' ? 'nul' : '/dev/null',
      UV_NO_CONFIG: '1',
      UV_TORCH_BACKEND: this.torchBackendValue,
      // Consumed by the bundled aipg-auth ComfyUI custom_node middleware.
      AIPG_LOOPBACK_TOKEN: this.loopbackAuthToken,
    }

    // On Linux with the XPU variant, expose the Intel oneAPI runtime libraries so
    // IPEX can resolve libsycl.so / libmkl_sycl.so / libze_loader.so at runtime,
    // and use the composite device hierarchy so Level Zero can make large
    // contiguous USM allocations (fixes XPU OOM on shared-memory Intel iGPUs).
    if (process.platform === 'linux' && this.comfyUiVariant === 'xpu') {
      const oneApiLibPaths = getLinuxOneApiLibPaths()
      if (oneApiLibPaths.length > 0) {
        envVars.LD_LIBRARY_PATH = [...oneApiLibPaths, process.env.LD_LIBRARY_PATH ?? '']
          .filter(Boolean)
          .join(path.delimiter)
      }
      envVars.ZE_FLAT_DEVICE_HIERARCHY = 'COMPOSITE'
    }

    return envVars
  }

  private getDeviceSelectorEnv(): Record<string, string> {
    const selectedId = this.devices.find((d) => d.selected)?.id
    if (this.comfyUiVariant === 'cuda') {
      return cudaVisibleDevicesEnv(selectedId)
    }
    if (this.comfyUiVariant === 'xpu') {
      return levelZeroDeviceSelectorEnv(selectedId)
    }
    return {}
  }

  getEnvVars() {
    return {
      ...this.getCommonEnvVars(),
      ...this.getDeviceSelectorEnv(),
    }
  }

  getPythonBinaryPath() {
    return path.join(
      this.pythonEnvDir,
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python',
    )
  }

  async detectDevices() {
    this.comfyUiVariant = this.getEffectiveVariant()

    if (this.comfyUiVariant === 'cpu') {
      this.devices = [{ id: '*', name: 'Auto select device', selected: true }]
      this.updateStatus()
      return
    }

    if (this.comfyUiVariant === 'cuda') {
      await this.detectCudaDevicesWithTorch()
      return
    }

    await this.detectXpuDevicesWithTorch()
  }

  private async detectCudaDevicesWithTorch(): Promise<void> {
    const availableDevices = [{ id: '*', name: 'Auto select device', selected: true }]
    const allDevices: Device[] = []
    const pythonScript = `
import torch
import sys

try:
    if not torch.cuda.is_available():
        print("Error detecting CUDA devices: CUDA is not available")
        sys.exit(1)
    device_count = torch.cuda.device_count()
    for i in range(device_count):
        try:
            device_name = torch.cuda.get_device_name(i)
            print(f"{i}|{device_name}")
        except Exception:
            print(f"{i}|Unknown Device")
except Exception as e:
    print(f"Error detecting CUDA devices: {str(e)}")
    sys.exit(1)
`
    try {
      const pythonBinary = this.getPythonBinaryPath()
      const env = this.getCommonEnvVars()
      this.appLogger.info('Detecting CUDA devices with torch.cuda', this.name)
      const result = await spawnProcessAsync(
        pythonBinary,
        ['-c', pythonScript],
        (d) => this.appLogger.info(d, this.name),
        env,
      )
      this.appLogger.info(`CUDA device detection result: ${result}`, this.name)

      const lines = result
        .split('\n')
        .map((l) => l.trim())
        .filter((line) => line !== '')

      for (const line of lines) {
        if (line.startsWith('Error detecting CUDA devices:')) {
          console.error(line)
          continue
        }
        const parts = line.split('|', 2)
        if (parts.length === 2) {
          allDevices.push({ id: parts[0], name: parts[1] })
        }
      }
    } catch (error) {
      console.error('Error detecting CUDA devices:', error)
    }

    this.appLogger.info(`detected devices: ${JSON.stringify(allDevices, null, 2)}`, this.name)
    this.devices =
      allDevices.length > 0 ? allDevices.map((d) => ({ ...d, selected: false })) : availableDevices
    this.updateStatus()
  }

  private async detectXpuDevicesWithTorch(): Promise<void> {
    let allDevices: Device[] = []
    try {
      const pythonScript = `
import torch
import sys

try:
    # Try to get the number of XPU devices
    device_count = torch.xpu.device_count()

    # For each device, get its name and print it
    for i in range(device_count):
        try:
            device_name = torch.xpu.get_device_name(i)
            print(f"{i}|{device_name}")
        except Exception as e:
            print(f"{i}|Unknown Device")
except Exception as e:
    print(f"Error detecting XPU devices: {str(e)}")
    sys.exit(1)
`
      let i = 0
      let lastDeviceList: Device[] = []
      const pythonBinary = this.getPythonBinaryPath()
      while ((lastDeviceList.length > 0 || i == 0) && i < 10) {
        const env = { ...this.getCommonEnvVars(), ...levelZeroDeviceSelectorEnv(String(i)) }
        this.appLogger.info(
          `Detecting level_zero devices with ONEAPI_DEVICE_SELECTOR=${env.ONEAPI_DEVICE_SELECTOR}`,
          this.name,
        )
        const result = await spawnProcessAsync(
          pythonBinary,
          ['-c', pythonScript],
          (d) => this.appLogger.info(d, this.name),
          env,
        )
        this.appLogger.info(`Device detection result: ${result}`, this.name)

        const devices: Device[] = []
        const lines = result
          .split('\n')
          .map((l) => l.trim())
          .filter((line) => line !== '')

        for (const line of lines) {
          if (line.startsWith('Error detecting XPU devices:')) {
            console.error(line)
            continue
          }

          const parts = line.split('|', 2)
          if (parts.length == 2) {
            const id = `${i}`
            const name = parts[1]

            devices.push({ id, name })
          }
        }
        i = i + 1
        lastDeviceList = devices
        allDevices = allDevices.concat(lastDeviceList)
      }
    } catch (error) {
      console.error('Error detecting level_zero devices:', error)
    }
    this.appLogger.info(`detected devices: ${JSON.stringify(allDevices, null, 2)}`, this.name)
    if (allDevices.length === 0) {
      // torch.xpu.device_count() returned 0 — Level Zero loader is present but the
      // Intel GPU driver can't enumerate any devices (missing intel-level-zero-gpu,
      // wrong permissions on /dev/dri/renderD128, or driver mismatch). Running as
      // XPU variant with 0 devices would crash ComfyUI; fall back to CPU instead.
      this.appLogger.warn(
        '[comfyui-variant] torch.xpu found 0 XPU devices — Intel GPU not accessible via Level Zero. ' +
          'Falling back to CPU. Check: (1) intel-level-zero-gpu package installed, ' +
          '(2) user is in the "render" group, (3) /dev/dri/renderD128 permissions.',
        this.name,
        true,
      )
      this.usableXpuConfirmed = false
      this.comfyUiVariant = 'cpu'
      this.devices = [{ id: '*', name: 'Auto select device', selected: true }]
      this.updateStatus()
      return
    }
    // A device probe positively confirmed at least one usable XPU device, so it
    // is safe for spawnAPIProcess() to launch as the XPU variant.
    this.usableXpuConfirmed = true
    this.devices = allDevices.map((d) => ({ ...d, selected: false }))
    this.updateStatus()
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    // Re-apply ComfyUI-Manager security_level=strong on every start so that
    // (a) installs that predate this hardening get locked down on next launch,
    // and (b) anyone tampering with config.ini gets it reverted.
    try {
      await configureComfyUiManagerSecurityLevel(this.serviceDir, 'strong')
    } catch (error) {
      this.appLogger.warn(`Failed to enforce ComfyUI-Manager security_level: ${error}`, this.name)
    }

    // Regenerate the per-launch loopback auth token so the env block of any
    // previous ComfyUI process is no longer reusable.
    this.loopbackAuthToken = randomBytes(32).toString('hex')

    // Defensive XPU usability guard. `comfyUiVariant` can be 'xpu' here either
    // from a stale aipg-variant.json marker or from the transient window inside
    // detectDevices(), which sets the variant to 'xpu' synchronously and only
    // flips it to 'cpu' after its multi-second torch.xpu probe completes. Two
    // startup orchestrators (the main-process apiServiceRegistry and the
    // renderer backendServices store) call detectDevices()/start() concurrently
    // on the same instance, so a spawn can observe 'xpu' before any probe has
    // confirmed a usable device. On a machine whose Intel GPU is not actually
    // usable (e.g. Resizable BAR disabled -> torch.xpu.device_count() == 0),
    // launching as XPU makes ComfyUI "assume Nvidia" and crash with
    // "Torch not compiled with CUDA enabled". Only run as XPU once a probe has
    // positively confirmed at least one device; otherwise fall back to CPU.
    // Runs before the stale-ipex cleanup below so the CPU fallback also strips
    // any leftover ipex_to_cuda injection from a previous XPU install.
    if (
      process.platform === 'linux' &&
      this.comfyUiVariant === 'xpu' &&
      this.usableXpuConfirmed !== true
    ) {
      this.appLogger.warn(
        'ComfyUI variant is xpu but no usable Intel GPU device has been confirmed by a torch.xpu probe; ' +
          'falling back to CPU for this launch to avoid a "Torch not compiled with CUDA enabled" crash.',
        this.name,
        true,
      )
      this.comfyUiVariant = 'cpu'
    }

    // Ensure non-XPU variants don't keep stale ipex_to_cuda injection from previous installs.
    if (this.comfyUiVariant !== 'xpu') {
      const mmPath = path.join(this.serviceDir, 'comfy/model_management.py')
      try {
        if (filesystem.existsSync(mmPath)) {
          const cur = await filesystem.readFile(mmPath, 'utf-8')
          const next = cur
            .replace(/^from ipex_to_cuda import ipex_init\r?\n/m, '')
            .replace(/^ipex_init\(\)\r?\n/m, '')
          if (next !== cur) {
            await filesystem.writeFile(mmPath, next, 'utf-8')
            this.appLogger.info(
              'Removed ipex_to_cuda lines from model_management.py before startup',
              this.name,
            )
          }
        }
      } catch {
        /* ignore */
      }
    }

    const additionalEnvVariables = this.getEnvVars()
    const mediaDir = getMediaDir()
    // --enable-cors-header is required so ComfyUI's origin_only_middleware
    // doesn't 403 our cross-origin requests from the renderer (Vite dev origin
    // / file:// in prod both trigger Sec-Fetch-Site: cross-site against
    // 127.0.0.1:<port>). We pin a specific origin instead of the wildcard so
    // a malicious page in any other browser tab cannot drive the local
    // ComfyUI API via CORS.
    //
    // Also reject user-supplied --listen overrides that target non-loopback
    // addresses (defense against malicious settings injection / accidental
    // misconfiguration).
    const rendererOrigin = getRendererOrigin()
    let userParameters = sanitizeUserComfyUiParameters(this.comfyUiParametersString, (msg) =>
      this.appLogger.warn(msg, this.name, true),
    )

    // The CPU variant must run with --cpu, but ComfyUI's argparse puts --cpu in a
    // mutually-exclusive group with the VRAM-mode flags (--lowvram/--gpu-only/…).
    // The default parameters include "--lowvram --reserve-vram 6.0", so strip the
    // GPU-only VRAM flags (and their values) before appending --cpu.
    if (this.comfyUiVariant === 'cpu') {
      const vramModeFlags = new Set([
        '--gpu-only',
        '--highvram',
        '--normalvram',
        '--lowvram',
        '--novram',
      ])
      const filtered: string[] = []
      for (let i = 0; i < userParameters.length; i++) {
        const arg = userParameters[i]
        if (vramModeFlags.has(arg)) continue
        if (arg === '--reserve-vram') {
          i++ // also skip its value
          continue
        }
        filtered.push(arg)
      }
      userParameters = filtered
    }

    // On Linux XPU (shared-memory Intel iGPUs that borrow up to tens of GB from
    // system RAM), --lowvram's piecemeal model loading fragments the SYCL USM
    // pool and triggers OOM on large single allocations (e.g. Flux attention).
    // Run in normal VRAM mode with a small reserve instead.
    if (process.platform === 'linux' && this.comfyUiVariant === 'xpu') {
      const filtered: string[] = []
      for (let i = 0; i < userParameters.length; i++) {
        const arg = userParameters[i]
        if (arg === '--lowvram') continue
        if (arg === '--reserve-vram') {
          i++ // also skip its value
          continue
        }
        filtered.push(arg)
      }
      userParameters = [...filtered, '--reserve-vram', '2.0']
    }

    const parameters = [
      'main.py',
      '--port',
      this.port.toString(),
      '--preview-method',
      'auto',
      '--output-directory',
      mediaDir,
      ...userParameters,
      // For the CPU variant (e.g. Linux studio/essentials without a usable Intel
      // GPU runtime), force ComfyUI onto CPU. Without this, ComfyUI's device
      // autodetect "assumes Nvidia" and calls torch.cuda, crashing with
      // "Torch not compiled with CUDA enabled" on a CPU-only torch build.
      ...(this.comfyUiVariant === 'cpu' ? ['--cpu'] : []),
      // Force-append after user params so we always win, even if the user
      // tried to inject their own --enable-cors-header.
      '--enable-cors-header',
      rendererOrigin,
    ]
    this.appLogger.info(
      `starting comfyui with ${JSON.stringify({ parameters, additionalEnvVariables })}`,
      this.name,
      true,
    )
    const pythonBinary = this.getPythonBinaryPath()
    const apiProcess = spawn(pythonBinary, parameters, {
      cwd: this.serviceDir,
      windowsHide: true,
      // Build a fresh env object instead of mutating process.env — otherwise the
      // injected LD_LIBRARY_PATH / device-selector vars would leak into every
      // later child process spawned from the main Electron process.
      env: { ...process.env, ...additionalEnvVariables },
    })

    //must be at the same tick as the spawn function call
    //otherwise we cannot really track errors given the nature of spawn() with a longlived process
    const didProcessExitEarlyTracker = new Promise<boolean>((resolve, _reject) => {
      apiProcess.on('exit', () => {
        this.appLogger.error(`encountered unexpected exit in ${this.name}.`, this.name)
        resolve(true)
      })
      apiProcess.on('error', (error) => {
        this.appLogger.error(`encountered error of process in ${this.name} : ${error}`, this.name)
        resolve(true)
      })
    })

    return {
      process: apiProcess,
      didProcessExitEarlyTracker: didProcessExitEarlyTracker,
    }
  }
}
