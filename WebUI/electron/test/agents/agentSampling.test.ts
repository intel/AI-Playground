import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

// What a local agent turn actually puts on the wire.
//
// Everything else about sampling is asserted against our own structures, which
// says nothing about whether Pi forwards them: `samplingParams` is a field we
// hang on the resolved model, and only Pi decides if it reaches the request. A
// real Pi session is driven here against a fake OpenAI-compatible server, and
// the recorded request bodies are the assertions — including the second request
// of the same turn, because the thinking switch is flipped mid-turn once the
// agent has written its plan (planningPhase.ts).

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-sampling-'))

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

const requests: Recorded[] = []
let server: http.Server
let baseUrl: string

/** One SSE frame per line, in the shape the openai-completions api expects. */
function sse(res: http.ServerResponse, chunks: Recorded[]): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
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

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (part) => (body += part))
    req.on('end', () => {
      const parsed = body ? (JSON.parse(body) as Recorded) : {}
      requests.push(parsed)
      // First request of the turn asks for the tool, so the turn takes a second
      // step; the second answers and ends it.
      if (requests.length === 1) {
        sse(
          res,
          [
            completion({
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'ping', arguments: '{"path":"design.md"}' },
                },
              ],
            }),
            completion({}, 'tool_calls'),
          ].map((chunk) => chunk),
        )
        return
      }
      sse(res, [completion({ role: 'assistant', content: 'done' }), completion({}, 'stop')])
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('sampling on a local agent turn', () => {
  it('sends the model sampling, and a mid-turn change with it', async () => {
    const pi = await import('@earendil-works/pi-coding-agent')
    const runtime = await pi.ModelRuntime.create({
      authPath: path.join(tempRoot, 'auth.json'),
      modelsPath: null,
    })
    runtime.registerProvider('aipg-local', {
      name: 'test backend',
      baseUrl,
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
    const samplingParams: Record<string, unknown> = {
      top_p: 0.95,
      chat_template_kwargs: { enable_thinking: true },
    }
    const model = { ...registered!, samplingParams }

    const { jsonSchemaParameters, textResult } = await import('../../agentMode/piCustomTools.ts')
    const { createSamplingExtension } = await import('../../agentMode/piSampling.ts')
    const workspace = fs.mkdtempSync(path.join(tempRoot, 'ws-'))
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: workspace,
      agentDir: path.join(tempRoot, 'agent'),
      noExtensions: true,
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      extensionFactories: [createSamplingExtension(() => samplingParams)],
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
          parameters: jsonSchemaParameters({
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          }),
          execute: async () => textResult('pong'),
        }),
      ],
    })

    // The production switch: the bag is mutated between steps, and the next
    // request is expected to carry the new value.
    session.subscribe((event: { type: string }) => {
      if (event.type !== 'tool_execution_start') return
      ;(samplingParams.chat_template_kwargs as Record<string, unknown>).enable_thinking = false
    })

    await session.prompt('build something')

    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(requests[0].top_p).toBe(0.95)
    expect(requests[0].chat_template_kwargs).toEqual({ enable_thinking: true })
    expect(requests[1].chat_template_kwargs).toEqual({ enable_thinking: false })
  }, 30000)
})
