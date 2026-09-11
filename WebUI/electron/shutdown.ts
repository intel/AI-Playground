import { appLoggerInstance } from './logging/logger.ts'

const LOG_SOURCE = 'shutdown'

/** How long the whole teardown may take before we quit regardless. */
const DEFAULT_TIMEOUT_MS = 15_000

type AppLogger = Pick<typeof appLoggerInstance, 'info' | 'warn' | 'error'>

export type ShutdownStep = {
  /** Shown in the teardown log. */
  name: string
  /** Awaited; any resolved value is ignored. */
  run: () => unknown
}

export type ShutdownController = {
  /** Steps run in registration order, so register producers before consumers. */
  register: (step: ShutdownStep) => void
  /** Runs every step exactly once; repeat calls await the first run. */
  shutdown: (timeoutMs?: number) => Promise<void>
  /** True from the moment teardown starts, so respawn logic can stand down. */
  isShuttingDown: () => boolean
}

/**
 * The single teardown every exit path funnels through.
 *
 * Backends are spawned detached (see subprocesses/processLifecycle.ts), which
 * means they no longer die with the terminal that started them: reaching this
 * teardown is what stops them, and missing it orphans them. Quitting is also
 * not allowed to hang on a wedged backend, hence the overall timeout.
 */
export function createShutdown(logger: AppLogger = appLoggerInstance): ShutdownController {
  const steps: ShutdownStep[] = []
  let inFlight: Promise<void> | null = null

  const runSteps = async (): Promise<void> => {
    for (const step of steps) {
      const started = Date.now()
      try {
        await step.run()
        logger.info(`${step.name} stopped in ${Date.now() - started}ms`, LOG_SOURCE)
      } catch (e) {
        logger.warn(`${step.name} failed to stop: ${e}`, LOG_SOURCE)
      }
    }
  }

  const runBounded = async (timeoutMs: number): Promise<void> => {
    const started = Date.now()
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        logger.warn(`Teardown still running after ${timeoutMs}ms; quitting anyway`, LOG_SOURCE)
        resolve()
      }, timeoutMs)
    })
    try {
      await Promise.race([runSteps(), deadline])
    } finally {
      clearTimeout(timer)
    }
    logger.info(`Teardown finished in ${Date.now() - started}ms`, LOG_SOURCE)
  }

  return {
    register: (step) => {
      steps.push(step)
    },
    shutdown: (timeoutMs = DEFAULT_TIMEOUT_MS) => {
      inFlight ??= runBounded(timeoutMs)
      return inFlight
    },
    isShuttingDown: () => inFlight !== null,
  }
}

export const appShutdown = createShutdown()
