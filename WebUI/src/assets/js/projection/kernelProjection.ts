import type { KernelEvent, KernelSnapshot } from '@/types/kernelEvents'

// The renderer side of the kernel event stream (docs/architecture-target.md
// §4.6). One ordered stream carries every main→renderer notification, and a
// renderer that (re)connects halfway through a run hydrates through a
// listener-first snapshot handshake:
//
//   1. subscribe BEFORE requesting the snapshot — no event can slip in between
//   2. buffer events while the request is in flight
//   3. install the snapshot at sequence N
//   4. apply buffered and future events with seq > N only
//
// The watermark is what makes replay safe: anything the snapshot already
// contains is dropped from the buffer, so no event is applied twice. Parked
// follow-ups: docs/architecture-target.md §8.2.

export type KernelProjectionDeps = {
  subscribe: (onEvent: (event: KernelEvent) => void) => () => void
  getSnapshot: () => Promise<KernelSnapshot>
}

export type KernelProjection = {
  /** Resolves once the snapshot is installed; the snapshot itself is the value. */
  ready: Promise<KernelSnapshot>
  dispose: () => void
}

export function connectKernelProjection(
  deps: KernelProjectionDeps,
  onEvent: (event: KernelEvent) => void,
  onInstall?: (snapshot: KernelSnapshot) => void,
): KernelProjection {
  const buffer: KernelEvent[] = []
  let phase: 'buffering' | 'live' | 'disposed' = 'buffering'
  let watermark = 0

  const unsubscribe = deps.subscribe((event) => {
    if (phase === 'disposed') return
    if (phase === 'buffering') {
      buffer.push(event)
      return
    }
    if (event.seq > watermark) onEvent(event)
  })

  const ready = deps.getSnapshot().then(
    (snapshot) => {
      if (phase === 'disposed') return snapshot
      watermark = snapshot.sequence
      // Install BEFORE flushing: an onInstall that adopts snapshot state (e.g.
      // a resumed agent turn's stream controller) must be in place before the
      // buffered events above the watermark are applied to it. An install
      // failure must not wedge the stream in buffering forever.
      try {
        onInstall?.(snapshot)
      } catch (error) {
        console.warn('kernel projection install failed', error)
      }
      phase = 'live'
      for (const buffered of buffer) {
        if (buffered.seq > watermark) onEvent(buffered)
      }
      buffer.length = 0
      return snapshot
    },
    (reason) => {
      // No snapshot to install — keep the stream itself alive rather than
      // buffering forever: everything already observed is applied, and the
      // consumer still learns of the failure through `ready`.
      if (phase !== 'disposed') {
        phase = 'live'
        watermark = 0
        for (const buffered of buffer) onEvent(buffered)
        buffer.length = 0
      }
      throw reason
    },
  )

  return {
    ready,
    dispose: () => {
      if (phase === 'disposed') return
      phase = 'disposed'
      unsubscribe()
      buffer.length = 0
    },
  }
}

/**
 * The electron-flavoured connection: the kernel channel pair from the preload
 * bridge. In environments without `electronAPI` (unit tests) this degrades to
 * an inert projection so store wiring can run unconditionally.
 */
export function connectKernelEventStream(
  onEvent: (event: KernelEvent) => void,
  onInstall?: (snapshot: KernelSnapshot) => void,
): KernelProjection {
  const api = window.electronAPI
  if (!api?.onKernelEvent || !api.getKernelSnapshot) {
    return {
      ready: Promise.resolve({
        scope: { kind: 'global' },
        sequence: 0,
        state: {
          services: [],
          activeTurn: null,
          activeArtifactRun: null,
          chatTurns: [],
          activities: [],
          inferenceProfile: null,
        },
      }),
      dispose: () => {},
    }
  }
  return connectKernelProjection(
    {
      subscribe: (listener) => api.onKernelEvent(listener),
      getSnapshot: () => api.getKernelSnapshot(),
    },
    onEvent,
    onInstall,
  )
}
