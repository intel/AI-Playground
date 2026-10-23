import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { KernelEvent, KernelSnapshot } from '@/types/kernelEvents'

const applyInferenceProfile = vi.hoisted(() => vi.fn())

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({ applyInferenceProfile }),
}))

type Tap = (event: KernelEvent) => void

let taps: Tap[] = []
let snapshot: KernelSnapshot

function emptySnapshot(overrides: Partial<KernelSnapshot['state']> = {}): KernelSnapshot {
  return {
    scope: { kind: 'global' },
    sequence: 0,
    state: {
      services: [],
      activeTurn: null,
      activeArtifactRun: null,
      chatTurns: [],
      activities: [],
      inferenceProfile: null,
      ...overrides,
    },
  }
}

function emit(event: KernelEvent): void {
  for (const tap of taps) tap(event)
}

beforeEach(() => {
  setActivePinia(createPinia())
  taps = []
  snapshot = emptySnapshot()
  applyInferenceProfile.mockReset()
  globalThis.window = {
    electronAPI: {
      onKernelEvent: (tap: Tap) => {
        taps.push(tap)
        return () => {
          taps = taps.filter((t) => t !== tap)
        }
      },
      getKernelSnapshot: async () => snapshot,
      getLocaleSettings: async () => ({}),
    },
  } as unknown as Window & typeof globalThis
})

afterEach(async () => {
  const { stopKernelLedgerProjection } = await import('@/lib/kernelLedgerProjection')
  stopKernelLedgerProjection()
  vi.unstubAllGlobals()
  // @ts-expect-error test teardown of the fake window
  delete globalThis.window
})

describe('kernel ledger projection', () => {
  it('installs in-flight activities and the inference profile from the snapshot', async () => {
    snapshot = emptySnapshot({
      activities: [
        {
          id: 'backend-load-1',
          category: 'backend',
          label: 'Loading Qwen…',
          scope: { kind: 'global' },
          state: 'active',
        },
      ],
      inferenceProfile: {
        serviceName: 'llamacpp-backend',
        llmModelName: 'Qwen3-9B',
        active: true,
      },
    })
    const { startKernelLedgerProjection } = await import('@/lib/kernelLedgerProjection')
    const { useActivities } = await import('@/assets/js/store/activities')
    startKernelLedgerProjection()
    await vi.waitFor(() => {
      expect(useActivities().activeItems.some((item) => item.id === 'backend-load-1')).toBe(true)
    })
    expect(applyInferenceProfile).toHaveBeenCalledWith({
      serviceName: 'llamacpp-backend',
      llmModelName: 'Qwen3-9B',
      active: true,
    })
  })

  it('projects activity begin/end, silent errors, and inference-profile stored events', async () => {
    const { startKernelLedgerProjection } = await import('@/lib/kernelLedgerProjection')
    const { useActivities } = await import('@/assets/js/store/activities')
    const { useErrors } = await import('@/assets/js/store/errors')
    startKernelLedgerProjection()
    await vi.waitFor(() => expect(taps.length).toBeGreaterThan(0))

    emit({
      type: 'activity',
      seq: 1,
      scope: { kind: 'global' },
      action: 'begin',
      activity: {
        id: 'backend-load-2',
        category: 'backend',
        label: 'Loading Qwen…',
        scope: { kind: 'chat', conversationKey: 'conv-1' },
        state: 'active',
      },
    })
    expect(useActivities().activeItems.some((item) => item.id === 'backend-load-2')).toBe(true)

    emit({
      type: 'activity',
      seq: 2,
      scope: { kind: 'global' },
      action: 'end',
      activity: {
        id: 'backend-load-2',
        category: 'backend',
        label: 'Loading Qwen…',
        scope: { kind: 'chat', conversationKey: 'conv-1' },
        state: 'done',
      },
    })
    expect(useActivities().activeItems.some((item) => item.id === 'backend-load-2')).toBe(false)

    emit({
      type: 'error',
      seq: 3,
      scope: { kind: 'global' },
      error: {
        code: 'backend/not-ready',
        category: 'backend',
        severity: 'error',
        surface: 'silent',
        userMessage: 'Could not load Qwen.',
        technicalMessage: 'OOM',
        context: {},
        recoverable: true,
      },
    })
    expect(useErrors().recentErrors.at(-1)).toMatchObject({
      code: 'backend/not-ready',
      surface: 'silent',
    })

    emit({
      type: 'stored',
      seq: 4,
      scope: { kind: 'global' },
      kind: 'inference-profile',
      inferenceProfile: {
        serviceName: 'llamacpp-backend',
        llmModelName: 'Qwen3-9B',
        active: false,
      },
    })
    expect(applyInferenceProfile).toHaveBeenCalledWith({
      serviceName: 'llamacpp-backend',
      llmModelName: 'Qwen3-9B',
      active: false,
    })
  })
})
