import { ChildProcess } from 'node:child_process'
import * as childProcess from 'node:child_process'
import { promisify } from 'node:util'
import { appLoggerInstance } from '../logging/logger.ts'

const execAsync = promisify(childProcess.exec)

type AppLogger = Pick<typeof appLoggerInstance, 'info' | 'warn' | 'error'>

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
 * The important fix over a plain `proc.kill()` is Windows: Node has no real
 * SIGTERM, and `ChildProcess.kill()` only signals the direct child, leaving the
 * descendant tree (ComfyUI's python workers, the uv subprocesses spawned by
 * ComfyUI-Manager, …) orphaned. An orphaned ComfyUI keeps holding its port and
 * GPU memory, so the next app launch — which picks a fresh free port — starts a
 * SECOND instance beside it and runs the GPU out of memory. We therefore go
 * straight to `taskkill /T /F` while the pid is still valid so the whole tree is
 * reaped in one shot (this also avoids the pid-reuse risk of killing after a
 * reported graceful exit).
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

  // POSIX: try a cooperative shutdown first, then SIGKILL the child.
  proc.kill('SIGTERM')
  if (await waitForExit(gracefulMs)) return

  appLogger.warn(`${tag} did not exit within ${gracefulMs}ms, force killing`, name)
  proc.kill('SIGKILL')
  if (!(await waitForExit(forceMs))) {
    appLogger.warn(`${tag} not confirmed exited after SIGKILL`, name)
  }
}

export interface KillStaleProcessesOptions {
  name: string
  label?: string
  appLogger?: AppLogger
}

/**
 * Startup singleton guard: kill any process left over from a previous app
 * session whose command line contains `signature` (typically the backend's
 * python binary path, which is unique to that backend's environment directory).
 *
 * A clean shutdown reaps everything via terminateProcessTree(), but a hard crash
 * or force-quit of Electron can still leave a backend running. Calling this
 * BEFORE spawning guarantees a new launch never coexists with a stale instance
 * that would hold a port + GPU memory and cause an out-of-memory.
 */
export async function killStaleProcessesByCommandLine(
  signature: string,
  opts: KillStaleProcessesOptions,
): Promise<void> {
  const { name, label } = opts
  const appLogger = opts.appLogger ?? appLoggerInstance
  const tag = label ? `${name} ${label}` : name

  try {
    const pids = await findPidsByCommandLine(signature)
    if (pids.length === 0) return
    appLogger.warn(
      `Found ${pids.length} stale ${tag} process(es) (${pids.join(', ')}); terminating before start`,
      name,
    )
    for (const pid of pids) {
      try {
        if (process.platform === 'win32') {
          await execAsync(`taskkill /PID ${pid} /T /F`)
        } else {
          process.kill(pid, 'SIGKILL')
        }
      } catch (e) {
        appLogger.warn(`Failed to kill stale ${tag} pid ${pid}: ${e}`, name)
      }
    }
  } catch (e) {
    // Best-effort guard — never block startup on it.
    appLogger.warn(`Stale-${tag}-process scan failed: ${e}`, name)
  }
}

async function findPidsByCommandLine(signature: string): Promise<number[]> {
  if (process.platform === 'win32') {
    // Escape single quotes for the PowerShell string literal.
    const escaped = signature.replace(/'/g, "''")
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' } | Select-Object -ExpandProperty ProcessId"`,
    )
    return parsePids(stdout).filter((pid) => pid !== process.pid)
  }
  // POSIX: pgrep -f matches against the full command line. Fixed-string match.
  try {
    const { stdout } = await execAsync(`pgrep -f -- ${shellQuote(signature)}`)
    return parsePids(stdout).filter((pid) => pid !== process.pid)
  } catch (e) {
    // pgrep exits 1 when nothing matches — that's not an error for us.
    if ((e as { code?: number }).code === 1) return []
    throw e
  }
}

function parsePids(stdout: string): number[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
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
