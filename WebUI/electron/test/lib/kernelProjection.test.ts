import { describe, expect, it, vi } from 'vitest'
import {
  connectKernelProjection,
  type KernelProjectionDeps,
} from '@/assets/js/projection/kernelProjection'
import type { KernelEvent, KernelSnapshot } from '@/types/kernelEvents'

// The listener-first handshake: events pushed while the snapshot is in flight
// are buffered, the snapshot installs at sequence N, buffered events above N
// apply in order, and the install hook runs BEFORE the flush so a consumer can
// adopt snapshot state ahead of the events meant to follow it.

function serviceEvent(seq: number, name = 'ai-backend'): KernelEvent {
  return { type: 'service', info: { serviceName: name }, scope: { kind: 'global' }, seq }
}

function snapshotAt(sequence: number, services: unknown[] = []): KernelSnapshot {
  return {
    scope: { kind: 'global' },
    sequence,
    state: {
      services,
      activeTurn: null,
      activeArtifactRun: null,
      chatTurns: [],
      activities: [],
      inferenceProfile: null,
    },
  }
}

function deferredDeps(): {
  deps: KernelProjectionDeps
  push: (event: KernelEvent) => void
  resolveSnapshot: (snapshot: KernelSnapshot) => void
  rejectSnapshot: (reason: unknown) => void
  unsubscribe: ReturnType<typeof vi.fn>
} {
  let push: (event: KernelEvent) => void = () => {}
  let resolveSnapshot!: (snapshot: KernelSnapshot) => void
  let rejectSnapshot!: (reason: unknown) => void
  const unsubscribe = vi.fn()
  const deps: KernelProjectionDeps = {
    subscribe: (listener) => {
      push = listener
      return unsubscribe
    },
    getSnapshot: () =>
      new Promise<KernelSnapshot>((resolve, reject) => {
        resolveSnapshot = resolve
        rejectSnapshot = reject
      }),
  }
  return {
    deps,
    push: (event: KernelEvent) => push(event),
    resolveSnapshot: (snapshot: KernelSnapshot) => resolveSnapshot(snapshot),
    rejectSnapshot: (reason: unknown) => rejectSnapshot(reason),
    unsubscribe,
  }
}

describe('connectKernelProjection', () => {
  it('buffers events pushed during the snapshot request and applies those above the watermark', async () => {
    const { deps, push, resolveSnapshot } = deferredDeps()
    const onEvent = vi.fn()
    const projection = connectKernelProjection(deps, onEvent)

    push(serviceEvent(1))
    push(serviceEvent(2))
    expect(onEvent).not.toHaveBeenCalled()

    resolveSnapshot(snapshotAt(1))
    await projection.ready

    // seq 1 is IN the snapshot — dropped; seq 2 applies.
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith(serviceEvent(2))
  })

  it('applies live events in order after install', async () => {
    const { deps, push, resolveSnapshot } = deferredDeps()
    const seen: number[] = []
    const projection = connectKernelProjection(deps, (event) => seen.push(event.seq))

    resolveSnapshot(snapshotAt(0))
    await projection.ready
    push(serviceEvent(1))
    push(serviceEvent(2))
    push(serviceEvent(3))
    expect(seen).toEqual([1, 2, 3])
  })

  it('runs onInstall before flushing buffered events', async () => {
    const { deps, push, resolveSnapshot } = deferredDeps()
    const order: string[] = []
    const projection = connectKernelProjection(
      deps,
      () => order.push(`event`),
      () => order.push('install'),
    )
    push(serviceEvent(2))
    resolveSnapshot(snapshotAt(1))
    await projection.ready
    expect(order).toEqual(['install', 'event'])
  })

  it('resolves ready with the installed snapshot', async () => {
    const { deps, resolveSnapshot } = deferredDeps()
    const snapshot = snapshotAt(0, [{ serviceName: 'ai-backend' }])
    const projection = connectKernelProjection(deps, () => {})
    resolveSnapshot(snapshot)
    await expect(projection.ready).resolves.toBe(snapshot)
  })

  it('flushes the buffer and keeps streaming when the snapshot request fails', async () => {
    const { deps, push, rejectSnapshot } = deferredDeps()
    const onEvent = vi.fn()
    const projection = connectKernelProjection(deps, onEvent)
    push(serviceEvent(1))
    push(serviceEvent(2))

    rejectSnapshot(new Error('main not ready'))
    await expect(projection.ready).rejects.toThrow('main not ready')

    expect(onEvent).toHaveBeenCalledTimes(2)
    push(serviceEvent(3))
    expect(onEvent).toHaveBeenCalledTimes(3)
  })

  it('stops delivering after dispose and unsubscribes', async () => {
    const { deps, push, resolveSnapshot, unsubscribe } = deferredDeps()
    const onEvent = vi.fn()
    const projection = connectKernelProjection(deps, onEvent)

    projection.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    push(serviceEvent(1))
    resolveSnapshot(snapshotAt(0))
    await expect(projection.ready).resolves.toEqual(snapshotAt(0))
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('a second dispose is a no-op', async () => {
    const { deps, unsubscribe } = deferredDeps()
    const projection = connectKernelProjection(deps, () => {})
    projection.dispose()
    projection.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('drops events pushed after dispose', async () => {
    const { deps, push, resolveSnapshot } = deferredDeps()
    const onEvent = vi.fn()
    const projection = connectKernelProjection(deps, onEvent)
    projection.dispose()
    resolveSnapshot(snapshotAt(0))
    await projection.ready
    push(serviceEvent(1))
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('does not let an onInstall failure wedge the stream in buffering', async () => {
    const { deps, push, resolveSnapshot } = deferredDeps()
    const onEvent = vi.fn()
    const projection = connectKernelProjection(deps, onEvent, () => {
      throw new Error('consumer exploded')
    })
    push(serviceEvent(1))
    resolveSnapshot(snapshotAt(0))
    await projection.ready
    expect(onEvent).toHaveBeenCalledTimes(1)
    push(serviceEvent(2))
    expect(onEvent).toHaveBeenCalledTimes(2)
  })
})
