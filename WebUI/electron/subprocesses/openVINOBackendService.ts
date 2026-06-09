import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import * as filesystem from 'fs-extra'
import { app, BrowserWindow, dialog, net } from 'electron'
import { appLoggerInstance } from '../logging/logger.ts'
import { packagedResourcesRoot } from '../aipgRoot.ts'
import { ApiService, createEnhancedErrorDetails, ErrorDetails } from './service.ts'
import { promisify } from 'util'
import { exec } from 'child_process'
import { LocalSettings } from '../main.ts'
import getPort, { portNumbers } from 'get-port'
import { ensureManagedPython, installBackend, uvPipInstallToTarget } from './uvBasedBackends/uv.ts'
import { binary, extract } from './tools.ts'
import {
  getMissingPackages,
  hasAptGet,
  hasPkexec,
  parseAptMissingPackages,
  resolvePackageList,
  runPkexecInstall,
  waitForTerminalInstall,
} from './linuxPackageInstaller.ts'

const execAsync = promisify(exec)

interface OvmsServerProcess {
  process: ChildProcess
  port: number
  modelRepoId: string
  type: 'llm' | 'embedding' | 'transcription' | 'image_generation'
  contextSize?: number
  isReady: boolean
  healthEndpointUrl: string
}

export class OpenVINOBackendService implements ApiService {
  readonly name = 'openvino-backend' as BackendServiceName
  readonly baseUrl: string
  readonly port: number
  readonly isRequired: boolean = false
  readonly win: BrowserWindow
  readonly settings: LocalSettings

  // Service directories
  readonly baseDir = app.isPackaged ? packagedResourcesRoot() : path.join(__dirname, '../../../')
  readonly serviceDir: string
  readonly ovmsDir: string
  readonly ovmsExePath: string
  readonly pythonEnvDir: string
  readonly detectDevicesScript: string

  readonly zipPath: string
  devices: InferenceDevice[] = [{ id: 'AUTO', name: 'Auto select device', selected: true }]
  sttDevices: InferenceDevice[] = [{ id: 'AUTO', name: 'Auto select device', selected: true }]

  // Health endpoint
  healthEndpointUrl: string

  // Status tracking
  currentStatus: BackendStatus = 'notInstalled'
  isSetUp: boolean = false
  desiredStatus: BackendStatus = 'uninitializedStatus'

  // Model server processes
  private ovmsLlmProcess: OvmsServerProcess | null = null
  private ovmsEmbeddingProcess: OvmsServerProcess | null = null
  private ovmsTranscriptionProcess: OvmsServerProcess | null = null
  private ovmsImageProcess: OvmsServerProcess | null = null
  private currentModel: string | null = null
  private currentContextSize: number | null = null
  private currentEmbeddingModel: string | null = null
  private currentTranscriptionModel: string | null = null
  private currentImageModel: string | null = null
  private currentImageResolution: string | null = null

  // Store last startup error details for persistence
  private lastStartupErrorDetails: ErrorDetails | null = null

  // Cached extra LD_LIBRARY_PATH directories resolved from ldconfig (Linux only)
  private cachedOvmsExtraLibPaths: string[] | null = null

  // Linux only: PYTHONHOME pointing at a managed CPython that matches the OVMS
  // build's libpython soname (e.g. 3.12). Set during resolveOvmsExtraLibPaths().
  private ovmsEmbeddedPythonHome: string | null = null

  // The OVMS ubuntu24 build is linked against libpython3.12.so.1.0 and uses
  // CPython-3.12 internal symbols (e.g. _PyThreadState_UncheckedGet), so it MUST
  // run against a genuine 3.12 runtime regardless of the host distro's Python.
  private static readonly OVMS_EMBEDDED_PYTHON_VERSION = '3.12'

  // Cached installed version for inclusion in service info updates
  private cachedInstalledVersion: { version: string; releaseTag?: string } | undefined = undefined

  // Logger
  readonly appLogger = appLoggerInstance

  private version = '2026.1.0'
  private releaseTag: string | undefined = '72cc0624'
  private readonly linuxRuntimePackages = [
    'python3',
    'python3-venv',
    'libtbb12',
    'libhwloc15',
    'libgomp1',
    'libnuma1',
    'ocl-icd-libopencl1',
  ]

  private readonly linuxAlternativePackages = [
    ['libfuse2t64', 'libfuse2'],
    ['libpython3.12t64', 'libpython3.12', 'python3.12', 'python3.12-minimal'],
  ]

  constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
    this.name = name
    this.port = port
    this.win = win
    this.settings = settings
    this.baseUrl = `http://127.0.0.1:${port}/v3`
    this.healthEndpointUrl = `http://127.0.0.1:${port}/v2/health/ready`

    // Set up paths
    this.serviceDir = path.resolve(path.join(this.baseDir, 'OpenVINO'))
    this.ovmsDir = path.resolve(path.join(this.serviceDir, 'ovms'))
    // On Windows the binary sits at the OVMS root; on Linux/macOS it lives under bin/
    const ovmsExe = process.platform === 'win32' ? 'ovms.exe' : path.join('bin', binary('ovms'))
    this.ovmsExePath = path.resolve(path.join(this.ovmsDir, ovmsExe))
    const archiveName = process.platform === 'win32' ? 'ovms.zip' : 'ovms.tar.gz'
    this.zipPath = path.resolve(path.join(this.serviceDir, archiveName))
    this.pythonEnvDir = path.resolve(path.join(this.serviceDir, '.venv'))
    this.detectDevicesScript = path.resolve(path.join(this.serviceDir, 'detect_devices.py'))

    // Check if already set up
    this.isSetUp = this.serviceIsSetUp()
    console.log('OVMS isSetUp:', this.isSetUp)

    // Cache version on startup if already set up
    if (this.isSetUp) {
      this.updateCachedVersion().then(() => {
        this.updateStatus()
      })
    }
  }

  serviceIsSetUp(): boolean {
    console.log('checking', this.ovmsExePath)
    return filesystem.existsSync(this.ovmsExePath)
  }

  /**
   * Return process.env with inherited Python/virtualenv variables removed.
   * When AI Playground is launched from a shell with another venv active
   * (e.g. ComfyUI's .venv), variables like VIRTUAL_ENV / PYTHONHOME /
   * PYTHONPATH / __PYVENV_LAUNCHER__ leak into any Python we spawn and break it
   * with "failed to get the Python codec of the filesystem encoding".
   */
  private stripInheritedPythonEnv(): {
    cleanEnv: NodeJS.ProcessEnv
    inheritedVirtualEnv?: string
  } {
    const {
      VIRTUAL_ENV: inheritedVirtualEnv,
      PYTHONPATH: _pythonPath,
      PYTHONHOME: _pythonHome,
      PYTHONSTARTUP: _pythonStartup,
      PYTHONEXECUTABLE: _pythonExecutable,
      __PYVENV_LAUNCHER__: _pyvenvLauncher,
      ...cleanEnv
    } = process.env
    return { cleanEnv, inheritedVirtualEnv }
  }

  /**
   * Drop any foreign virtualenv bin/Scripts directories from a PATH string so a
   * spawned interpreter can't resolve `python`/`python3` to the wrong venv.
   */
  private sanitizeForeignVenvFromPath(pathStr: string | undefined, activeVenv?: string): string {
    const venvBinDirs = new Set<string>()
    if (activeVenv) {
      venvBinDirs.add(path.normalize(path.join(activeVenv, 'bin')))
      venvBinDirs.add(path.normalize(path.join(activeVenv, 'Scripts')))
    }
    const looksLikeVenvBin = (p: string) => /[\\/](?:\.venv|venv)[\\/](?:bin|Scripts)$/.test(p)
    return (pathStr ?? '')
      .split(path.delimiter)
      .filter((p) => {
        if (!p) return false
        const normalized = path.normalize(p)
        return !venvBinDirs.has(normalized) && !looksLikeVenvBin(normalized)
      })
      .join(path.delimiter)
  }

  /**
   * Build the environment used to spawn the OVMS executable.
   * Cross-platform: Windows resolves DLLs from PATH, Linux resolves shared
   * objects (libopenvino, libtbb, Level Zero GPU libs, ...) from LD_LIBRARY_PATH.
   *
   * @param extraLibPaths - Additional directories to prepend to LD_LIBRARY_PATH
   *   (Linux only). Used to supply libpython3.x paths discovered via ldconfig
   *   when the package was not found via apt-cache.
   */
  private buildOvmsEnv(extraLibPaths: string[] = []): NodeJS.ProcessEnv {
    // Set up environment variables as per setupvars.ps1 / setupvars.sh
    const pythonDir = path.join(this.ovmsDir, 'python')
    const scriptsDir = path.join(pythonDir, process.platform === 'win32' ? 'Scripts' : 'bin')

    const { cleanEnv, inheritedVirtualEnv } = this.stripInheritedPythonEnv()
    const sanitizedInheritedPath = this.sanitizeForeignVenvFromPath(
      cleanEnv.PATH,
      inheritedVirtualEnv,
    )

    if (process.platform === 'win32') {
      // Windows ships a fully self-contained CPython under ovms/python, so we
      // point PYTHONHOME at it and expose its Scripts dir on PATH.
      return {
        ...cleanEnv,
        OVMS_DIR: this.ovmsDir,
        PYTHONHOME: pythonDir,
        PATH: [this.ovmsDir, pythonDir, scriptsDir, sanitizedInheritedPath]
          .filter(Boolean)
          .join(path.delimiter),
      }
    }

    // Linux/macOS: the OVMS package does NOT bundle a complete CPython stdlib
    // (that's why the .deb depends on `python3`) AND it is linked against a
    // specific libpython soname (3.12 for the ubuntu24 build). On distros whose
    // system Python differs (e.g. Ubuntu 26 → 3.14), pointing PYTHONHOME at the
    // system Python is impossible/ABI-incompatible. Instead we provision a
    // managed CPython 3.12 (via uv) that ships a matching libpython3.12.so.1.0
    // AND a complete 3.12 stdlib, and point PYTHONHOME at it. Its lib dir is
    // added to LD_LIBRARY_PATH (passed in via extraLibPaths) so the dynamic
    // linker resolves libpython3.12 to the genuine, ABI-correct library.
    // When no managed Python could be provisioned we leave PYTHONHOME unset and
    // fall back to the system Python (works on Ubuntu 24).
    const ovmsPythonModuleDirs = [
      path.join(this.ovmsDir, 'lib', 'python'),
      path.join(pythonDir, 'lib', 'python'),
    ].filter((p) => filesystem.existsSync(p))

    return {
      ...cleanEnv,
      OVMS_DIR: this.ovmsDir,
      // Keep the inherited PATH (so /usr/bin/python3 is discoverable) and put
      // the OVMS bin dir first for the ovms binary's own helper executables.
      PATH: [path.join(this.ovmsDir, 'bin'), this.ovmsDir, sanitizedInheritedPath]
        .filter(Boolean)
        .join(path.delimiter),
      // Point the embedded interpreter at the managed CPython 3.12 (complete
      // stdlib + matching libpython) when available.
      ...(this.ovmsEmbeddedPythonHome && { PYTHONHOME: this.ovmsEmbeddedPythonHome }),
      ...(ovmsPythonModuleDirs.length > 0 && {
        PYTHONPATH: ovmsPythonModuleDirs.join(path.delimiter),
      }),
      // Ensure a UTF-8 locale so the interpreter can load the filesystem-encoding
      // codec on minimal setups where LANG/LC_ALL may be unset.
      LANG: process.env.LANG ?? 'C.UTF-8',
      LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? 'C.UTF-8',
      LD_LIBRARY_PATH: [
        path.join(this.ovmsDir, 'lib'),
        ...extraLibPaths,
        process.env.LD_LIBRARY_PATH ?? '',
      ]
        .filter(Boolean)
        .join(':'),
    }
  }

  /**
   * Resolve additional LD_LIBRARY_PATH directories needed by the OVMS binary on Linux,
   * and create compatibility symlinks for any missing shared libraries.
   *
   * OVMS (ubuntu24 build) is linked against specific soname versions
   * (e.g. libpython3.12.so.1.0, libxml2.so.2) that may not exist on newer distros
   * (e.g. Ubuntu 26 ships Python 3.14 and may have bumped other sonames).
   *
   * Strategy:
   *  1. Run `ldd` on the OVMS binary (with ovms/lib in LD_LIBRARY_PATH so bundled
   *     libs are counted as satisfied).
   *  2. Collect every library reported as "not found".
   *  3. For each missing lib, search `ldconfig -p` for any version of the same
   *     base library present on the system.
   *  4. Create a symlink `ovms/lib/<missing-soname> → <system-library-path>`.
   *     Since ovms/lib is already in LD_LIBRARY_PATH, the dynamic linker finds it.
   *
   * The result is cached after the first call.
   */
  /**
   * Ensure jinja2 (and its MarkupSafe dependency) is available in the OVMS Python
   * path. OVMS ubuntu24 builds use Python's jinja2 library to render chat templates;
   * the OVMS package does not bundle it, so we install it on first use via uv.
   */
  private async ensureOvmsJinja2(): Promise<void> {
    const ovmsLibPython = path.join(this.ovmsDir, 'lib', 'python')
    const jinja2Marker = path.join(ovmsLibPython, 'jinja2')
    if (filesystem.existsSync(jinja2Marker)) {
      return
    }
    if (!filesystem.existsSync(ovmsLibPython)) {
      filesystem.mkdirSync(ovmsLibPython, { recursive: true })
    }
    const pythonBin = this.ovmsEmbeddedPythonHome
      ? path.join(this.ovmsEmbeddedPythonHome, 'bin', 'python3.12')
      : undefined
    this.appLogger.info(
      `Installing jinja2 for OVMS chat template rendering into ${ovmsLibPython}`,
      this.name,
    )
    try {
      await uvPipInstallToTarget(['jinja2'], ovmsLibPython, pythonBin)
      this.appLogger.info('jinja2 installed successfully for OVMS', this.name)
    } catch (e) {
      this.appLogger.warn(
        `Failed to install jinja2 for OVMS: ${e}. Chat template rendering may not work.`,
        this.name,
      )
    }
  }

  private async resolveOvmsExtraLibPaths(): Promise<string[]> {
    if (this.cachedOvmsExtraLibPaths !== null) return this.cachedOvmsExtraLibPaths
    if (process.platform === 'win32') {
      this.cachedOvmsExtraLibPaths = []
      return []
    }

    const extraLibPaths: string[] = []

    // Provision a managed CPython 3.12 so OVMS gets the genuine libpython3.12 it
    // is linked against (the host distro's Python may be incompatible, e.g.
    // Ubuntu 26 ships 3.14 which lacks symbols OVMS imports). Its lib dir goes
    // on LD_LIBRARY_PATH and its home becomes PYTHONHOME (see buildOvmsEnv).
    const embeddedPython = await this.resolveOvmsEmbeddedPython()
    if (embeddedPython) {
      this.ovmsEmbeddedPythonHome = embeddedPython.home
      extraLibPaths.push(embeddedPython.libDir)
    }

    // OVMS ubuntu24 builds use Python's jinja2 to render chat templates but do
    // not bundle it. Install it into ovms/lib/python (already on PYTHONPATH).
    await this.ensureOvmsJinja2()

    // Create compat symlinks for any *other* libs still missing (e.g. libxml2),
    // counting the managed-python lib dir as already-satisfied so we never
    // recreate a bad cross-version libpython symlink.
    await this.ensureOvmsMissingLibSymlinks(extraLibPaths)

    this.cachedOvmsExtraLibPaths = extraLibPaths
    return extraLibPaths
  }

  /**
   * Ensure a managed CPython that matches the OVMS build's libpython soname is
   * available and locate its home + shared-library directory.
   *
   * Returns null on non-Linux or if provisioning fails (caller then falls back
   * to the host Python via ldconfig-based symlinks).
   */
  private async resolveOvmsEmbeddedPython(): Promise<{
    home: string
    libDir: string
    libFile: string
  } | null> {
    if (process.platform === 'win32') return null
    try {
      const interpreterPath = await ensureManagedPython(
        OpenVINOBackendService.OVMS_EMBEDDED_PYTHON_VERSION,
      )
      // Standalone layout: <home>/bin/python3.12 with stdlib in <home>/lib/python3.12
      // and the shared lib in <home>/lib/libpython3.12.so.1.0
      const home = path.dirname(path.dirname(interpreterPath))
      const libDir = path.join(home, 'lib')
      const libFile = ['libpython3.12.so.1.0', 'libpython3.12.so']
        .map((name) => path.join(libDir, name))
        .find((p) => filesystem.existsSync(p))

      if (!libFile) {
        this.appLogger.warn(
          `Managed CPython 3.12 found at ${home} but no libpython in ${libDir}; ` +
            'falling back to host Python',
          this.name,
        )
        return null
      }

      this.appLogger.info(
        `Using managed CPython 3.12 for OVMS — home: ${home}, libpython: ${libFile}`,
        this.name,
      )
      return { home, libDir, libFile }
    } catch (e) {
      this.appLogger.warn(
        `Failed to provision managed CPython 3.12 for OVMS (${e}); falling back to host Python`,
        this.name,
      )
      return null
    }
  }

  /**
   * Run ldd on the OVMS binary and create compatibility symlinks in ovms/lib/ for
   * every shared library that is "not found" on the current system.
   *
   * @param extraLibDirs - Additional directories (e.g. the managed CPython lib
   *   dir) to add to LD_LIBRARY_PATH while probing, so libraries they provide are
   *   counted as satisfied and not symlinked to an incompatible host version.
   */
  private async ensureOvmsMissingLibSymlinks(extraLibDirs: string[] = []): Promise<void> {
    const ovmsLibDir = path.join(this.ovmsDir, 'lib')
    await filesystem.ensureDir(ovmsLibDir)

    // Remove stale compat symlinks created by earlier runs. Previous versions of
    // this code created dangerous cross-ABI symlinks (e.g. libxml2.so.2 →
    // /usr/lib/.../libxml2.so.16) that cause SIGSEGV. Our symlinks always use
    // ABSOLUTE targets pointing to system libraries (e.g. /usr/lib/...), while
    // OVMS-bundled symlinks use RELATIVE targets (e.g. libopenvino.so.2026.1.0).
    // Only remove symlinks with absolute targets outside the ovms directory.
    const existingLibs = await filesystem.readdir(ovmsLibDir).catch(() => [] as string[])
    for (const entry of existingLibs) {
      const full = path.join(ovmsLibDir, entry)
      const isSymlink = await filesystem
        .lstat(full)
        .then((s) => s.isSymbolicLink())
        .catch(() => false)
      if (isSymlink) {
        const target = await filesystem.readlink(full).catch(() => '')
        // Our compat symlinks always point to absolute system paths (e.g.
        // /usr/lib/x86_64-linux-gnu/libfoo.so). Bundled symlinks use relative
        // targets (e.g. libopenvino.so.2026.1.0). Only remove absolute-target
        // symlinks that point outside the ovms tree.
        if (target && path.isAbsolute(target) && !target.startsWith(this.ovmsDir)) {
          await filesystem.remove(full)
          this.appLogger.info(`Removed stale compat symlink: ${entry} → ${target}`, this.name)
        }
      }
    }

    // Run ldd with ovms/lib (+ extra dirs) in LD_LIBRARY_PATH so already-bundled
    // and managed-python libs count as satisfied. ldd exits with code 1 when any
    // library is missing, so we capture output from the error object as well.
    let lddOutput = ''
    try {
      const lddEnv: NodeJS.ProcessEnv = {
        ...process.env,
        LD_LIBRARY_PATH: [ovmsLibDir, ...extraLibDirs, process.env.LD_LIBRARY_PATH ?? '']
          .filter(Boolean)
          .join(':'),
      }
      lddOutput = await execAsync(`ldd "${this.ovmsExePath}"`, { env: lddEnv })
        .then((r) => r.stdout)
        .catch((e: { stdout?: string; stderr?: string }) => `${e.stdout ?? ''}${e.stderr ?? ''}`)
    } catch {
      this.appLogger.warn('ldd not available; skipping OVMS dependency symlink check', this.name)
      return
    }

    // Parse lines like: "	libxml2.so.2 => not found"
    const missingLibsSet = new Set<string>()
    const notFoundRegex = /^\s*(\S+\.so\S*)\s+=>\s+not found/gm
    let match: RegExpExecArray | null
    while ((match = notFoundRegex.exec(lddOutput)) !== null) {
      if (match[1]) missingLibsSet.add(match[1])
    }
    const missingLibs = [...missingLibsSet]

    if (missingLibs.length === 0) {
      this.appLogger.info('All OVMS dynamic library dependencies are satisfied', this.name)
      return
    }

    this.appLogger.info(`OVMS missing libraries: ${missingLibs.join(', ')}`, this.name)

    // Build a map of every library registered in the linker cache: soname → real path
    let ldconfigOutput = ''
    try {
      const { stdout } = await execAsync('ldconfig -p')
      ldconfigOutput = stdout
    } catch {
      this.appLogger.warn('ldconfig not available; cannot create compatibility symlinks', this.name)
      return
    }

    const ldconfigMap = new Map<string, string>()
    for (const line of ldconfigOutput.split('\n')) {
      // Line format: "	libfoo.so.2 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libfoo.so.2"
      const m = line.match(/^\s*(\S+)\s+\([^)]+\)\s+=>\s+(\S+)/)
      if (m?.[1] && m?.[2]) ldconfigMap.set(m[1], m[2])
    }

    for (const missingLib of missingLibs) {
      const symlinkPath = path.join(ovmsLibDir, missingLib)
      if (filesystem.existsSync(symlinkPath)) continue

      // First, check if the real library exists within ovms/lib itself (self-healing
      // for bundled soname symlinks that may have been accidentally deleted by earlier
      // versions of this code). E.g. libopenvino_genai.so.2610 → libopenvino_genai.so.2026.1.0.0
      const bundledTarget = this.findBundledLibInOvmsDir(missingLib, ovmsLibDir)
      if (bundledTarget) {
        await this.createOvmsCompatSymlink(symlinkPath, bundledTarget)
        continue
      }

      // Then check system libraries via ldconfig
      const found = this.findCompatLibInLdconfig(missingLib, ldconfigMap)
      if (found) {
        if (found.isAbiRisky) {
          this.appLogger.warn(
            `Creating ABI-risky compat symlink for ${missingLib} → ${found.path} ` +
              `(different soname version — may produce linker warnings but allows OVMS to start)`,
            this.name,
          )
        }
        await this.createOvmsCompatSymlink(symlinkPath, found.path)
      } else {
        this.appLogger.warn(
          `No system library found for ${missingLib} — OVMS may fail to start`,
          this.name,
        )
      }
    }
  }

  /**
   * Look for a bundled library file in ovms/lib that can satisfy a missing soname.
   * This handles self-healing when internal soname symlinks were accidentally deleted.
   *
   * For example, if `libopenvino_genai.so.2610` is missing but
   * `libopenvino_genai.so.2026.1.0.0` exists as a real file in ovms/lib,
   * we return the path to the real file so a relative symlink can be recreated.
   *
   * Strategy: strip the soname suffix to get the base name (e.g. `libopenvino_genai`),
   * then look for any file in ovms/lib that starts with `<base>.so` and is a real
   * file (not a symlink), giving preference to longer version strings (more specific).
   */
  private findBundledLibInOvmsDir(missingLib: string, ovmsLibDir: string): string | undefined {
    const libBase = missingLib.replace(/\.so\.\d[\d.]*$/, '')
    const prefix = `${libBase}.so`

    try {
      const entries = filesystem.readdirSync(ovmsLibDir)
      // Find real files (not symlinks) that match the base library name
      const candidates = entries.filter((entry) => {
        if (!entry.startsWith(prefix)) return false
        if (entry === missingLib) return false // skip the missing one itself
        const full = path.join(ovmsLibDir, entry)
        try {
          const stat = filesystem.lstatSync(full)
          return stat.isFile() // real file, not a symlink
        } catch {
          return false
        }
      })

      if (candidates.length === 0) return undefined

      // Prefer the most specific version (longest filename)
      candidates.sort((a, b) => b.length - a.length)
      const target = candidates[0]
      this.appLogger.info(
        `Found bundled library for ${missingLib} in ovms/lib: ${target}`,
        this.name,
      )
      // Return the filename only (relative target) for the symlink
      return target
    } catch {
      return undefined
    }
  }

  /**
   * Find a compatible real library path for a missing soname using three strategies:
   *
   *  1. Exact soname match in ldconfig (lib present but not in a searched dir).
   *  2. Version embedded in base name — strip trailing .N segments until a match is
   *     found, e.g. libpython3.12 → libpython3 → matches libpython3.14.so.1.0
   *  3. (Last resort) Same base name, different soname version — e.g. libxml2.so.2 →
   *     libxml2.so.16. This is ABI-risky (may cause "no version information" warnings)
   *     but is better than OVMS failing to start entirely. The library may still work
   *     if the consumer doesn't actually invoke the incompatible symbols at runtime.
   */
  private findCompatLibInLdconfig(
    missingLib: string,
    ldconfigMap: Map<string, string>,
  ): { path: string; isAbiRisky: boolean } | undefined {
    // Strip the soname suffix to get the base, e.g.:
    //   libpython3.12.so.1.0 → libpython3.12
    //   libxml2.so.2         → libxml2
    const libBase = missingLib.replace(/\.so\.\d[\d.]*$/, '')

    // 1. Exact match
    const exact = ldconfigMap.get(missingLib)
    if (exact && filesystem.existsSync(exact)) return { path: exact, isAbiRisky: false }

    // 2. Version is part of the base name (e.g. libpython3.12 → libpython3 → libpython3.14)
    //    Progressively strip trailing ".N" segments from the base until a match is found.
    let shortenedBase = libBase
    while (/\.\d+$/.test(shortenedBase)) {
      shortenedBase = shortenedBase.replace(/\.\d+$/, '')
      const versionedMatch = [...ldconfigMap.entries()].find(
        ([name, realPath]) =>
          // Must start with the shortened base followed by a version dot or ".so"
          (name.startsWith(`${shortenedBase}.so.`) ||
            name.match(new RegExp(`^${shortenedBase}\\.\\d`))) &&
          filesystem.existsSync(realPath),
      )
      if (versionedMatch) return { path: versionedMatch[1], isAbiRisky: false }
    }

    // 3. Last resort: same base, different soname version (e.g. libxml2.so.16 for libxml2.so.2).
    //    This crosses ABI boundaries and may produce linker warnings or runtime issues,
    //    but it's better than OVMS refusing to start at all — many libraries (like
    //    libazurestorage needing libxml2) may never actually be invoked at runtime for
    //    local model inference.
    const sameName = [...ldconfigMap.entries()].find(
      ([name, realPath]) => name.startsWith(`${libBase}.so.`) && filesystem.existsSync(realPath),
    )
    if (sameName) return { path: sameName[1], isAbiRisky: true }

    return undefined
  }

  private async createOvmsCompatSymlink(symlinkPath: string, targetPath: string): Promise<void> {
    try {
      await filesystem.symlink(targetPath, symlinkPath)
      this.appLogger.info(
        `Created compat symlink: ${path.basename(symlinkPath)} → ${targetPath}`,
        this.name,
      )
    } catch (e) {
      this.appLogger.warn(
        `Failed to create compat symlink ${path.basename(symlinkPath)}: ${e}`,
        this.name,
      )
    }
  }

  /**
   * Build the environment used to spawn the OpenVINO Python device-detection venv.
   * This venv (ovms-independent) has its own CPython, so we activate it via
   * VIRTUAL_ENV and must likewise strip any inherited foreign-venv pollution,
   * otherwise device detection crashes and silently hides the Intel GPU/NPU.
   */
  private buildPythonDetectionEnv(): NodeJS.ProcessEnv {
    const { cleanEnv, inheritedVirtualEnv } = this.stripInheritedPythonEnv()
    const venvBinDir = path.join(
      this.pythonEnvDir,
      process.platform === 'win32' ? 'Scripts' : 'bin',
    )
    const sanitizedInheritedPath = this.sanitizeForeignVenvFromPath(
      cleanEnv.PATH,
      inheritedVirtualEnv,
    )

    return {
      ...cleanEnv,
      // Activate our own detection venv (its bin dir is prepended so its python
      // is the one that runs; PYTHONHOME stays unset so the venv resolves it).
      VIRTUAL_ENV: this.pythonEnvDir,
      PATH: [venvBinDir, sanitizedInheritedPath].filter(Boolean).join(path.delimiter),
      // On Linux, the OpenVINO runtime needs the Level Zero loader & Intel GPU
      // driver from the system lib dir to enumerate Intel GPUs/NPUs.
      ...(process.platform !== 'win32' && {
        LANG: process.env.LANG ?? 'C.UTF-8',
        LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? 'C.UTF-8',
        LD_LIBRARY_PATH: ['/usr/lib/x86_64-linux-gnu', process.env.LD_LIBRARY_PATH ?? '']
          .filter(Boolean)
          .join(':'),
      }),
    }
  }

  private async ensureLinuxRuntimeDependencies(
    onProgress?: (message: string) => Promise<void> | void,
  ): Promise<void> {
    if (process.platform !== 'linux') return

    const hasApt = await hasAptGet()
    if (!hasApt) {
      this.appLogger.warn(
        'apt-get not found; skipping automatic Linux dependency install',
        this.name,
      )
      return
    }

    const distroAwarePackageList = await resolvePackageList(
      this.linuxAlternativePackages,
      this.linuxRuntimePackages,
    )
    const missingPackages = await getMissingPackages(distroAwarePackageList)

    if (missingPackages.length === 0) {
      this.appLogger.info(
        'All OpenVINO Linux runtime dependencies are already installed',
        this.name,
      )
      return
    }

    const packageList = missingPackages.map((p) => `- ${p}`).join('\n')
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'warning',
      buttons: ['Install now', 'Cancel setup'],
      defaultId: 0,
      cancelId: 1,
      title: 'Install OpenVINO Linux dependencies',
      message: 'OpenVINO requires additional Ubuntu packages before setup can continue.',
      detail:
        `Missing packages:\n${packageList}\n\n` +
        'AI Playground will request administrator permission and install these packages automatically.',
    })

    if (response === 1) {
      throw new Error('OpenVINO setup canceled: Linux dependencies were not installed')
    }

    await onProgress?.('installing Ubuntu dependencies for OpenVINO')

    const pkexecAvailable = await hasPkexec()
    if (pkexecAvailable) {
      const installResult = await runPkexecInstall(missingPackages, 'apt-get update')
      if (!installResult.success) {
        const aptMissing = parseAptMissingPackages(installResult.output)
        if (aptMissing.length > 0) {
          this.appLogger.error(
            `OpenVINO dependency install failed. Missing in apt repo: ${aptMissing.join(', ')}`,
            this.name,
          )
        } else {
          this.appLogger.error(
            `OpenVINO dependency install failed with output: ${installResult.output}`,
            this.name,
          )
        }
      }
    } else {
      await onProgress?.('pkexec unavailable, falling back to terminal installer')
      const terminalExited = await waitForTerminalInstall(missingPackages, 'sudo apt-get update')
      if (!terminalExited) {
        throw new Error(
          `Could not open installer automatically. Please install: ${missingPackages.join(', ')}`,
        )
      }
      this.appLogger.info('Terminal closed. Waiting for apt-cache refresh...', this.name)
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }

    let stillMissing: string[] = []
    for (let retryAttempt = 0; retryAttempt < 5; retryAttempt++) {
      stillMissing = await getMissingPackages(distroAwarePackageList)
      if (stillMissing.length === 0) {
        this.appLogger.info('Installed missing Linux runtime dependencies for OpenVINO', this.name)
        return
      }
      if (retryAttempt < 4) {
        this.appLogger.info(
          `Still missing on attempt ${retryAttempt + 1}: ${stillMissing.join(', ')}. Retrying...`,
          this.name,
        )
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }

    this.appLogger.error(
      `OpenVINO dependencies still missing after installer: ${stillMissing.join(', ')}`,
      this.name,
    )

    throw new Error(`Dependencies still missing after installer: ${stillMissing.join(', ')}`)
  }

  private async ensureLinuxRuntimeDependenciesForStartup(): Promise<void> {
    await this.ensureLinuxRuntimeDependencies((message) => {
      this.appLogger.info(message, this.name)
    })
  }

  async ensureBackendReadiness(
    llmModelName: string,
    embeddingModelName?: string,
    contextSize?: number,
  ): Promise<void> {
    this.appLogger.info(
      `Ensuring OpenVINO backend readiness for LLM: ${llmModelName}, Embedding: ${embeddingModelName ?? 'none'}, Context: ${contextSize ?? 'default'}`,
      this.name,
    )

    try {
      if (process.platform === 'linux') {
        await this.ensureLinuxRuntimeDependenciesForStartup()
      }

      // Handle LLM model
      const needsLlmRestart =
        this.currentModel !== llmModelName ||
        (contextSize && contextSize !== this.currentContextSize) ||
        !this.ovmsLlmProcess?.isReady

      if (needsLlmRestart) {
        await this.stopOvmsLlmServer()
        await this.startOvmsLlmServer(llmModelName, contextSize)
        this.appLogger.info(`LLM server ready with model: ${llmModelName}`, this.name)
      } else {
        this.appLogger.info(`LLM server already running with model: ${llmModelName}`, this.name)
      }

      // Handle embedding model if provided
      if (embeddingModelName) {
        const needsEmbeddingRestart =
          this.currentEmbeddingModel !== embeddingModelName || !this.ovmsEmbeddingProcess?.isReady

        if (needsEmbeddingRestart) {
          await this.stopOvmsEmbeddingServer()
          await this.startOvmsEmbeddingServer(embeddingModelName)
          this.appLogger.info(`Embedding server ready with model: ${embeddingModelName}`, this.name)
        } else {
          this.appLogger.info(
            `Embedding server already running with model: ${embeddingModelName}`,
            this.name,
          )
        }
      }

      this.appLogger.info(
        `OpenVINO backend fully ready - LLM: ${llmModelName}, Embedding: ${embeddingModelName ?? 'none'}`,
        this.name,
      )
    } catch (error) {
      this.appLogger.error(
        `Failed to ensure backend readiness - LLM: ${llmModelName}, Embedding: ${embeddingModelName ?? 'none'}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  async selectDevice(deviceId: string): Promise<void> {
    if (!this.devices.find((d) => d.id === deviceId)) return
    this.devices = this.devices.map((d) => ({ ...d, selected: d.id === deviceId }))
    this.updateStatus()
  }

  async selectSttDevice(deviceId: string): Promise<void> {
    if (!this.sttDevices.find((d) => d.id === deviceId)) return
    this.sttDevices = this.sttDevices.map((d) => ({ ...d, selected: d.id === deviceId }))
    this.updateStatus()
  }

  async detectDevices() {
    const defaultDevices: InferenceDevice[] = [
      { id: 'AUTO', name: 'Auto select device', selected: true },
    ]

    if (!this.isSetUp) {
      this.appLogger.info('OpenVINO not set up, using default devices', this.name)
      this.devices = defaultDevices
      this.sttDevices = [...defaultDevices]
      this.updateStatus()
      return
    }

    try {
      // Try Python-based detection first (provides full device names)
      const pythonDevices = await this.detectDevicesWithPython()
      if (pythonDevices) {
        this.applyDetectedDevices(pythonDevices)
        this.updateStatus()
        return
      }
    } catch (error) {
      this.appLogger.warn(
        `Python-based device detection failed: ${error}. Falling back to OVMS detection.`,
        this.name,
      )
    }

    // Fallback to OVMS-based detection
    try {
      const ovmsDevices = await this.detectDevicesWithOvms()
      this.applyDetectedDevices(ovmsDevices)
    } catch (error) {
      this.appLogger.error(`Failed to detect devices: ${error}`, this.name)
      // Fallback to default device on error
      this.devices = defaultDevices
      this.sttDevices = [...defaultDevices]
    }
    this.updateStatus()
  }

  /**
   * Detect devices using the OpenVINO Python script.
   * Returns array of {id, name} objects, or null if detection fails.
   */
  private async detectDevicesWithPython(): Promise<{ id: string; name: string }[] | null> {
    const pythonExe = path.join(
      this.pythonEnvDir,
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    )

    // Check if Python environment and script exist
    if (!filesystem.existsSync(pythonExe) || !filesystem.existsSync(this.detectDevicesScript)) {
      this.appLogger.info('OpenVINO Python environment not available', this.name)
      return null
    }

    this.appLogger.info('Detecting OpenVINO devices using Python script', this.name)

    return new Promise((resolve, reject) => {
      const childProcess = spawn(pythonExe, [this.detectDevicesScript], {
        cwd: this.serviceDir,
        windowsHide: true,
        env: this.buildPythonDetectionEnv(),
      })

      let stdout = ''
      let stderr = ''

      childProcess.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      childProcess.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`Python device detection process error: ${error}`, this.name)
        reject(error)
      })

      childProcess.on('exit', (code: number | null) => {
        if (code === 0) {
          try {
            const result = JSON.parse(stdout.trim())
            if (result.success && Array.isArray(result.devices)) {
              this.appLogger.info(
                `Python detected devices: ${JSON.stringify(result.devices)}`,
                this.name,
              )
              resolve(result.devices)
            } else {
              this.appLogger.warn(`Python script returned error: ${result.error}`, this.name)
              reject(new Error(result.error || 'Unknown error'))
            }
          } catch (parseError) {
            this.appLogger.error(`Failed to parse Python output: ${stdout}`, this.name)
            reject(parseError)
          }
        } else {
          this.appLogger.warn(
            `Python device detection exited with code ${code}: ${stderr}`,
            this.name,
          )
          reject(new Error(`Process exited with code ${code}`))
        }
      })

      // Timeout after 30 seconds (OpenVINO initialization can be slow)
      setTimeout(() => {
        childProcess.kill('SIGTERM')
        reject(new Error('Python device detection timed out'))
      }, 30000)
    })
  }

  /**
   * Detect devices using OVMS executable (fallback method).
   * Returns array of {id, name} objects with generic names.
   */
  private async detectDevicesWithOvms(): Promise<{ id: string; name: string }[]> {
    this.appLogger.info('Detecting OpenVINO devices using ovms.exe', this.name)

    // Get a temporary port for device detection
    const tempPort = await getPort({ port: portNumbers(57300, 57399) })
    const extraLibPaths = await this.resolveOvmsExtraLibPaths()

    const detectedDeviceIds = await new Promise<string[]>((resolve, reject) => {
      const args = ['--config_path', '.', '--rest_port', tempPort.toString()]

      this.appLogger.info(
        `Running device detection: ${this.ovmsExePath} ${args.join(' ')}`,
        this.name,
      )

      const childProcess = spawn(this.ovmsExePath, args, {
        cwd: this.ovmsDir,
        windowsHide: true,
        env: this.buildOvmsEnv(extraLibPaths),
      })

      let resolved = false
      const devicePattern = /Available devices for Open VINO:\s*(.+)/

      const parseOutput = (data: string) => {
        if (resolved) return

        const lines = data.split('\n')
        for (const line of lines) {
          const match = line.match(devicePattern)
          if (match && match[1]) {
            resolved = true
            const devices = match[1]
              .split(',')
              .map((d) => d.trim())
              .filter((d) => d.length > 0)
            this.appLogger.info(`Detected OpenVINO devices: ${devices.join(', ')}`, this.name)

            // Kill the process since we have what we need
            childProcess.kill('SIGTERM')
            resolve(devices)
            return
          }
        }
      }

      childProcess.stdout?.on('data', (data: Buffer) => parseOutput(data.toString()))
      childProcess.stderr?.on('data', (data: Buffer) => parseOutput(data.toString()))

      childProcess.on('error', (error: Error) => {
        if (!resolved) {
          resolved = true
          this.appLogger.error(`Device detection process error: ${error}`, this.name)
          reject(error)
        }
      })

      childProcess.on('exit', (code: number | null) => {
        if (!resolved) {
          resolved = true
          this.appLogger.warn(
            `Device detection process exited with code ${code} before finding devices`,
            this.name,
          )
          reject(new Error(`Process exited with code ${code} before detecting devices`))
        }
      })

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!resolved) {
          resolved = true
          this.appLogger.warn('Device detection timed out after 10 seconds', this.name)
          childProcess.kill('SIGTERM')
          reject(new Error('Device detection timed out'))
        }
      }, 10000)
    })

    // Map detected devices to {id, name} format with generic names
    const deviceNameMap: Record<string, string> = {
      CPU: 'CPU',
      GPU: 'GPU (Intel)',
      NPU: 'NPU (Intel)',
    }

    return detectedDeviceIds.map((deviceId) => ({
      id: deviceId,
      name: deviceNameMap[deviceId] || deviceId,
    }))
  }

  /**
   * Apply detected devices to the service state.
   */
  private applyDetectedDevices(devices: { id: string; name: string }[]): void {
    const mappedDevices: InferenceDevice[] = devices.map((device) => ({
      id: device.id,
      name: device.name,
      selected: false,
    }))

    // Create base device list with AUTO option
    const baseDevices: InferenceDevice[] = [
      { id: 'AUTO', name: 'Auto select device', selected: false },
      ...mappedDevices,
    ]

    // Helper function to select device by priority
    const selectByPriority = (
      deviceList: InferenceDevice[],
      priority: string[],
    ): InferenceDevice[] => {
      const result = deviceList.map((d) => ({ ...d, selected: false }))
      // Match by id prefix (e.g., 'GPU' matches 'GPU.0', 'GPU.1', etc.)
      const selectedDevice = priority
        .map((id) => result.find((d) => d.id === id || d.id.startsWith(`${id}.`)))
        .find((d) => d !== undefined)
      if (selectedDevice) {
        selectedDevice.selected = true
      } else {
        result[0].selected = true // Fallback to AUTO
      }
      return result
    }

    // LLM devices: priority GPU > AUTO
    this.devices = selectByPriority(baseDevices, ['GPU'])

    // STT devices: priority NPU > CPU > GPU > AUTO
    this.sttDevices = selectByPriority(
      baseDevices.map((d) => ({ ...d })),
      ['NPU', 'CPU', 'GPU'],
    )

    this.appLogger.info(
      `Available LLM devices: ${JSON.stringify(this.devices, null, 2)}`,
      this.name,
    )
    this.appLogger.info(
      `Available STT devices: ${JSON.stringify(this.sttDevices, null, 2)}`,
      this.name,
    )
  }

  get_info(): ApiServiceInformation {
    if (this.currentStatus === 'uninitializedStatus') {
      this.currentStatus = this.isSetUp ? 'notYetStarted' : 'notInstalled'
    }
    return {
      serviceName: this.name,
      status: this.currentStatus,
      baseUrl: this.baseUrl,
      port: this.port,
      isSetUp: this.isSetUp,
      isRequired: this.isRequired,
      devices: this.devices,
      sttDevices: this.sttDevices,
      errorDetails: this.lastStartupErrorDetails,
      installedVersion: this.cachedInstalledVersion,
    }
  }

  setStatus(status: BackendStatus) {
    this.currentStatus = status
    this.updateStatus()
  }

  updateStatus() {
    this.win.webContents.send('serviceInfoUpdate', this.get_info())
  }

  async updateSettings(settings: ServiceSettings): Promise<void> {
    if (settings.releaseTag !== undefined) {
      this.releaseTag = settings.releaseTag || undefined
      this.appLogger.info(
        `applied new OpenVINO Model Server release tag ${this.releaseTag ?? '(none)'}`,
        this.name,
      )
    }
    if (settings.version) {
      this.version = settings.version
      this.appLogger.info(`applied new OpenVINO Model Server version ${this.version}`, this.name)
    }
  }

  async getInstalledVersion(): Promise<{ version?: string; releaseTag?: string } | undefined> {
    if (!this.isSetUp) return undefined
    try {
      const extraLibPaths = await this.resolveOvmsExtraLibPaths()
      const result = await execAsync(`"${this.ovmsExePath}" --version`, {
        timeout: 5000,
        env: {
          ...process.env,
          // On Linux, OVMS shared libs (libtbb, libopenvino, ...) live in ovmsDir/lib
          // and libpython3.12 comes from the managed CPython installation.
          ...(process.platform !== 'win32' && {
            LD_LIBRARY_PATH: [
              path.join(this.ovmsDir, 'lib'),
              ...extraLibPaths,
              process.env.LD_LIBRARY_PATH ?? '',
            ]
              .filter(Boolean)
              .join(':'),
          }),
        },
      })
      // Parse output like "OpenVINO backend 2025.4.0.0rc3"
      const versionMatch = result.stdout.match(/OpenVINO backend\s+([\d.]+(?:rc\d+)?)/)
      if (versionMatch && versionMatch[1]) {
        return { version: versionMatch[1] }
      }
    } catch (e) {
      this.appLogger.error(`failed to get installed OpenVINO version: ${e}`, this.name)
    }
    return undefined
  }

  /**
   * Updates the cached installed version for inclusion in service info updates.
   */
  private async updateCachedVersion(): Promise<void> {
    try {
      const version = await this.getInstalledVersion()
      if (version && version.version) {
        this.cachedInstalledVersion = {
          version: version.version,
          ...(version.releaseTag && { releaseTag: version.releaseTag }),
        }
      } else {
        this.cachedInstalledVersion = undefined
      }
    } catch (error) {
      this.appLogger.warn(`Failed to get installed version: ${error}`, this.name)
      this.cachedInstalledVersion = undefined
    }
  }

  async *set_up(): AsyncIterable<SetupProgress> {
    this.setStatus('installing')
    this.appLogger.info('setting up service', this.name)

    let currentStep = 'start'

    try {
      currentStep = 'start'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'starting to set up OpenVINO Model Server',
      }

      // Create service directory if it doesn't exist
      if (!filesystem.existsSync(this.serviceDir)) {
        filesystem.mkdirSync(this.serviceDir, { recursive: true })
      }

      currentStep = 'download'
      if (process.platform === 'linux') {
        currentStep = 'linux dependencies'
        yield {
          serviceName: this.name,
          step: currentStep,
          status: 'executing',
          debugMessage: 'checking and installing Ubuntu runtime dependencies for OpenVINO',
        }

        await this.ensureLinuxRuntimeDependencies()

        yield {
          serviceName: this.name,
          step: currentStep,
          status: 'executing',
          debugMessage: 'linux dependency check complete',
        }
      }

      currentStep = 'download'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `downloading OpenVINO Model Server`,
      }

      await this.downloadOvms()

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'download complete',
      }

      // Extract OVMS ZIP file
      currentStep = 'extract'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'extracting OpenVINO Model Server',
      }

      await this.extractOvms()

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'extraction complete',
      }

      // Install OpenVINO Python environment for device detection
      currentStep = 'install python'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'installing OpenVINO Python environment for device detection',
      }

      try {
        await installBackend('OpenVINO')
        this.appLogger.info('OpenVINO Python environment installed successfully', this.name)
      } catch (pythonError) {
        // Log but don't fail - device detection will fall back to OVMS-based detection
        this.appLogger.warn(
          `Failed to install OpenVINO Python environment: ${pythonError}. Device detection will use fallback method.`,
          this.name,
        )
      }

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'python environment setup complete',
      }

      this.isSetUp = true
      await this.updateCachedVersion()
      this.setStatus('notYetStarted')

      currentStep = 'end'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'success',
        debugMessage: 'service set up completely',
      }
    } catch (e) {
      this.appLogger.warn(`Set up of service failed due to ${e}`, this.name, true)
      this.setStatus('installationFailed')

      const errorDetails = await createEnhancedErrorDetails(e, `${currentStep} operation`)

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'failed',
        debugMessage: `Failed to setup OpenVINO Model Server due to ${e}`,
        errorDetails,
      }
    }
  }

  private async downloadOvms(): Promise<void> {
    // Build an ordered list of candidate URLs to try, most-specific first.
    //
    // Windows – uses the OpenVINO toolkit storage (zip, no version in filename).
    // Linux   – GitHub Releases are canonical; toolkit storage is a fallback.
    //   GitHub/storage asset names embed the full version, e.g.:
    //     ovms_ubuntu24_2026.1.0_python_on.tar.gz
    //   On Ubuntu 26+ we try ubuntu26 builds first, falling back to ubuntu24.
    const candidates: string[] = []
    const storageBaseUrl =
      'https://storage.openvinotoolkit.org/repositories/openvino_model_server/packages'

    if (process.platform === 'win32') {
      const versionPath = this.releaseTag
        ? `weekly/${this.version}.${this.releaseTag}`
        : this.version
      candidates.push(`${storageBaseUrl}/${versionPath}/ovms_windows_python_on.zip`)
    } else {
      // Detect the host Ubuntu version to pick the best OVMS build.
      // Try the exact distro match first, then fall back to older builds.
      const distros = await this.getOvmsDistroTargets()
      this.appLogger.info(
        `OVMS distro download targets (in priority order): ${distros.join(', ')}`,
        this.name,
      )

      for (const distro of distros) {
        const pkg = `ovms_${distro}_${this.version}_python_on.tar.gz`

        // 1. GitHub Releases (most reliable for versioned packages)
        candidates.push(
          `https://github.com/openvinotoolkit/model_server/releases/download/v${this.version}/${pkg}`,
        )
        // 2. OpenVINO toolkit storage – weekly build
        if (this.releaseTag) {
          candidates.push(`${storageBaseUrl}/weekly/${this.version}.${this.releaseTag}/${pkg}`)
        }
        // 3. OpenVINO toolkit storage – stable
        candidates.push(`${storageBaseUrl}/${this.version}/${pkg}`)
      }
    }

    let response: Awaited<ReturnType<typeof net.fetch>> | undefined
    let downloadUrl = ''
    for (const url of candidates) {
      this.appLogger.info(`Trying OVMS download URL: ${url}`, this.name)
      const res = await net.fetch(url)
      const contentType = res.headers.get('content-type') ?? ''
      // Reject HTML responses (they indicate a 404/index page, not a real archive)
      if (res.ok && res.status === 200 && res.body && !contentType.includes('text/html')) {
        response = res
        downloadUrl = url
        break
      }
      this.appLogger.info(
        `URL ${url} returned ${res.status} / content-type: ${contentType} — skipping`,
        this.name,
      )
    }

    if (!response || !response.body) {
      throw new Error(
        `Failed to download OVMS: no valid download URL found. Tried: ${candidates.join(', ')}`,
      )
    }

    this.appLogger.info(`Downloading OVMS from ${downloadUrl}`, this.name)

    // Delete existing zip if it exists
    if (filesystem.existsSync(this.zipPath)) {
      this.appLogger.info(`Removing existing OVMS zip file`, this.name)
      filesystem.removeSync(this.zipPath)
    }

    const buffer = await response.arrayBuffer()
    await filesystem.writeFile(this.zipPath, Buffer.from(buffer))

    this.appLogger.info(`OVMS zip file downloaded successfully`, this.name)
  }

  /**
   * Determine the ordered list of OVMS distro build targets to try downloading.
   *
   * Reads /etc/os-release to detect the host Ubuntu version and returns targets
   * in priority order — exact match first, then older compatible builds as fallback.
   *
   * For example, on Ubuntu 26.04 this returns ['ubuntu26', 'ubuntu24'] so we try
   * the native build first and fall back to the Ubuntu 24 build if unavailable.
   */
  private async getOvmsDistroTargets(): Promise<string[]> {
    try {
      const osRelease = await filesystem.readFile('/etc/os-release', 'utf-8')
      const versionIdMatch = osRelease.match(/^VERSION_ID="?(\d+)(?:\.\d+)?"?/m)
      if (versionIdMatch?.[1]) {
        const majorVersion = parseInt(versionIdMatch[1], 10)
        this.appLogger.info(`Detected Ubuntu version: ${majorVersion}`, this.name)

        if (majorVersion >= 26) {
          // Try native ubuntu26 build first, fall back to ubuntu24
          return ['ubuntu26', 'ubuntu24']
        }
        if (majorVersion >= 24) {
          return ['ubuntu24']
        }
        // Older Ubuntu — try ubuntu24 anyway (best effort)
        return ['ubuntu24']
      }
    } catch (e) {
      this.appLogger.warn(`Failed to detect Ubuntu version from /etc/os-release: ${e}`, this.name)
    }

    // Fallback: just try ubuntu24
    return ['ubuntu24']
  }

  private async extractOvms(): Promise<void> {
    this.appLogger.info(`Extracting OVMS to ${this.ovmsDir}`, this.name)

    // Delete existing ovms directory if it exists
    if (filesystem.existsSync(this.ovmsDir)) {
      this.appLogger.info(`Removing existing OVMS directory`, this.name)
      filesystem.removeSync(this.ovmsDir)
    }

    // Create ovms directory
    filesystem.mkdirSync(this.ovmsDir, { recursive: true })

    // Extract archive using the cross-platform extract helper
    // (PowerShell Expand-Archive on Windows, `tar -xf` on Linux/macOS).
    try {
      await extract(this.zipPath, this.ovmsDir)

      this.appLogger.info(`OVMS extracted successfully`, this.name)

      // Check if there's only a single top-level folder and move its contents up
      const items = filesystem.readdirSync(this.ovmsDir)
      if (items.length === 1) {
        const singleItem = path.join(this.ovmsDir, items[0])
        const stats = filesystem.statSync(singleItem)

        if (stats.isDirectory()) {
          this.appLogger.info(
            `Found single top-level folder '${items[0]}', moving contents up`,
            this.name,
          )

          // Move contents to temp directory first
          const tempDir = path.join(this.serviceDir, 'ovms-temp')
          filesystem.moveSync(singleItem, tempDir)

          // Remove the now-empty ovms directory
          filesystem.removeSync(this.ovmsDir)

          // Rename temp directory to ovms
          filesystem.moveSync(tempDir, this.ovmsDir)

          this.appLogger.info(`Moved contents of '${items[0]}' up to ovms directory`, this.name)
        }
      }

      // On Linux the tar.gz may not preserve the executable bit on the binary.
      // Done after the folder-flattening above so ovmsExePath resolves correctly.
      if (process.platform !== 'win32' && filesystem.existsSync(this.ovmsExePath)) {
        await filesystem.chmod(this.ovmsExePath, 0o755)
        this.appLogger.info(`Made ovms binary executable`, this.name)
      }
    } catch (error) {
      this.appLogger.error(`Failed to extract OVMS: ${error}`, this.name)
      throw error
    }
  }

  async start(): Promise<BackendStatus> {
    if (this.settings.productMode === 'nvidia') {
      this.appLogger.info('Skipping OpenVINO start in NVIDIA mode', this.name)
      return this.currentStatus
    }

    // In this architecture, model server is started on-demand via ensureBackendReadiness
    // This method is kept for ApiService interface compatibility
    if (this.currentStatus === 'running') {
      this.clearLastStartupError()
      return 'running'
    }

    this.appLogger.info(`${this.name} service ready - model server will start on-demand`, this.name)
    this.desiredStatus = 'running'
    this.currentStatus = 'running'
    this.clearLastStartupError()
    this.updateStatus()
    return 'running'
  }

  async stop(): Promise<BackendStatus> {
    this.appLogger.info(
      `Stopping backend ${this.name}. It was in state ${this.currentStatus}`,
      this.name,
    )
    this.desiredStatus = 'stopped'
    this.setStatus('stopping')

    // Stop all model servers
    await this.stopOvmsLlmServer()
    await this.stopOvmsEmbeddingServer()
    await this.stopOvmsTranscriptionServer()
    await this.stopOvmsImageServer()

    this.setStatus('stopped')
    return 'stopped'
  }

  /**
   * Get the embedding server URL if an embedding server is running
   * @returns The embedding server base URL, or null if no embedding server is running
   */
  getEmbeddingServerUrl(): string | null {
    if (this.ovmsEmbeddingProcess?.isReady) {
      return `http://127.0.0.1:${this.ovmsEmbeddingProcess.port}/v3`
    }
    return null
  }

  /**
   * Get the transcription server URL if a transcription server is running
   * @returns The transcription server base URL, or null if no transcription server is running
   */
  getTranscriptionServerUrl(): string | null {
    if (this.ovmsTranscriptionProcess?.isReady) {
      return `http://127.0.0.1:${this.ovmsTranscriptionProcess.port}/v3`
    }
    return null
  }

  /**
   * Start transcription server independently
   * @param modelName - The transcription model name (e.g., 'OpenVINO/whisper-large-v3-int4-ov')
   */
  async startTranscriptionServer(modelName: string): Promise<void> {
    try {
      if (process.platform === 'linux') {
        await this.ensureLinuxRuntimeDependenciesForStartup()
      }

      this.appLogger.info(`Starting transcription server for model: ${modelName}`, this.name)

      // Check if already running with the same model
      if (this.ovmsTranscriptionProcess?.isReady && this.currentTranscriptionModel === modelName) {
        this.appLogger.info(
          `Transcription server already running with model: ${modelName}`,
          this.name,
        )
        return
      }

      // Stop existing server if running different model
      if (this.ovmsTranscriptionProcess) {
        await this.stopOvmsTranscriptionServer()
      }

      // Start new server
      await this.startOvmsTranscriptionServer(modelName)
      this.appLogger.info(
        `Transcription server started successfully for model: ${modelName}`,
        this.name,
      )
    } catch (error) {
      this.appLogger.error(
        `Failed to start transcription server for model ${modelName}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  /**
   * Stop transcription server independently
   */
  async stopTranscriptionServer(): Promise<void> {
    try {
      this.appLogger.info('Stopping transcription server', this.name)
      await this.stopOvmsTranscriptionServer()
      this.appLogger.info('Transcription server stopped successfully', this.name)
    } catch (error) {
      this.appLogger.error(`Failed to stop transcription server: ${error}`, this.name)
      throw error
    }
  }

  /**
   * Get the image generation server URL if an image server is running
   */
  getImageServerUrl(): string | null {
    if (this.ovmsImageProcess?.isReady) {
      return `http://127.0.0.1:${this.ovmsImageProcess.port}/v3`
    }
    return null
  }

  /**
   * Start image generation server, optionally stopping the LLM server first to free GPU memory.
   * @param modelName - HuggingFace repo id (e.g. 'OpenVINO/LCM_Dreamshaper_v7-int8-ov')
   * @param keepModelsLoaded - If true, don't stop the LLM server before starting image server
   * @param resolution - Optional resolution in WxH format (e.g. '512x512'). When the selected
   *   device is NPU the pipeline must be reshaped to a static shape, so this value is required
   *   for NPU and is passed via OVMS `--resolution`. Ignored on non-NPU devices.
   */
  async startImageServer(
    modelName: string,
    keepModelsLoaded?: boolean,
    resolution?: string,
  ): Promise<void> {
    try {
      if (process.platform === 'linux') {
        await this.ensureLinuxRuntimeDependenciesForStartup()
      }

      const selectedDevice = this.devices.find((d) => d.selected)?.id || 'AUTO'
      const isNpu = selectedDevice.startsWith('NPU')
      // Resolution only matters for NPU; ignore it on other devices so the model server
      // keeps a dynamic pipeline and accepts whatever resolution the client asks for.
      const effectiveResolution = isNpu ? resolution : undefined

      this.appLogger.info(
        `Starting image server for model: ${modelName}` +
          (effectiveResolution ? ` (NPU resolution: ${effectiveResolution})` : ''),
        this.name,
      )

      if (
        this.ovmsImageProcess?.isReady &&
        this.currentImageModel === modelName &&
        this.currentImageResolution === (effectiveResolution ?? null)
      ) {
        this.appLogger.info(`Image server already running with model: ${modelName}`, this.name)
        return
      }

      if (this.ovmsImageProcess) {
        await this.stopOvmsImageServer()
      }

      if (!keepModelsLoaded) {
        this.appLogger.info(
          'Stopping LLM server to free GPU memory for image generation',
          this.name,
        )
        await this.stopOvmsLlmServer()
      }

      await this.startOvmsImageServer(modelName, effectiveResolution)
      this.appLogger.info(`Image server started successfully for model: ${modelName}`, this.name)
    } catch (error) {
      this.appLogger.error(
        `Failed to start image server for model ${modelName}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  /**
   * Stop image generation server independently
   */
  async stopImageServer(): Promise<void> {
    try {
      this.appLogger.info('Stopping image server', this.name)
      await this.stopOvmsImageServer()
      this.appLogger.info('Image server stopped successfully', this.name)
    } catch (error) {
      this.appLogger.error(`Failed to stop image server: ${error}`, this.name)
      throw error
    }
  }

  // Model server management methods
  private async startOvmsLlmServer(
    modelRepoId: string,
    contextSize?: number,
  ): Promise<OvmsServerProcess> {
    try {
      const selectedDevice = this.devices.find((d) => d.selected)?.id || 'AUTO'
      const maxPromptLen = contextSize ?? 8192

      this.appLogger.info(
        `Starting OVMS server for model: ${modelRepoId} on port ${this.port} with device ${selectedDevice}`,
        this.name,
      )

      const args = [
        '--rest_bind_address',
        '127.0.0.1',
        '--rest_port',
        this.port.toString(),
        '--rest_workers',
        '4',
        '--source_model',
        modelRepoId.split('/').join('---'),
        '--model_repository_path',
        path.resolve(path.join(this.baseDir, 'models', 'LLM', 'openvino')),
        '--target_device',
        selectedDevice,
        '--cache_size',
        '2',
        '--task',
        'text_generation',
        '--tool_parser',
        'hermes3',
        '--reasoning_parser',
        'qwen3',
        '--cache_dir',
        'cache',
      ]

      if (selectedDevice.startsWith('NPU')) {
        args.push('--max_prompt_len', maxPromptLen.toString())
      }

      this.appLogger.info(`OVMS launch args: ${args.join(' ')}`, this.name)

      const extraLibPaths = await this.resolveOvmsExtraLibPaths()
      const ovmsEnv = this.buildOvmsEnv(extraLibPaths)

      const childProcess = spawn(this.ovmsExePath, args, {
        cwd: this.ovmsDir,
        windowsHide: true,
        env: ovmsEnv,
      })

      const healthUrl = `http://127.0.0.1:${this.port}/v2/health/ready`
      const ovmsProcess: OvmsServerProcess = {
        process: childProcess,
        port: this.port,
        modelRepoId,
        type: 'llm',
        contextSize,
        isReady: false,
        healthEndpointUrl: healthUrl,
      }

      // Set up process event handlers
      childProcess.stdout!.on('data', (message) => {
        this.appLogger.info(`[OVMS LLM] ${message}`, this.name)
      })

      childProcess.stderr!.on('data', (message) => {
        this.appLogger.error(`[OVMS LLM] ${message}`, this.name)
      })

      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`OVMS LLM server process error: ${error}`, this.name)
      })

      childProcess.on('exit', (code: number | null, signal: string | null) => {
        const exitReason = signal
          ? `signal ${signal}${signal === 'SIGSEGV' ? ' (segmentation fault — possible ABI incompatibility or OOM)' : signal === 'SIGKILL' ? ' (killed — likely OOM killer)' : ''}`
          : `code ${code}`
        this.appLogger.info(`OVMS LLM server process exited with ${exitReason}`, this.name)
        if (this.ovmsLlmProcess === ovmsProcess) {
          this.ovmsLlmProcess = null
          this.currentModel = null
          this.currentContextSize = null
        }
      })

      // Wait for server to be ready
      await this.waitForServerReady(healthUrl, childProcess)
      ovmsProcess.isReady = true

      this.ovmsLlmProcess = ovmsProcess
      this.currentModel = modelRepoId
      this.currentContextSize = contextSize ?? null

      this.appLogger.info(`OVMS LLM server ready for model: ${modelRepoId}`, this.name)
      return ovmsProcess
    } catch (error) {
      this.appLogger.error(
        `Failed to start OVMS server for model ${modelRepoId}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  private async stopOvmsLlmServer(): Promise<void> {
    if (this.ovmsLlmProcess) {
      this.appLogger.info(`Stopping OVMS LLM server for model: ${this.currentModel}`, this.name)
      this.ovmsLlmProcess.process.kill('SIGTERM')

      // Wait a bit for graceful shutdown, then force kill if needed
      await new Promise<void>((resolve) => {
        const currentProcess = this.ovmsLlmProcess
        const timeout = setTimeout(() => {
          if (currentProcess) {
            this.appLogger.warn(`Force killing OVMS LLM server process`, this.name)
            currentProcess.process.kill('SIGKILL')
          }
          resolve()
        }, 5000)

        if (currentProcess) {
          currentProcess.process.on('exit', () => {
            clearTimeout(timeout)
            resolve()
          })
        } else {
          clearTimeout(timeout)
          resolve()
        }
      })

      this.ovmsLlmProcess = null
      this.currentModel = null
      this.currentContextSize = null
    }
  }

  private async startOvmsEmbeddingServer(modelRepoId: string): Promise<OvmsServerProcess> {
    try {
      const selectedDevice = this.devices.find((d) => d.selected)?.id || 'AUTO'
      const port = await getPort({ port: portNumbers(29100, 29199) })
      // Validate model path exists
      this.resolveEmbeddingModelPath(modelRepoId)

      this.appLogger.info(
        `Starting OVMS embedding server for model: ${modelRepoId} on port ${port} with device ${selectedDevice}`,
        this.name,
      )

      const args = [
        '--rest_bind_address',
        '127.0.0.1',
        '--rest_port',
        port.toString(),
        '--rest_workers',
        '4',
        '--source_model',
        modelRepoId.split('/').join('---'),
        '--model_repository_path',
        path.resolve(path.join(this.baseDir, 'models', 'LLM', 'embedding', 'openVINO')),
        '--target_device',
        selectedDevice,
        '--task',
        'embeddings',
        '--pooling',
        'CLS',
        '--cache_dir',
        'cache',
      ]

      this.appLogger.info(`OVMS embedding launch args: ${args.join(' ')}`, this.name)

      const extraLibPaths = await this.resolveOvmsExtraLibPaths()
      const childProcess = spawn(this.ovmsExePath, args, {
        cwd: this.ovmsDir,
        windowsHide: true,
        env: this.buildOvmsEnv(extraLibPaths),
      })

      const healthUrl = `http://127.0.0.1:${port}/v2/health/ready`
      const ovmsProcess: OvmsServerProcess = {
        process: childProcess,
        port,
        modelRepoId,
        type: 'embedding',
        isReady: false,
        healthEndpointUrl: healthUrl,
      }

      // Set up process event handlers
      childProcess.stdout!.on('data', (message) => {
        this.appLogger.info(`[OVMS Embedding] ${message}`, this.name)
      })

      childProcess.stderr!.on('data', (message) => {
        this.appLogger.error(`[OVMS Embedding] ${message}`, this.name)
      })

      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`OVMS embedding server process error: ${error}`, this.name)
      })

      childProcess.on('exit', (code: number | null) => {
        this.appLogger.info(`OVMS embedding server process exited with code: ${code}`, this.name)
        if (this.ovmsEmbeddingProcess === ovmsProcess) {
          this.ovmsEmbeddingProcess = null
          this.currentEmbeddingModel = null
        }
      })

      // Wait for server to be ready
      await this.waitForServerReady(healthUrl, childProcess)
      ovmsProcess.isReady = true

      this.ovmsEmbeddingProcess = ovmsProcess
      this.currentEmbeddingModel = modelRepoId

      this.appLogger.info(`OVMS embedding server ready for model: ${modelRepoId}`, this.name)
      return ovmsProcess
    } catch (error) {
      this.appLogger.error(
        `Failed to start OVMS embedding server for model ${modelRepoId}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  private async stopOvmsEmbeddingServer(): Promise<void> {
    if (this.ovmsEmbeddingProcess) {
      this.appLogger.info(
        `Stopping OVMS embedding server for model: ${this.currentEmbeddingModel}`,
        this.name,
      )
      this.ovmsEmbeddingProcess.process.kill('SIGTERM')

      // Wait a bit for graceful shutdown, then force kill if needed
      await new Promise<void>((resolve) => {
        const currentProcess = this.ovmsEmbeddingProcess
        const timeout = setTimeout(() => {
          if (currentProcess) {
            this.appLogger.warn(`Force killing OVMS embedding server process`, this.name)
            currentProcess.process.kill('SIGKILL')
          }
          resolve()
        }, 5000)

        if (currentProcess) {
          currentProcess.process.on('exit', () => {
            clearTimeout(timeout)
            resolve()
          })
        } else {
          clearTimeout(timeout)
          resolve()
        }
      })

      this.ovmsEmbeddingProcess = null
      this.currentEmbeddingModel = null
    }
  }

  private async startOvmsTranscriptionServer(modelRepoId: string): Promise<OvmsServerProcess> {
    try {
      const selectedDevice = this.sttDevices.find((d) => d.selected)?.id || 'AUTO'
      const port = await getPort({ port: portNumbers(29200, 29299) })
      // Validate model path exists
      this.resolveTranscriptionModelPath(modelRepoId)
      const modelName = modelRepoId.split('/').join('---')

      this.appLogger.info(
        `Starting OVMS transcription server for model: ${modelRepoId} on port ${port} with device ${selectedDevice}`,
        this.name,
      )

      const args = [
        '--rest_bind_address',
        '127.0.0.1',
        '--rest_port',
        port.toString(),
        '--rest_workers',
        '2',
        '--source_model',
        modelName,
        '--model_repository_path',
        path.resolve(path.join(this.baseDir, 'models', 'STT')),
        '--model_name',
        modelName,
        '--target_device',
        selectedDevice,
        // '--cache_size',
        // '2',
        '--task',
        'speech2text',
        '--cache_dir',
        'cache',
      ]

      this.appLogger.info(`OVMS transcription launch args: ${args.join(' ')}`, this.name)

      const extraLibPaths = await this.resolveOvmsExtraLibPaths()
      const childProcess = spawn(this.ovmsExePath, args, {
        cwd: this.ovmsDir,
        windowsHide: true,
        env: this.buildOvmsEnv(extraLibPaths),
      })

      const healthUrl = `http://127.0.0.1:${port}/v2/health/ready`
      const ovmsProcess: OvmsServerProcess = {
        process: childProcess,
        port,
        modelRepoId,
        type: 'transcription',
        isReady: false,
        healthEndpointUrl: healthUrl,
      }

      // Set up process event handlers
      childProcess.stdout!.on('data', (message) => {
        this.appLogger.info(`[OVMS Transcription] ${message}`, this.name)
      })

      childProcess.stderr!.on('data', (message) => {
        this.appLogger.error(`[OVMS Transcription] ${message}`, this.name)
      })

      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`OVMS transcription server process error: ${error}`, this.name)
      })

      childProcess.on('exit', (code: number | null) => {
        this.appLogger.info(
          `OVMS transcription server process exited with code: ${code}`,
          this.name,
        )
        if (this.ovmsTranscriptionProcess === ovmsProcess) {
          this.ovmsTranscriptionProcess = null
          this.currentTranscriptionModel = null
        }
      })

      // Wait for server to be ready
      await this.waitForServerReady(healthUrl, childProcess, 600)
      ovmsProcess.isReady = true

      this.ovmsTranscriptionProcess = ovmsProcess
      this.currentTranscriptionModel = modelRepoId

      this.appLogger.info(`OVMS transcription server ready for model: ${modelRepoId}`, this.name)
      return ovmsProcess
    } catch (error) {
      this.appLogger.error(
        `Failed to start OVMS transcription server for model ${modelRepoId}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  private async stopOvmsTranscriptionServer(): Promise<void> {
    if (this.ovmsTranscriptionProcess) {
      this.appLogger.info(
        `Stopping OVMS transcription server for model: ${this.currentTranscriptionModel}`,
        this.name,
      )
      this.ovmsTranscriptionProcess.process.kill('SIGTERM')

      // Wait a bit for graceful shutdown, then force kill if needed
      await new Promise<void>((resolve) => {
        const currentProcess = this.ovmsTranscriptionProcess
        const timeout = setTimeout(() => {
          if (currentProcess) {
            this.appLogger.warn(`Force killing OVMS transcription server process`, this.name)
            currentProcess.process.kill('SIGKILL')
          }
          resolve()
        }, 5000)

        if (currentProcess) {
          currentProcess.process.on('exit', () => {
            clearTimeout(timeout)
            resolve()
          })
        } else {
          clearTimeout(timeout)
          resolve()
        }
      })

      this.ovmsTranscriptionProcess = null
      this.currentTranscriptionModel = null
    }
  }

  private async startOvmsImageServer(
    modelRepoId: string,
    resolution?: string,
  ): Promise<OvmsServerProcess> {
    try {
      const selectedDevice = this.devices.find((d) => d.selected)?.id || 'AUTO'
      const port = await getPort({ port: portNumbers(29300, 29399) })

      this.appLogger.info(
        `Starting OVMS image server for model: ${modelRepoId} on port ${port} with device ${selectedDevice}`,
        this.name,
      )

      const args = [
        '--rest_bind_address',
        '127.0.0.1',
        '--rest_port',
        port.toString(),
        '--source_model',
        modelRepoId.split('/').join('---'),
        '--model_repository_path',
        path.resolve(path.join(this.baseDir, 'models', 'openvino-image')),
        '--target_device',
        selectedDevice,
        '--task',
        'image_generation',
        '--cache_dir',
        'cache',
      ]

      // NPU requires the image generation pipeline to be reshaped to a static shape.
      // See: https://docs.openvino.ai/2025/model-server/ovms_docs_parameters.html#image-generation
      if (selectedDevice.startsWith('NPU')) {
        if (!resolution) {
          throw new Error(
            'OVMS image generation on NPU requires a static resolution but none was provided',
          )
        }
        args.push('--resolution', resolution)
      }

      this.appLogger.info(`OVMS image launch args: ${args.join(' ')}`, this.name)

      const extraLibPaths = await this.resolveOvmsExtraLibPaths()
      const childProcess = spawn(this.ovmsExePath, args, {
        cwd: this.ovmsDir,
        windowsHide: true,
        env: this.buildOvmsEnv(extraLibPaths),
      })

      const healthUrl = `http://127.0.0.1:${port}/v2/health/ready`
      const ovmsProcess: OvmsServerProcess = {
        process: childProcess,
        port,
        modelRepoId,
        type: 'image_generation',
        isReady: false,
        healthEndpointUrl: healthUrl,
      }

      childProcess.stdout!.on('data', (message) => {
        this.appLogger.info(`[OVMS Image] ${message}`, this.name)
      })

      childProcess.stderr!.on('data', (message) => {
        this.appLogger.error(`[OVMS Image] ${message}`, this.name)
      })

      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`OVMS image server process error: ${error}`, this.name)
      })

      childProcess.on('exit', (code: number | null) => {
        this.appLogger.info(`OVMS image server process exited with code: ${code}`, this.name)
        if (this.ovmsImageProcess === ovmsProcess) {
          this.ovmsImageProcess = null
          this.currentImageModel = null
          this.currentImageResolution = null
        }
      })

      // Image model loading can be slow — use high maxAttempts
      await this.waitForServerReady(healthUrl, childProcess, 600)
      ovmsProcess.isReady = true

      this.ovmsImageProcess = ovmsProcess
      this.currentImageModel = modelRepoId
      this.currentImageResolution = resolution ?? null

      this.appLogger.info(`OVMS image server ready for model: ${modelRepoId}`, this.name)
      return ovmsProcess
    } catch (error) {
      this.appLogger.error(
        `Failed to start OVMS image server for model ${modelRepoId}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  private async stopOvmsImageServer(): Promise<void> {
    if (this.ovmsImageProcess) {
      this.appLogger.info(
        `Stopping OVMS image server for model: ${this.currentImageModel}`,
        this.name,
      )
      this.ovmsImageProcess.process.kill('SIGTERM')

      await new Promise<void>((resolve) => {
        const currentProcess = this.ovmsImageProcess
        const timeout = setTimeout(() => {
          if (currentProcess) {
            this.appLogger.warn(`Force killing OVMS image server process`, this.name)
            currentProcess.process.kill('SIGKILL')
          }
          resolve()
        }, 5000)

        if (currentProcess) {
          currentProcess.process.on('exit', () => {
            clearTimeout(timeout)
            resolve()
          })
        } else {
          clearTimeout(timeout)
          resolve()
        }
      })

      this.ovmsImageProcess = null
      this.currentImageModel = null
      this.currentImageResolution = null
    }
  }

  private resolveEmbeddingModelPath(modelRepoId: string): string {
    // Use the same logic as the Python backend
    const modelBasePath = 'models/LLM/embedding/openVINO'
    const [namespace, repo, ...model] = modelRepoId.split('/')
    const modelDir = path.resolve(
      path.join(this.baseDir, modelBasePath, `${namespace}---${repo}`, model.join('/')),
    )

    if (!filesystem.existsSync(modelDir)) {
      throw new Error(`Embedding model directory not found: ${modelDir}`)
    }

    return modelDir
  }

  private resolveTranscriptionModelPath(modelRepoId: string): string {
    // Use the same logic as LLM models - transcription models are stored in the same location
    const modelBasePath = 'models/STT'
    const [namespace, repo, ...model] = modelRepoId.split('/')
    const modelDir = path.resolve(
      path.join(this.baseDir, modelBasePath, `${namespace}---${repo}`, model.join('/')),
    )

    if (!filesystem.existsSync(modelDir)) {
      throw new Error(`Transcription model directory not found: ${modelDir}`)
    }

    return modelDir
  }

  private async waitForServerReady(
    healthUrl: string,
    childProcess: ChildProcess,
    maxAttempts = 120,
  ): Promise<void> {
    const delayMs = 1000

    // Track whether the process has exited (process.killed only reflects
    // signals sent by Node.js — not OS-level kills like OOM or SIGSEGV).
    let processExited = false
    let exitCode: number | null = null
    let exitSignal: string | null = null
    const stderrChunks: string[] = []

    const onExit = (code: number | null, signal: string | null) => {
      processExited = true
      exitCode = code
      exitSignal = signal
    }
    childProcess.on('exit', onExit)
    childProcess.stderr?.on('data', (data: Buffer) => {
      stderrChunks.push(data.toString())
      // Keep only the last 20 lines of stderr for diagnostics
      if (stderrChunks.length > 20) stderrChunks.shift()
    })

    const buildExitErrorMessage = (): string => {
      const reason = exitSignal
        ? `killed by signal ${exitSignal}`
        : exitCode !== null
          ? `exit code ${exitCode}`
          : 'exit code null (killed by OS signal, possibly OOM)'
      const lastStderr = stderrChunks.join('').trim()
      const stderrSuffix = lastStderr ? `\nLast stderr output:\n${lastStderr.slice(-2000)}` : ''
      return `OVMS process crashed during startup (${reason})${stderrSuffix}`
    }

    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Check if process has exited (covers OS kills, crashes, OOM, etc.)
        if (processExited || childProcess.killed) {
          const msg = buildExitErrorMessage()
          this.appLogger.warn(
            `Process for ${this.name} is not alive, aborting health check: ${msg}`,
            this.name,
          )
          throw new Error(msg)
        }

        try {
          const response = await fetch(healthUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(1000),
          })

          if (response.ok) {
            if (processExited || childProcess.killed) {
              const msg = buildExitErrorMessage()
              this.appLogger.warn(
                `Process for ${this.name} exited after health check succeeded: ${msg}`,
                this.name,
              )
              throw new Error(msg)
            }
            this.appLogger.info(`Server ready at ${healthUrl}`, this.name)
            return
          }
        } catch (error) {
          // Re-throw our own errors (from the process-exit check above)
          if (error instanceof Error && error.message.startsWith('OVMS process crashed')) {
            throw error
          }
          // Server not ready yet — check if the process died while we were waiting
          if (processExited || childProcess.killed) {
            const msg = buildExitErrorMessage()
            this.appLogger.warn(
              `Process for ${this.name} exited during health check wait: ${msg}`,
              this.name,
            )
            throw new Error(msg)
          }
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }

      throw new Error(`Server failed to start within ${(maxAttempts * delayMs) / 1000} seconds`)
    } finally {
      childProcess.removeListener('exit', onExit)
    }
  }

  // Error management methods for startup failures
  setLastStartupError(errorDetails: ErrorDetails): void {
    this.lastStartupErrorDetails = errorDetails
  }

  getLastStartupError(): ErrorDetails | null {
    return this.lastStartupErrorDetails
  }

  clearLastStartupError(): void {
    this.lastStartupErrorDetails = null
  }

  async uninstall(): Promise<void> {
    await this.stop()
    this.appLogger.info(`removing OpenVINO Model Server directory`, this.name)
    await filesystem.remove(this.ovmsDir)
    this.appLogger.info(`removed OpenVINO Model Server directory`, this.name)
    this.setStatus('notInstalled')
    this.isSetUp = false
    // Clear startup errors when uninstalling
    this.clearLastStartupError()
    // Invalidate cached lib paths so they are re-resolved after reinstall
    this.cachedOvmsExtraLibPaths = null
    this.ovmsEmbeddedPythonHome = null
  }
}
