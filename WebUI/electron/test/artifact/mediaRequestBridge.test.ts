import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The media request bridge routes main's artifact:request payloads to the
// renderer modules that can answer them (model pre-flight, permissions).
// Those modules are mocked at their import seams; only the bridge's own
// contract is under test — reply shapes, error forwarding, and the
// watchdog-keeping pings.

type Handler = (payload: import('@/types/mediaRequests').MediaRequestPayload) => void

const onRequestMock = vi.fn<(callback: Handler) => () => void>()
const respondMock = vi.fn<(payload: unknown) => Promise<void>>()
const getMissingModelsMock = vi.fn<(requiredModels: unknown[]) => Promise<unknown[]>>()
const requestDownloadMock = vi.fn<(models: unknown[]) => Promise<void>>()

vi.mock('@/assets/js/store/imageGenerationUtils', () => ({
  getMissingComfyuiBackendModels: getMissingModelsMock,
}))
vi.mock('@/assets/js/permissions/permissions', () => ({
  requestDownload: requestDownloadMock,
}))

vi.stubGlobal('window', {
  electronAPI: {
    artifact: {
      onRequest: onRequestMock,
      respond: respondMock,
    },
  },
})

const { startMediaRequestBridge, resetMediaRequestBridgeForTest } =
  await import('@/assets/js/artifact/mediaRequestBridge')

let handler: Handler | undefined

beforeEach(() => {
  resetMediaRequestBridgeForTest()
  onRequestMock.mockReset().mockImplementation((callback) => {
    handler = callback
    return () => {}
  })
  respondMock.mockReset().mockResolvedValue()
  getMissingModelsMock.mockReset().mockResolvedValue([{ repo_id: 'flux' }])
  requestDownloadMock.mockReset().mockResolvedValue()
  startMediaRequestBridge()
})

afterEach(() => {
  handler = undefined
})

function requests(kind: 'progress' | 'result' | 'error'): Array<Record<string, unknown>> {
  return respondMock.mock.calls
    .map(([payload]) => payload as Record<string, unknown>)
    .filter((payload) => {
      if (kind === 'progress') return payload.progress === true
      if (kind === 'error') return typeof payload.error === 'string'
      return 'result' in payload
    })
}

describe('mediaRequestBridge', () => {
  it('reports the models a preset is missing', async () => {
    const missing = [{ repo_id: 'flux', type: 'unet', backend: 'comfyui' }]
    getMissingModelsMock.mockResolvedValueOnce(missing)

    handler!({
      kind: 'artifact-check-models',
      requiredModels: [{ type: 'unet', model: 'flux' }],
      requestId: 'r1',
    })
    await vi.waitFor(() => expect(requests('result')).toHaveLength(1))

    expect(getMissingModelsMock).toHaveBeenCalledWith([{ type: 'unet', model: 'flux' }])
    expect(requests('result')[0]).toEqual({ requestId: 'r1', result: { models: missing } })
  })

  it('forwards an inaccessible-repo failure as the request error', async () => {
    getMissingModelsMock.mockRejectedValueOnce(
      new Error('declared model flux does not exist or is not accessible'),
    )

    handler!({
      kind: 'artifact-check-models',
      requiredModels: [{ type: 'unet', model: 'flux' }],
      requestId: 'r2',
    })
    await vi.waitFor(() => expect(requests('error')).toHaveLength(1))

    expect(requests('error')[0]).toEqual({
      requestId: 'r2',
      error: 'declared model flux does not exist or is not accessible',
    })
    expect(requests('result')).toEqual([])
  })

  it('maps required models onto download params and approves on completion', async () => {
    handler!({
      kind: 'artifact-consent',
      models: [
        {
          repo_id: 'flux',
          type: 'unet',
          backend: 'comfyui',
          model_path: 'C:/models/flux',
          additionalLicenseLink: 'https://example.com',
        },
      ],
      requestId: 'r3',
    })
    await vi.waitFor(() => expect(requests('result')).toHaveLength(1))

    expect(requestDownloadMock).toHaveBeenCalledWith([
      {
        repo_id: 'flux',
        type: 'unet',
        backend: 'comfyui',
        model_path: 'C:/models/flux',
        additionalLicenseLink: 'https://example.com',
      },
    ])
    expect(requests('result')[0]).toEqual({ requestId: 'r3', result: true })
  })

  it('reports the decline message when the download is refused', async () => {
    requestDownloadMock.mockRejectedValueOnce(new Error('Download cancelled'))

    handler!({
      kind: 'artifact-consent',
      models: [{ repo_id: 'flux', type: 'unet', backend: 'comfyui', model_path: 'C:/models/flux' }],
      requestId: 'r4',
    })
    await vi.waitFor(() => expect(requests('error')).toHaveLength(1))

    expect(requests('error')[0]).toEqual({ requestId: 'r4', error: 'Download cancelled' })
  })

  it('pings while a request is open and stops once it settles', async () => {
    vi.useFakeTimers()
    try {
      let resolveModels!: (models: unknown[]) => void
      getMissingModelsMock.mockImplementationOnce(
        () => new Promise((resolve) => (resolveModels = resolve)),
      )

      handler!({
        kind: 'artifact-check-models',
        requiredModels: [],
        requestId: 'r7',
      })
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(requests('progress').every((ping) => ping.requestId === 'r7')).toBe(true)
      expect(requests('progress')).toHaveLength(2)

      resolveModels([])
      await vi.advanceTimersByTimeAsync(0)
      expect(requests('result')).toHaveLength(1)

      // Settled: the heartbeat is gone.
      await vi.advanceTimersByTimeAsync(90_000)
      expect(requests('progress')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('registers exactly one listener across repeated starts', () => {
    startMediaRequestBridge()
    startMediaRequestBridge()
    expect(onRequestMock).toHaveBeenCalledTimes(1)
  })
})
