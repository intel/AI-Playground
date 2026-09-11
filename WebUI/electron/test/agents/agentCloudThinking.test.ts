import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { cloudReasoningRegistration } from '../../agentMode/piCloudReasoning.ts'

// What a cloud agent turn actually puts on the wire, and what comes back as
// thinking.
//
// The registration is the whole fix, so asserting our own structures proves
// nothing: only Pi decides whether a request carries a thinking parameter, and
// only Pi's stream reader decides whether `reasoning_content` becomes a thinking
// block rather than text. A real Pi session runs here against a fake
// OpenAI-compatible server; the recorded request bodies and the session's own
// events are the assertions.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-cloud-thinking-'))

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
      requests.push(body ? (JSON.parse(body) as Recorded) : {})
      // A provider that was asked to split its thinking off answers with the
      // trace in its own field, never inline in the content.
      sse(res, [
        completion({ role: 'assistant', reasoning_content: 'weighing it up' }),
        completion({ content: 'done' }),
        completion({}, 'stop'),
      ])
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

/**
 * One turn against the fake server, registered the way `registerModel` registers
 * a cloud model: our own provider id and the loopback proxy's URL, with the
 * reasoning decision taken from the upstream the proxy forwards to.
 */
async function runCloudTurn(config: {
  model: string
  upstreamBaseUrl: string
  reasoningAdvertised?: boolean
}): Promise<{ request: Recorded; thinking: string }> {
  const pi = await import('@earendil-works/pi-coding-agent')
  const runtime = await pi.ModelRuntime.create({
    authPath: path.join(tempRoot, 'auth.json'),
    modelsPath: null,
  })
  runtime.registerProvider('aipg-cloud', {
    name: 'AI Playground cloud proxy',
    baseUrl,
    api: 'openai-completions',
    apiKey: 'unused',
    models: [
      {
        id: config.model,
        name: config.model,
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        ...cloudReasoningRegistration(config),
      },
    ],
  })
  await runtime.setRuntimeApiKey('aipg-cloud', 'unused')
  const model = runtime.getModel('aipg-cloud', config.model)
  expect(model).toBeTruthy()

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
    model: model!,
    modelRuntime: runtime,
    settingsManager: pi.SettingsManager.inMemory(),
    resourceLoader,
    noTools: 'all',
  })

  // The same shape piStreamTranslate.ts reads: a session event carrying one of
  // Pi's assistant-message events.
  const thinking: string[] = []
  session.subscribe((event) => {
    if (event.type !== 'message_update') return
    const inner = event.assistantMessageEvent as { type: string; delta?: string }
    if (inner.type === 'thinking_delta' && inner.delta) thinking.push(inner.delta)
  })

  requests.length = 0
  await session.prompt('build something')
  expect(requests.length).toBeGreaterThanOrEqual(1)
  return { request: requests[0], thinking: thinking.join('') }
}

describe('a cloud agent turn on a reasoning model', () => {
  // The GLM case this was written for: served by a gateway that is not z.ai and
  // advertises no capabilities, so the model id is the only signal.
  it("asks for thinking in z.ai's dialect and reads the split trace back", async () => {
    const { request, thinking } = await runCloudTurn({
      model: 'zai-org/GLM-5.3-Flash',
      upstreamBaseUrl: 'https://gateway.example.com/v1',
    })

    expect(request.thinking).toEqual({ type: 'enabled', clear_thinking: false })
    expect(thinking).toBe('weighing it up')
  }, 30000)

  // Pi promotes the system prompt to a `developer` message once a model reasons,
  // and an arbitrary OpenAI-compatible gateway has never had to accept that.
  it('keeps the system prompt a system message', async () => {
    const { request } = await runCloudTurn({
      model: 'glm-5.2',
      upstreamBaseUrl: 'https://gateway.example.com/v1',
    })

    const roles = (request.messages as { role: string }[]).map((message) => message.role)
    expect(roles).toContain('system')
    expect(roles).not.toContain('developer')
  }, 30000)

  it('asks in reasoning_effort where that is the dialect', async () => {
    const { request } = await runCloudTurn({
      model: 'o4-mini',
      upstreamBaseUrl: 'https://api.openai.com/v1',
      reasoningAdvertised: true,
    })

    expect(request.reasoning_effort).toBe('medium')
    expect(request.thinking).toBeUndefined()
  }, 30000)

  // A provider that advertises nothing is assumed fully capable elsewhere, which
  // must not turn into request parameters it never agreed to.
  it('sends no thinking parameters for a model nobody called reasoning', async () => {
    const { request } = await runCloudTurn({
      model: 'gpt-4o',
      upstreamBaseUrl: 'https://api.openai.com/v1',
    })

    expect(request.thinking).toBeUndefined()
    expect(request.reasoning_effort).toBeUndefined()
    expect(request.reasoning).toBeUndefined()
  }, 30000)
})
