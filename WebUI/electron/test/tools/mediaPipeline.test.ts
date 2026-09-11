import { describe, it, expect } from 'vitest'
import { comfyRunsWaiting, queueComfyRun, queueMediaRequest } from '@/assets/js/tools/mediaPipeline'

/** A promise plus the handles to settle it from the test. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('media pipeline lanes', () => {
  it('runs work on a lane one item at a time, in order', async () => {
    const order: string[] = []
    const first = deferred<void>()

    const a = queueComfyRun(async () => {
      order.push('a:start')
      await first.promise
      order.push('a:end')
    })
    const b = queueComfyRun(async () => {
      order.push('b:start')
    })

    await Promise.resolve()
    expect(order).toEqual(['a:start'])

    first.resolve()
    await Promise.all([a, b])
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('keeps the lane usable after a failure', async () => {
    const failing = queueComfyRun(() => Promise.reject(new Error('ComfyUI is not running')))
    const next = queueComfyRun(() => Promise.resolve('ran'))

    await expect(failing).rejects.toThrow('ComfyUI is not running')
    await expect(next).resolves.toBe('ran')
  })

  it('does not start work that was cancelled while queued', async () => {
    const blocking = deferred<void>()
    const running = queueComfyRun(() => blocking.promise)

    const abort = new AbortController()
    let started = false
    const waiting = queueComfyRun(async () => {
      started = true
    }, abort.signal)
    abort.abort()

    blocking.resolve()
    await running
    await expect(waiting).rejects.toThrow(/Cancelled while waiting for the media pipeline/)
    expect(started).toBe(false)
  })

  it('tells a run whether generations are queued behind it', async () => {
    // What lets consecutive generations share one model swap: only the last one
    // out frees ComfyUI and brings the LLM back.
    const seen: boolean[] = []
    const gate = deferred<void>()

    const a = queueComfyRun(async () => {
      await gate.promise
      seen.push(comfyRunsWaiting())
    })
    const b = queueComfyRun(async () => {
      seen.push(comfyRunsWaiting())
    })

    gate.resolve()
    await Promise.all([a, b])
    expect(seen).toEqual([true, false])
    expect(comfyRunsWaiting()).toBe(false)
  })

  it('stops counting a waiter that was cancelled at the gate', async () => {
    const gate = deferred<void>()
    const running = queueComfyRun(() => gate.promise)
    const abort = new AbortController()
    const cancelled = queueComfyRun(() => Promise.resolve(), abort.signal)
    abort.abort()

    gate.resolve()
    await running
    await expect(cancelled).rejects.toThrow(/Cancelled while waiting/)
    expect(comfyRunsWaiting()).toBe(false)
  })

  it('lets a queued request run its generations without deadlocking', async () => {
    // The lanes nest: a media request holds the request lane while the
    // generations inside it take the comfy lane. Only that direction occurs, so
    // waiting on the inner lane can never block on the outer one.
    const order: string[] = []
    const request = (name: string) =>
      queueMediaRequest(async () => {
        order.push(`${name}:request`)
        await queueComfyRun(async () => {
          order.push(`${name}:generate`)
        })
      })

    await Promise.all([request('first'), request('second')])
    expect(order).toEqual(['first:request', 'first:generate', 'second:request', 'second:generate'])
  })
})
