import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
// Type-only, so the module is still first loaded after the electron mock is set.
import type { LocalModelConfig } from '../../agentMode/piLocalEndpoint.ts'

// Which server an agent step actually talks to.
//
// A local LLM server is relaunched in the middle of a turn (a media generation
// hands the GPU to ComfyUI and takes it back) and comes back on another port, so
// the endpoint a session was built with can be dead by its next step. Whether
// the new one reaches a running session is Pi's decision, not ours: pi-ai reads
// the base URL off the model object per request, and only a real session proves
// it. So a second fake server is started, the backend is moved to it while the
// first step's tool runs, and the assertion is which server received what.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-endpoint-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => tempRoot,
    isPackaged: false,
    getAppPath: () => tempRoot,
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
}))

type Recorded = Record<string, unknown>

/** One fake OpenAI-compatible backend, remembering what it was asked for. */
type FakeBackend = {
  server: http.Server
  baseUrl: string
  requests: Recorded[]
}

/** One SSE frame per line, in the shape the openai-completions api expects. */
function sse(res: http.ServerResponse, chunks: Recorded[]): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function completion(delta: Recorded, finishReason: string | null = null): Recorded {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

/** Answer with a tool call first, then a final message. */
function reply(res: http.ServerResponse, callTool: boolean): void {
  if (callTool) {
    sse(res, [
      completion({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'ping', arguments: '{}' },
          },
        ],
      }),
      completion({}, 'tool_calls'),
    ])
    return
  }
  sse(res, [completion({ role: 'assistant', content: 'done' }), completion({}, 'stop')])
}

async function startBackend(onRequest: (backend: FakeBackend) => boolean): Promise<FakeBackend> {
  const requests: Recorded[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (part) => (body += part))
    req.on('end', () => {
      requests.push(body ? (JSON.parse(body) as Recorded) : {})
      reply(res, onRequest(backend))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const backend: FakeBackend = { server, baseUrl: `http://127.0.0.1:${port}`, requests }
  return backend
}

let first: FakeBackend
let second: FakeBackend
/** What the service registry currently reports for llamacpp-backend. */
let servedBy: FakeBackend

beforeAll(async () => {
  // The first server asks for the tool on its first request, which is when the
  // backend moves, and would end the turn on a second one — so a step that
  // wrongly stays with it is a failed assertion rather than a loop.
  first = await startBackend((backend) => backend.requests.length === 1)
  second = await startBackend(() => false)
  servedBy = first
  const { setLlmServiceLookup } = await import('../../llmServerSnapshot.ts')
  setLlmServiceLookup((serviceName) =>
    serviceName === 'llamacpp-backend'
      ? { get_info: () => ({ baseUrl: servedBy.baseUrl }) }
      : undefined,
  )
})

afterAll(async () => {
  for (const backend of [first, second]) {
    await new Promise<void>((resolve) => backend.server.close(() => resolve()))
  }
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

beforeEach(() => {
  servedBy = first
  first.requests.length = 0
  second.requests.length = 0
})

function localConfig(overrides: Partial<LocalModelConfig> = {}): LocalModelConfig {
  return {
    source: 'local',
    model: 'test-model',
    baseUrl: `${first.baseUrl}/v1`,
    backend: 'llamaCPP',
    ...overrides,
  }
}

describe('the local endpoint of an agent turn', () => {
  it('reports where the backend is now, not where it was', async () => {
    const { localBaseUrl } = await import('../../agentMode/piLocalEndpoint.ts')
    const config = localConfig()
    expect(localBaseUrl(config)).toBe(`${first.baseUrl}/v1`)
    servedBy = second
    expect(localBaseUrl(config)).toBe(`${second.baseUrl}/v1`)
  })

  it('keeps an OpenVINO /v3 base instead of appending /v1', async () => {
    const { setLlmServiceLookup } = await import('../../llmServerSnapshot.ts')
    const previous = (serviceName: string) =>
      serviceName === 'llamacpp-backend'
        ? { get_info: () => ({ baseUrl: servedBy.baseUrl }) }
        : undefined
    setLlmServiceLookup((serviceName) =>
      serviceName === 'openvino-backend'
        ? { get_info: () => ({ baseUrl: 'http://127.0.0.1:29000/v3' }) }
        : previous(serviceName),
    )
    try {
      const { localBaseUrl } = await import('../../agentMode/piLocalEndpoint.ts')
      expect(
        localBaseUrl(localConfig({ backend: 'openVINO', baseUrl: 'http://127.0.0.1:29000/v3' })),
      ).toBe('http://127.0.0.1:29000/v3')
    } finally {
      setLlmServiceLookup(previous)
    }
  })

  it('sends a step that follows a backend restart to the new server', async () => {
    const pi = await import('@earendil-works/pi-coding-agent')
    const { withLiveEndpoint } = await import('../../agentMode/piLocalEndpoint.ts')
    const config = localConfig()
    const runtime = await pi.ModelRuntime.create({
      authPath: path.join(tempRoot, 'auth.json'),
      modelsPath: null,
    })
    runtime.registerProvider('aipg-local', {
      name: 'test backend',
      baseUrl: config.baseUrl,
      api: 'openai-completions',
      apiKey: 'unused',
      models: [
        {
          id: 'test-model',
          name: 'test-model',
          reasoning: false,
          input: ['text'],
          contextWindow: 8192,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        },
      ],
    })
    await runtime.setRuntimeApiKey('aipg-local', 'unused')
    const registered = runtime.getModel('aipg-local', 'test-model')
    expect(registered).toBeTruthy()
    const model = withLiveEndpoint(registered!, config)

    const { jsonSchemaParameters, textResult } = await import('../../agentMode/piCustomTools.ts')
    const workspace = fs.mkdtempSync(path.join(tempRoot, 'ws-'))
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: workspace,
      agentDir: path.join(tempRoot, 'agent'),
      noExtensions: true,
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
    })
    await resourceLoader.reload()
    const { session } = await pi.createAgentSession({
      cwd: workspace,
      agentDir: path.join(tempRoot, 'agent'),
      model,
      modelRuntime: runtime,
      settingsManager: pi.SettingsManager.inMemory(),
      resourceLoader,
      noTools: 'builtin',
      customTools: [
        pi.defineTool({
          name: 'ping',
          label: 'ping',
          description: 'Test tool.',
          parameters: jsonSchemaParameters({ type: 'object', properties: {} }),
          execute: async () => textResult('pong'),
        }),
      ],
    })

    // The production event: a media call restarts the LLM server while the turn
    // is between two steps, and the registry starts reporting the new port.
    session.subscribe((event: { type: string }) => {
      if (event.type !== 'tool_execution_start') return
      servedBy = second
    })

    await session.prompt('build something')

    expect(first.requests).toHaveLength(1)
    expect(second.requests).toHaveLength(1)
  }, 30000)
})
