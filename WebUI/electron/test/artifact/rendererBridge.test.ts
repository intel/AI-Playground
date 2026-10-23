import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  handleMediaResponse,
  mediaRequestsPending,
  rejectAllMediaRequests,
  requestRenderer,
  resetRendererBridgeForTest,
} from '../../artifact/rendererBridge'
import { resetKernelBusForTest, setKernelEventWindow } from '../../kernel/kernelBus'
import type { MediaRequestPayload } from '@/types/mediaRequests'

let sent: MediaRequestPayload[] = []

beforeEach(() => {
  resetKernelBusForTest()
  resetRendererBridgeForTest()
  sent = []
  setKernelEventWindow({
    isDestroyed: () => false,
    webContents: {
      send: vi.fn((_channel: string, payload: MediaRequestPayload) => sent.push(payload)),
    },
  } as never)
})

afterEach(() => {
  resetKernelBusForTest()
  resetRendererBridgeForTest()
})

describe('renderer request bridge', () => {
  it('round-trips a request and its reply by requestId', async () => {
    const pending = requestRenderer<{ models: unknown[] }>({
      kind: 'artifact-check-models',
      requiredModels: [],
    })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].kind).toBe('artifact-check-models')
    expect(typeof sent[0].requestId).toBe('string')

    handleMediaResponse({ requestId: sent[0].requestId, result: { models: [{ model: 'x' }] } })
    await expect(pending).resolves.toEqual({ models: [{ model: 'x' }] })
    expect(mediaRequestsPending()).toBe(0)
  })

  it('forwards progress pings without settling the request', async () => {
    const onProgress = vi.fn()
    const pending = requestRenderer<boolean>(
      { kind: 'artifact-consent', models: [] },
      { onProgress },
    )
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    handleMediaResponse({ requestId: sent[0].requestId, progress: true })
    handleMediaResponse({ requestId: sent[0].requestId, progress: true })
    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(mediaRequestsPending()).toBe(1)

    handleMediaResponse({ requestId: sent[0].requestId, result: true })
    await expect(pending).resolves.toBe(true)
  })

  it('rejects when the renderer reports an error', async () => {
    const pending = requestRenderer({ kind: 'artifact-consent', models: [] })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    handleMediaResponse({ requestId: sent[0].requestId, error: 'renderer failed' })
    await expect(pending).rejects.toThrow('renderer failed')
  })

  it('rejects immediately when no renderer window exists', async () => {
    setKernelEventWindow(null)
    await expect(
      requestRenderer({ kind: 'artifact-check-models', requiredModels: [] }),
    ).rejects.toThrow('No renderer window')
  })

  it('rejects every pending request when the window is replaced', async () => {
    const first = requestRenderer({ kind: 'artifact-consent', models: [] })
    const second = requestRenderer({ kind: 'artifact-check-models', requiredModels: [] })
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    rejectAllMediaRequests('The app window was replaced')
    await expect(first).rejects.toThrow('The app window was replaced')
    await expect(second).rejects.toThrow('The app window was replaced')
    expect(mediaRequestsPending()).toBe(0)
  })

  it('ignores replies for unknown or malformed request ids', () => {
    expect(() => {
      handleMediaResponse({ requestId: 'missing', result: null })
      handleMediaResponse({ requestId: '', progress: true })
      handleMediaResponse(null as never)
    }).not.toThrow()
    expect(mediaRequestsPending()).toBe(0)
  })
})
