import { beforeEach, describe, expect, it, vi } from 'vitest'

const errorsReport = vi.hoisted(() => vi.fn())

vi.mock('@/assets/js/store/errors', () => ({
  useErrors: () => ({ report: errorsReport }),
}))

const { makeForwardPersist } = await import('@/lib/ipcPersist')

describe('makeForwardPersist', () => {
  beforeEach(() => {
    errorsReport.mockReset()
  })

  it('reports a synchronous throw from call() (structured clone of Vue proxies)', () => {
    const persist = makeForwardPersist({
      code: 'conversations/persist-failed',
      technicalMessage: 'saving a conversation file failed',
    })
    persist(() => {
      throw new DOMException('An object could not be cloned.', 'DataCloneError')
    })
    expect(errorsReport).toHaveBeenCalledTimes(1)
    expect(errorsReport.mock.calls[0][1]).toMatchObject({
      code: 'conversations/persist-failed',
      surface: 'silent',
    })
  })

  it('reports a rejected promise', async () => {
    const persist = makeForwardPersist({
      code: 'conversations/persist-failed',
      technicalMessage: 'saving a conversation file failed',
    })
    persist(() => Promise.reject(new Error('disk full')))
    await vi.waitFor(() => expect(errorsReport).toHaveBeenCalledTimes(1))
  })

  it('reports a resolved { success: false }', async () => {
    const persist = makeForwardPersist({
      code: 'conversations/persist-failed',
      technicalMessage: 'saving a conversation file failed',
    })
    persist(async () => ({ success: false, error: 'schema' }))
    await vi.waitFor(() => expect(errorsReport).toHaveBeenCalledTimes(1))
    expect(errorsReport.mock.calls[0][0]).toEqual(new Error('schema'))
  })
})
