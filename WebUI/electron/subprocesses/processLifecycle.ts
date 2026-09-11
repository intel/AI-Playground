import { ChildProcess } from 'node:child_process'
import * as childProcess from 'node:child_process'
import { promisify } from 'node:util'
import { appLoggerInstance } from '../logging/logger.ts'

const execAsync = promisify(childProcess.exec)

type AppLogger = Pick<typeof appLoggerInstance, 'info' | 'warn' | 'error'>

/**
 * Spawn a long-lived backend so that its whole descendant tree can be torn down
 * later.
 *
 * On POSIX `detached` makes the child a process-group leader, which is what
 * gives terminateProcessTree() a group to signal. Without it the child shares
 * Electron's group, a kill reaches the direct child only, and every grandchild
 * (ComfyUI's python workers, OVMS sub-servers, whatever our python services
 * shell out to) is orphaned onto init — the Linux/macOS leak that Windows never
 * had, because `taskkill /T` walks the tree instead.
 *
 * Never detached on Windows, where the flag means "run in a new console window".
 *
 * Note the child no longer dies from the terminal's Ctrl+C, so every exit path
 * has to reach shutdownBackends() (see electron/shutdown.ts).
 */
export function spawnBackend(
  command: string,
  args: readonly string[],
  options: childProcess.SpawnOptions = {},
): ChildProcess {
  return childProcess.spawn(command, args, {
    windowsHide: true,
    ...options,
    detached: process.platform !== 'win32',
  })
}

export interface TerminateProcessTreeOptions {
  /** Backend name, used as the logging tag. */
  name: string
  /** Optional extra label (e.g. 'LLM', 'ComfyUI') appended to the tag. */
  label?: string
  /** Grace period for a cooperative SIGTERM shutdown (POSIX only). Default 2000ms. */
  gracefulMs?: number
  /** How long to wait for the OS to reap the process after the force kill. Default 5000ms. */
  forceMs?: number
  appLogger?: AppLogger
}

/**
 * Reliably tear down a spawned backend process AND its descendants.
 *
 * A plain `proc.kill()` only ever signals the direct child, leaving the
 * descendant tree (ComfyUI's python workers, the uv subprocesses spawned by
 * ComfyUI-Manager, …) orphaned on every platform. An orphan keeps holding its
 * port and GPU memory, so the next app launch — which picks a fresh free port —
 * starts a SECOND instance beside it and runs the GPU out of memory.
 *
 * Each platform gets the mechanism it has: `taskkill /T /F` on Windows, and on
 * POSIX a signal to the child's process group, which exists because
 * spawnBackend() spawned it detached.
 */
export async function terminateProcessTree(
  proc: ChildProcess,
  opts: TerminateProcessTreeOptions,
): Promise<void> {
  const { name, label, gracefulMs = 2000, forceMs = 5000 } = opts
  const appLogger = opts.appLogger ?? appLoggerInstance
  const tag = label ? `${name} ${label}` : name

  // Already gone.
  if (proc.exitCode !== null || proc.signalCode !== null) return

  const waitForExit = (ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve(true)
        return
      }
      const timeout = setTimeout(() => resolve(false), ms)
      proc.once('exit', () => {
        clearTimeout(timeout)
        resolve(true)
      })
    })

  if (process.platform === 'win32' && proc.pid !== undefined) {
    // No graceful SIGTERM dance on Windows: signalling the parent leaves the
    // tree running, and if the parent happens to exit we'd never reach the tree
    // kill. Reap the whole tree while the pid is valid.
    try {
      await execAsync(`taskkill /PID ${proc.pid} /T /F`)
    } catch (e) {
      // taskkill exits non-zero when the process is already gone — not fatal.
      appLogger.warn(`taskkill for ${tag} reported: ${e}`, name)
    }
    if (!(await waitForExit(forceMs))) {
      appLogger.warn(`${tag} not confirmed exited after taskkill`, name)
    }
    return
  }

  // POSIX: try a cooperative shutdown of the whole group first, then SIGKILL it.
  signalGroupOrChild(proc, 'SIGTERM', tag, name, appLogger)
  if (await waitForExit(gracefulMs)) return

  appLogger.warn(`${tag} did not exit within ${gracefulMs}ms, force killing`, name)
  signalGroupOrChild(proc, 'SIGKILL', tag, name, appLogger)
  if (!(await waitForExit(forceMs))) {
    appLogger.warn(`${tag} not confirmed exited after SIGKILL`, name)
  }
}

/**
 * Signal the child's process group, falling back to the child alone.
 *
 * The fallback covers children that were not spawned through spawnBackend() and
 * therefore lead no group of their own: `kill(-pid)` reports ESRCH for them,
 * exactly as it does for a group that already exited.
 */
function signalGroupOrChild(
  proc: ChildProcess,
  signal: NodeJS.Signals,
  tag: string,
  name: string,
  appLogger: AppLogger,
): void {
  if (proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, signal)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ESRCH' && code !== 'EPERM') {
        appLogger.warn(`Group ${signal} for ${tag} failed: ${e}`, name)
      }
    }
  }
  try {
    proc.kill(signal)
  } catch (e) {
    appLogger.warn(`${signal} for ${tag} failed: ${e}`, name)
  }
}

/**
 * Command-line fragments that together identify one process, in the order they
 * appear. Kept as fragments rather than one string because Windows quotes an
 * executable path that contains a space — the default install directory is
 * `…\AI Playground\…`, so `"…\python.exe" web_api.py` is the normal case and a
 * contiguous `…python.exe web_api.py` would never match it.
 */
export type ProcessSignature = readonly string[]

export type StaleProcessGroup = {
  /** Backend name, used as the logging tag. */
  name: string
  /** Optional extra label (e.g. 'ComfyUI') appended to the tag. */
  label?: string
  signatures: readonly ProcessSignature[]
}

export type KillStaleProcessesOptions = {
  /** Pids to spare, e.g. backends this session already started. */
  excludePids?: readonly number[]
  appLogger?: AppLogger
}

/**
 * Singleton guard: kill processes left over from a previous app session.
 *
 * A clean shutdown reaps everything via terminateProcessTree(), but a hard crash
 * or a force-quit of Electron cannot. Sweeping BEFORE spawning guarantees a new
 * launch never coexists with a stale instance holding a port and GPU memory.
 *
 * Takes one snapshot of the process table for all groups: on Windows each scan
 * costs a PowerShell start-up, so querying per backend would add seconds to
 * every launch.
 */
export async function killStaleProcesses(
  groups: readonly StaleProcessGroup[],
  opts: KillStaleProcessesOptions = {},
): Promise<void> {
  const { excludePids = [] } = opts
  const appLogger = opts.appLogger ?? appLoggerInstance
  if (groups.length === 0) return

  let processes: ProcessEntry[]
  try {
    processes = await snapshotProcesses()
  } catch (e) {
    // Best-effort guard — never block startup on it.
    appLogger.warn(`Stale-process scan failed: ${e}`, groups[0].name)
    return
  }

  const parents = new Map(processes.map(({ pid, ppid }) => [pid, ppid]))
  for (const group of groups) {
    const tag = group.label ? `${group.name} ${group.label}` : group.name
    const pids = processes
      .filter(({ pid }) => pid !== process.pid && !excludePids.includes(pid))
      .filter(({ commandLine }) => group.signatures.some((s) => matchesSignature(commandLine, s)))
      .map(({ pid }) => pid)
      .filter((pid) => !isOwnDescendant(pid, parents))
    if (pids.length === 0) continue

    appLogger.warn(
      `Found ${pids.length} stale ${tag} process(es) (${pids.join(', ')}); terminating before start`,
      group.name,
    )
    for (const pid of pids) {
      try {
        await killStaleProcess(pid)
      } catch (e) {
        appLogger.warn(`Failed to kill stale ${tag} pid ${pid}: ${e}`, group.name)
      }
    }
  }
}

async function killStaleProcess(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await execAsync(`taskkill /PID ${pid} /T /F`)
    return
  }
  // Prefer the group: a stale backend from a previous session leads one
  // (spawnBackend detaches it), so this also reaps its grandchildren.
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (_e) {
    process.kill(pid, 'SIGKILL')
  }
}

/** Do the fragments occur in this command line, in order? */
function matchesSignature(commandLine: string, signature: ProcessSignature): boolean {
  // Windows paths differ only in case between the spawn and the process table.
  const haystack = process.platform === 'win32' ? commandLine.toLowerCase() : commandLine
  let cursor = 0
  for (const fragment of signature) {
    const needle = process.platform === 'win32' ? fragment.toLowerCase() : fragment
    const found = haystack.indexOf(needle, cursor)
    if (found === -1) return false
    cursor = found + needle.length
  }
  return signature.length > 0
}

/**
 * Did this app start the process (however indirectly)?
 *
 * A backend's signature can also match a short-lived probe we run ourselves —
 * `uv sync --check` querying the interpreter, device detection launching the
 * server for one line of output. Killing one of those makes a perfectly healthy
 * backend report itself as not installed.
 */
function isOwnDescendant(pid: number, parents: ReadonlyMap<number, number>): boolean {
  let current = pid
  // Bounded: a cycle from recycled pids must not spin, and real trees are shallow.
  for (let hop = 0; hop < 32; hop++) {
    const parent = parents.get(current)
    if (parent === undefined || parent <= 0) return false
    if (parent === process.pid) return true
    current = parent
  }
  return false
}

type ProcessEntry = { pid: number; ppid: number; commandLine: string }

async function snapshotProcesses(): Promise<ProcessEntry[]> {
  if (process.platform === 'win32') {
    const { stdout } = await execAsync(
      'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process |' +
        ' Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"',
      { maxBuffer: 32 * 1024 * 1024 },
    )
    return parseWindowsSnapshot(stdout)
  }
  // -ww keeps full command lines; without it they are cut to the terminal width.
  const { stdout } = await execAsync('ps -Awwo pid=,ppid=,command=', {
    maxBuffer: 32 * 1024 * 1024,
  })
  return parsePosixSnapshot(stdout)
}

export function parseWindowsSnapshot(stdout: string): ProcessEntry[] {
  const parsed: unknown = JSON.parse(stdout)
  // ConvertTo-Json emits a bare object when the result holds a single item.
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows
    .map((row) => row as { ProcessId?: number; ParentProcessId?: number; CommandLine?: string })
    .filter((row) => Number.isInteger(row.ProcessId))
    .map((row) => ({
      pid: row.ProcessId!,
      ppid: Number.isInteger(row.ParentProcessId) ? row.ParentProcessId! : 0,
      commandLine: row.CommandLine ?? '',
    }))
}

export function parsePosixSnapshot(stdout: string): ProcessEntry[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      commandLine: match[3],
    }))
}

export type WaitForServerReadyOptions = {
  /** Component name, used as the log source. */
  name: string
  /** Health probe attempts before giving up. */
  maxAttempts?: number
  /** Delay between attempts. */
  delayMs?: number
  /** Per-request timeout for the health probe. */
  requestTimeoutMs?: number
  /**
   * Returns an actionable error message if the server has reported a fatal
   * startup error (e.g. ran out of memory), otherwise null. Checked before each
   * probe so the wait aborts early with a useful message instead of timing out.
   */
  getStartupError?: () => string | null
  /**
   * When true, capture the process exit code/signal and tail of stderr to build
   * a richer crash diagnostic (covers OS-level kills like OOM/SIGSEGV that
   * `ChildProcess.killed` does not reflect).
   */
  captureExitDiagnostics?: boolean
  appLogger?: AppLogger
}

/**
 * Poll an HTTP health endpoint until the server responds 200, the process dies,
 * or `maxAttempts` is exhausted. Throws on every failure path so the caller can
 * surface an actionable error. An `'exit'` listener (not just `proc.killed`) is
 * used to detect OS-level kills.
 */
export async function waitForServerReadyOrThrow(
  healthUrl: string,
  proc: ChildProcess,
  opts: WaitForServerReadyOptions,
): Promise<void> {
  const {
    name,
    maxAttempts = 120,
    delayMs = 1000,
    requestTimeoutMs = 1000,
    getStartupError,
    captureExitDiagnostics = false,
  } = opts
  const appLogger = opts.appLogger ?? appLoggerInstance

  // process.killed only reflects signals sent by Node.js, so also track real
  // exits (OOM, SIGSEGV, etc.) via the 'exit' event.
  let processExited = false
  let exitCode: number | null = null
  let exitSignal: string | null = null
  const stderrChunks: string[] = []

  const onExit = (code: number | null, signal: string | null) => {
    processExited = true
    exitCode = code
    exitSignal = signal
  }
  proc.on('exit', onExit)

  const onStderr = (data: Buffer) => {
    stderrChunks.push(data.toString())
    // Keep only the last 20 chunks of stderr for diagnostics.
    if (stderrChunks.length > 20) stderrChunks.shift()
  }
  if (captureExitDiagnostics) proc.stderr?.on('data', onStderr)

  const isDead = () => processExited || proc.killed
  const deathMessage = (fallback: string): string => {
    if (!captureExitDiagnostics) return fallback
    const reason = exitSignal
      ? `killed by signal ${exitSignal}`
      : exitCode !== null
        ? `exit code ${exitCode}`
        : 'exit code null (killed by OS signal, possibly OOM)'
    const lastStderr = stderrChunks.join('').trim()
    const stderrSuffix = lastStderr ? `\nLast stderr output:\n${lastStderr.slice(-2000)}` : ''
    return `${name} process crashed during startup (${reason})${stderrSuffix}`
  }

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Abort early with an actionable message if the server reported a fatal
      // startup error (e.g. not enough memory for the requested context size).
      const startupError = getStartupError?.()
      if (startupError) {
        appLogger.error(startupError, name)
        throw new Error(startupError)
      }

      if (isDead()) {
        const msg = deathMessage(`Process for ${name} exited before server became ready`)
        appLogger.warn(`Process for ${name} is not alive, aborting health check: ${msg}`, name)
        throw new Error(msg)
      }

      let healthy = false
      try {
        const response = await fetch(healthUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(requestTimeoutMs),
        })
        healthy = response.ok
      } catch (_error) {
        // Server not up yet — fall through to the liveness check and retry.
      }

      if (healthy) {
        // Double-check the process is still alive before accepting success.
        if (isDead()) {
          const msg = deathMessage(`Process for ${name} exited after health check succeeded`)
          appLogger.warn(msg, name)
          throw new Error(msg)
        }
        appLogger.info(`Server ready at ${healthUrl}`, name)
        return
      }

      if (isDead()) {
        const msg = deathMessage(`Process for ${name} exited during health check wait`)
        appLogger.warn(msg, name)
        throw new Error(msg)
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    throw new Error(`Server failed to start within ${(maxAttempts * delayMs) / 1000} seconds`)
  } finally {
    proc.removeListener('exit', onExit)
    if (captureExitDiagnostics) proc.stderr?.removeListener('data', onStderr)
  }
}
