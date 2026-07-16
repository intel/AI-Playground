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
