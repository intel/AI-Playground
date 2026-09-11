import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    isPackaged: false,
    getAppPath: () => '/tmp',
  },
}))

const CONFIG = JSON.stringify({ projectApiKey: 'test-key', baseUrl: 'http://localhost' })

// Tracing is off without the config file, and off means nothing to replay into.
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const original = actual.readFileSync as (file: unknown, ...rest: unknown[]) => unknown
  const readFileSync = (file: unknown, ...rest: unknown[]) =>
    String(file).endsWith('laminar.dev.json') ? CONFIG : original(file, ...rest)
  const namespace = { ...actual, readFileSync }
  return { ...namespace, default: namespace }
})

/** Model calls the integration was asked to create, and where. */
const calls: { callId: unknown; parent: string | undefined }[] = []
/** The span `withSpan` is currently binding the context to, if any. */
let boundTo: string | undefined

vi.mock('@lmnr-ai/lmnr', () => ({
  Laminar: {
    initialized: () => true,
    withSpan: (span: { name?: string }, run: () => unknown) => {
      boundTo = span.name
      try {
        return run()
      } finally {
        boundTo = undefined
      }
    },
  },
  // Enough of the integration to see which context its span creation ran in;
  // the real one reads exactly that to parent the call's top-level span.
  LaminarAiSdkTelemetry: class {
    onStart = (event: { callId?: unknown }) => calls.push({ callId: event.callId, parent: boundTo })
  },
}))

const { handleChatTelemetryEvent } = await import('../laminar.ts')
const { noteSpanEnd, noteSpanStart } = await import('../laminarSpans.ts')

function mediaToolSpan(spanId: string) {
  return {
    name: 'media',
    attributes: { 'lmnr.span.type': 'TOOL' },
    spanContext: () => ({ spanId }),
  }
}

async function noteContext(context: Record<string, unknown>) {
  await handleChatTelemetryEvent('aipgChatContext', JSON.stringify(context))
}

async function startCall(callId: string) {
  await handleChatTelemetryEvent('onStart', JSON.stringify({ callId }))
}

describe('delegated AI SDK runs', () => {
  beforeEach(() => {
    calls.length = 0
    boundTo = undefined
  })

  it('creates the media specialist run inside the media tool call it serves', async () => {
    const tool = mediaToolSpan('aa')
    noteSpanStart(tool)
    await noteContext({ backend: 'cloud', delegated: true })
    await startCall('1')
    expect(calls).toEqual([{ callId: '1', parent: 'media' }])
    noteSpanEnd(tool)
  })

  it('leaves a chat turn a root, even while a media tool call is open', async () => {
    const tool = mediaToolSpan('bb')
    noteSpanStart(tool)
    await noteContext({ backend: 'cloud' })
    await startCall('1')
    expect(calls).toEqual([{ callId: '1', parent: undefined }])
    noteSpanEnd(tool)
  })

  it('spends the declaration on one run, so a later call is not swept in', async () => {
    const tool = mediaToolSpan('cc')
    noteSpanStart(tool)
    await noteContext({ backend: 'cloud', delegated: true })
    await startCall('1')
    // Nothing sent a context in between — in Agent Mode nothing ever does, since
    // the parent turn runs on Pi in this process.
    await startCall('2')
    expect(calls).toEqual([
      { callId: '1', parent: 'media' },
      { callId: '2', parent: undefined },
    ])
    noteSpanEnd(tool)
  })

  it('still creates the run when there is no media tool call open', async () => {
    await noteContext({ backend: 'cloud', delegated: true })
    await startCall('1')
    expect(calls).toEqual([{ callId: '1', parent: undefined }])
  })
})
