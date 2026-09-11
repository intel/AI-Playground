import { describe, expect, it, vi } from 'vitest'
import { createShutdown } from '../shutdown'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}))

const silentLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('createShutdown', () => {
  it('runs steps once, in registration order', async () => {
    const order: string[] = []
    const shutdown = createShutdown(silentLogger())
    shutdown.register({ name: 'agent', run: () => order.push('agent') })
    shutdown.register({ name: 'services', run: async () => void order.push('services') })

    await shutdown.shutdown()
    await shutdown.shutdown()

    expect(order).toEqual(['agent', 'services'])
  })

  it('keeps tearing down after a step throws', async () => {
    const logger = silentLogger()
    const shutdown = createShutdown(logger)
    shutdown.register({
      name: 'wedged backend',
      run: () => {
        throw new Error('port already closed')
      },
    })
    const after = vi.fn()
    shutdown.register({ name: 'cloud proxy', run: after })

    await shutdown.shutdown()

    expect(after).toHaveBeenCalledOnce()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('wedged backend failed to stop'),
      'shutdown',
    )
  })

  it('gives up on a hanging step so quitting is never blocked', async () => {
    const logger = silentLogger()
    const shutdown = createShutdown(logger)
    shutdown.register({ name: 'hanging backend', run: () => new Promise(() => {}) })

    await shutdown.shutdown(20)

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('still running after 20ms'),
      'shutdown',
    )
  })

  it('reports that it is shutting down from the first call onwards', async () => {
    const shutdown = createShutdown(silentLogger())
    let sawFlagDuringTeardown = false
    shutdown.register({
      name: 'slow backend',
      run: async () => {
        await nap(5)
        sawFlagDuringTeardown = shutdown.isShuttingDown()
      },
    })

    expect(shutdown.isShuttingDown()).toBe(false)
    await shutdown.shutdown()

    expect(sawFlagDuringTeardown).toBe(true)
    expect(shutdown.isShuttingDown()).toBe(true)
  })
})
