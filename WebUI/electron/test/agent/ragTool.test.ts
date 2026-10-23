import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The `rag` capability's tool: containment, index caching, k clamping and the
// passage formatting. Splitting/embedding/retrieval are reached through the
// ragAccess bridge, so the tests install a fake and inspect what the tool asks
// it to do — the langchain worker and the embedding server are not under test.

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-rag-'))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => agentDir, getAppPath: () => agentDir },
  BrowserWindow: class {},
  net: {},
}))

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Pi is ESM-only and loaded lazily; `defineTool` is an identity function here.
vi.mock('../../agent/piRuntime.ts', () => ({
  loadPi: async () => ({ defineTool: (definition: unknown) => definition }),
}))

vi.mock('../../agent/agentBrowser.ts', () => ({ runBrowserAction: vi.fn() }))
vi.mock('../../adapters/mcp/mcpManager.ts', () => ({
  getMcpServerTools: vi.fn(async () => ({})),
}))

const { resolveCapabilities } = await import('../../agent/capabilities/index.ts')
const { setRagAccess, resetRagAccess } = await import('../../agent/ragAccess.ts')
const { testables } = await import('../../agent/capabilities/rag.ts')
const { setToolBridgeWindow, submitAgentToolResult } = await import('../../agent/piCustomTools.ts')
const { Document } = await import('@langchain/classic/document')
import type { RagAccess } from '../../agent/ragAccess.ts'

const { DEFAULT_K, MAX_K, MAX_RESULT_CHARS, resolveWorkspaceFile, formatChunks } = testables

type Host = Parameters<typeof resolveCapabilities>[0]

function hostWith(overrides: Partial<Host> = {}): Host {
  const workspaceDir = path.join(agentDir, 'workspace')
  fs.mkdirSync(workspaceDir, { recursive: true })
  return {
    sessionId: 'session-1',
    workspaceDir,
    toolSpecs: [],
    agentDir,
    keepModelsLoaded: false,
    embeddingModel: 'emb-model',
    embeddingBackend: 'llamaCPP',
    ...overrides,
  }
}

type RagTool = {
  name: string
  parameters?: { required?: string[] }
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: { type: string; text: string }[] }>
}

async function buildRagTool(host: Host): Promise<RagTool> {
  const resolution = await resolveCapabilities(host, ['rag'])
  expect(resolution.resolved.map(({ capability }) => capability.id)).toEqual(['rag'])
  const tools: RagTool[] = []
  for (const factory of resolution.extensionFactories) {
    factory({
      registerTool: (tool: RagTool) => tools.push(tool),
      registerCommand: vi.fn(),
      on: vi.fn(),
    } as never)
  }
  expect(tools.map((tool) => tool.name)).toEqual(['rag'])
  return tools[0]
}

function makeChunk(text: string, metadata: Record<string, unknown> = {}) {
  return new Document({ pageContent: text, metadata })
}

function fakeAccess(
  options: {
    chunks?: ReturnType<typeof makeChunk>[]
    emptySplit?: boolean
    failRetrieve?: Error
  } = {},
) {
  const calls = { ingest: 0, ensure: 0, retrieve: 0 }
  let lastInquiry: Record<string, unknown> | undefined
  const chunks = options.chunks ?? [makeChunk('The budget is $42.', { loc: { pageNumber: 7 } })]
  const access: RagAccess = {
    ingest: async (document) => {
      calls.ingest += 1
      return {
        ...document,
        hash: `hash-${calls.ingest}`,
        splitDB: options.emptySplit ? [] : [makeChunk('chunk')],
      }
    },
    retrieve: async (inquiry) => {
      calls.retrieve += 1
      lastInquiry = inquiry as unknown as Record<string, unknown>
      if (options.failRetrieve) throw options.failRetrieve
      // Stamp the source path onto returned chunks the way the real ingest does,
      // so formatChunks can label each passage with its file.
      const source = inquiry.ragList[0]?.filepath
      return chunks.map((c) =>
        source && !(c.metadata as Record<string, unknown>).source
          ? new Document({ pageContent: c.pageContent, metadata: { ...c.metadata, source } })
          : c,
      )
    },
    ensureEmbeddingServer: async () => {
      calls.ensure += 1
      return 'http://127.0.0.1:39999'
    },
  }
  setRagAccess(access)
  return { calls, inquiry: () => lastInquiry as Record<string, unknown> }
}

function workspaceFile(host: Host, name: string, content = 'some text'): string {
  const filePath = path.join(host.workspaceDir, name)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  return filePath
}

async function resultOf(tool: RagTool, params: Record<string, unknown>): Promise<string> {
  const result = await tool.execute('call-1', params)
  return result.content[0].text
}

// The tool asks the renderer (before first use) whether the session's embedding
// model is on disk; the renderer owns the download prompt. Fake the bridge: the
// window captures the dispatch and answers through submitAgentToolResult.
function fakeRendererPrep(status: 'ready' | 'declined' | 'failed', error = 'disk full') {
  const dispatches: { toolName: string; input: Record<string, unknown> }[] = []
  const send = (
    _channel: string,
    payload: { requestId: string; toolName: string; input: unknown },
  ) => {
    dispatches.push({ toolName: payload.toolName, input: payload.input as Record<string, unknown> })
    if (payload.toolName === 'ragPrepareEmbeddingModel') {
      submitAgentToolResult(payload.requestId, status === 'failed' ? { status, error } : { status })
    }
  }
  setToolBridgeWindow({ webContents: { send } } as never)
  return { dispatches }
}

beforeEach(() => {
  resetRagAccess()
  fakeRendererPrep('ready')
})

afterAll(() => {
  fs.rmSync(agentDir, { recursive: true, force: true })
  resetRagAccess()
})

describe('the rag tool', () => {
  it('asks for files and a query', async () => {
    const tool = await buildRagTool(hostWith())
    expect(tool.parameters?.required).toEqual(['files', 'query'])
  })

  it('indexes, retrieves and returns passages with page metadata', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    const { calls, inquiry } = fakeAccess()
    const tool = await buildRagTool(host)

    const text = await resultOf(tool, { files: ['report.pdf'], query: 'the budget' })

    expect(calls.ingest).toBe(1)
    expect(calls.ensure).toBe(1)
    expect(inquiry()).toMatchObject({
      prompt: 'the budget',
      backendBaseUrl: 'http://127.0.0.1:39999',
      embeddingModel: 'emb-model',
      maxResults: DEFAULT_K,
      useGroupRetrieval: false,
    })
    expect(inquiry().ragList).toHaveLength(1)
    expect(text).toContain('report.pdf')
    expect(text).toContain('page 7')
    expect(text).toContain('The budget is $42.')
  })

  it('keeps the index for the session and rechecks the embedding server', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    const { calls } = fakeAccess()
    const tool = await buildRagTool(host)

    await resultOf(tool, { files: ['report.pdf'], query: 'first question' })
    await resultOf(tool, { files: ['report.pdf'], query: 'second question' })

    expect(calls.ingest).toBe(1)
    expect(calls.ensure).toBe(2)
    expect(calls.retrieve).toBe(2)

    // A changed file re-indexes. The server is asked again: a media call may
    // have stopped it and brought it back on a different port.
    const changed = workspaceFile(host, 'report.pdf', 'rewritten content')
    fs.utimesSync(changed, new Date(), new Date(Date.now() + 10_000))
    await resultOf(tool, { files: ['report.pdf'], query: 'third question' })
    expect(calls.ingest).toBe(2)
    expect(calls.ensure).toBe(3)
  })

  it('clamps k into range', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    const { inquiry } = fakeAccess()
    const tool = await buildRagTool(host)

    await resultOf(tool, { files: ['report.pdf'], query: 'q', k: 99 })
    expect(inquiry().maxResults).toBe(MAX_K)
    await resultOf(tool, { files: ['report.pdf'], query: 'q', k: 0 })
    expect(inquiry().maxResults).toBe(1)
    await resultOf(tool, { files: ['report.pdf'], query: 'q' })
    expect(inquiry().maxResults).toBe(DEFAULT_K)
  })

  it('refuses paths outside the workspace without touching the index', async () => {
    const host = hostWith()
    workspaceFile(host, 'inside.pdf')
    const outside = path.join(agentDir, 'outside.pdf')
    fs.writeFileSync(outside, 'secret')
    const link = path.join(host.workspaceDir, 'link.pdf')
    fs.symlinkSync(outside, link)
    const { calls } = fakeAccess()
    const tool = await buildRagTool(host)

    expect(await resultOf(tool, { files: [outside], query: 'q' })).toMatch(
      /not a file in the workspace/,
    )
    expect(await resultOf(tool, { files: ['../outside.pdf'], query: 'q' })).toMatch(
      /not a file in the workspace/,
    )
    expect(await resultOf(tool, { files: ['link.pdf'], query: 'q' })).toMatch(
      /not a file in the workspace/,
    )
    expect(await resultOf(tool, { files: ['missing.pdf'], query: 'q' })).toMatch(
      /not a file in the workspace/,
    )
    expect(calls.ingest).toBe(0)
    expect(calls.retrieve).toBe(0)
  })

  it('accepts the /workspace/<name> form the sandbox advertises', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    const { calls, inquiry } = fakeAccess()
    const tool = await buildRagTool(host)

    const text = await resultOf(tool, { files: ['/workspace/report.pdf'], query: 'budget' })
    expect(calls.ingest).toBe(1)
    expect(inquiry()).toMatchObject({ prompt: 'budget' })
    expect(text).toContain('report.pdf')
  })

  it('accepts the real absolute workspace path host-shell mode uses', async () => {
    const host = hostWith()
    const file = workspaceFile(host, 'report.pdf')
    const { calls } = fakeAccess()
    const tool = await buildRagTool(host)

    await resultOf(tool, { files: [file], query: 'budget' })
    expect(calls.ingest).toBe(1)
  })

  it('searches multiple files as a merged set and labels each passage with its file', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    workspaceFile(host, 'notes.md')
    const { calls, inquiry } = fakeAccess()
    const tool = await buildRagTool(host)

    const text = await resultOf(tool, { files: ['report.pdf', 'notes.md'], query: 'budget' })

    expect(calls.ingest).toBe(2)
    expect(calls.retrieve).toBe(1)
    expect(inquiry().ragList).toHaveLength(2)
    expect(text).toContain('2 documents')
  })

  it('skips invalid files and searches the rest', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    workspaceFile(host, 'index.html') // unsupported extension
    const { calls, inquiry } = fakeAccess()
    const tool = await buildRagTool(host)

    const text = await resultOf(tool, { files: ['report.pdf', 'index.html'], query: 'budget' })

    // Only the valid file is ingested and retrieved.
    expect(calls.ingest).toBe(1)
    expect(inquiry().ragList).toHaveLength(1)
    // The result still returns passages from the valid file...
    expect(text).toContain('The budget is $42.')
    // ...and notes the skipped file.
    expect(text).toContain('Skipped:')
    expect(text).toContain('index.html')
  })

  it('returns a skip summary without prompting when every file is invalid', async () => {
    const host = hostWith()
    workspaceFile(host, 'index.html')
    const { calls } = fakeAccess()
    const tool = await buildRagTool(host)

    const text = await resultOf(tool, { files: ['index.html', 'missing.pdf'], query: 'q' })

    expect(text).toContain('No documents could be searched')
    expect(text).toContain('index.html')
    expect(text).toContain('missing.pdf')
    // No download prompt, no ingest, no retrieve.
    expect(calls.ingest).toBe(0)
    expect(calls.retrieve).toBe(0)
    expect(calls.ensure).toBe(0)
  })

  it('accepts a single string as files for defensive coercion', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    const { calls } = fakeAccess()
    const tool = await buildRagTool(host)

    // A model might send a bare string instead of an array.
    await resultOf(tool, { files: 'report.pdf', query: 'budget' } as Record<string, unknown>)
    expect(calls.ingest).toBe(1)
  })

  it('caches the index per file across calls in the same session', async () => {
    const host = hostWith()
    workspaceFile(host, 'a.pdf')
    workspaceFile(host, 'b.pdf')
    const { calls } = fakeAccess()
    const tool = await buildRagTool(host)

    await resultOf(tool, { files: ['a.pdf', 'b.pdf'], query: 'first' })
    expect(calls.ingest).toBe(2)

    // Second call with both files: cached, no re-ingest.
    await resultOf(tool, { files: ['a.pdf', 'b.pdf'], query: 'second' })
    expect(calls.ingest).toBe(2)
    expect(calls.retrieve).toBe(2)

    // Adding a new file ingests only the new one.
    workspaceFile(host, 'c.pdf')
    await resultOf(tool, { files: ['a.pdf', 'b.pdf', 'c.pdf'], query: 'third' })
    expect(calls.ingest).toBe(3)
  })

  it('refuses file types the indexer cannot read and points at read', async () => {
    const host = hostWith()
    workspaceFile(host, 'index.html')
    const { calls } = fakeAccess()
    const tool = await buildRagTool(host)

    expect(await resultOf(tool, { files: ['index.html'], query: 'q' })).toMatch(/'read' instead/)
    expect(calls.ingest).toBe(0)
  })

  it('says when a document has no indexable text', async () => {
    const host = hostWith()
    workspaceFile(host, 'scanned.pdf')
    fakeAccess({ emptySplit: true })
    const tool = await buildRagTool(host)

    expect(await resultOf(tool, { files: ['scanned.pdf'], query: 'q' })).toMatch(
      /no indexable text content/,
    )
  })

  it('says when nothing matched', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    fakeAccess({ chunks: [] })
    const tool = await buildRagTool(host)

    expect(await resultOf(tool, { files: ['report.pdf'], query: 'q' })).toMatch(/No passage/)
  })

  it('returns failures as tool text instead of throwing', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    fakeAccess({ failRetrieve: new Error('embedding server exploded') })
    const tool = await buildRagTool(host)

    expect(await resultOf(tool, { files: ['report.pdf'], query: 'q' })).toMatch(
      /Document search failed: embedding server exploded/,
    )
  })

  it('prompts for the embedding model through the renderer before first use', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    const { dispatches } = fakeRendererPrep('ready')
    const { calls } = fakeAccess()
    const tool = await buildRagTool(host)

    await resultOf(tool, { files: ['report.pdf'], query: 'q' })
    await resultOf(tool, { files: ['report.pdf'], query: 'other question' })

    // One prompt per session, with the session-frozen model and backend.
    expect(dispatches).toEqual([
      { toolName: 'ragPrepareEmbeddingModel', input: { model: 'emb-model', backend: 'llamaCPP' } },
    ])
    expect(calls.ingest).toBe(1)
  })

  it('falls back to read when the user declines the download', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    const { dispatches } = fakeRendererPrep('declined')
    const { calls } = fakeAccess()
    const tool = await buildRagTool(host)

    expect(await resultOf(tool, { files: ['report.pdf'], query: 'q' })).toMatch(
      /declined the embedding model download/,
    )
    expect(await resultOf(tool, { files: ['report.pdf'], query: 'q' })).toMatch(/'read' instead/)
    expect(dispatches).toHaveLength(1)
    expect(calls.ingest).toBe(0)
    expect(calls.ensure).toBe(0)
    expect(calls.retrieve).toBe(0)
  })

  it('reports a failed download and does not search', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    const { dispatches } = fakeRendererPrep('failed', 'disk full')
    const { calls } = fakeAccess()
    const tool = await buildRagTool(host)

    const text = await resultOf(tool, { files: ['report.pdf'], query: 'q' })
    expect(text).toMatch(/could not be downloaded \(disk full\)/)
    expect(text).toMatch(/'read' instead/)
    expect(calls.ingest).toBe(0)
    expect(calls.ensure).toBe(0)
    await resultOf(tool, { files: ['report.pdf'], query: 'q' })
    expect(dispatches).toHaveLength(2)
  })

  it('searches a file once when it is named twice', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    const { calls, inquiry } = fakeAccess()
    const tool = await buildRagTool(host)

    await resultOf(tool, {
      files: ['report.pdf', '/workspace/report.pdf'],
      query: 'budget',
    })
    expect(calls.ingest).toBe(1)
    expect(inquiry().ragList).toHaveLength(1)
  })

  it('settles when the turn is aborted during ingest', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    let releaseIngest: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseIngest = resolve
    })
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const access: RagAccess = {
      ingest: async (document) => {
        started()
        await gate
        return { ...document, hash: 'h', splitDB: [makeChunk('c')] }
      },
      retrieve: async () => [],
      ensureEmbeddingServer: async () => 'http://127.0.0.1:1',
    }
    setRagAccess(access)
    const tool = await buildRagTool(host)
    const controller = new AbortController()
    const pending = tool.execute('call-1', { files: ['report.pdf'], query: 'q' }, controller.signal)
    await entered
    controller.abort()
    await expect(pending).resolves.toMatchObject({
      content: [{ text: expect.stringMatching(/cancelled/) }],
    })
    releaseIngest()
  })

  it('says how to fix it when the embedding server cannot be brought up', async () => {
    const host = hostWith()
    workspaceFile(host, 'report.pdf')
    fakeRendererPrep('ready')
    const access: RagAccess = {
      ingest: async (document) => ({ ...document, hash: 'h', splitDB: [makeChunk('c')] }),
      retrieve: async () => [],
      ensureEmbeddingServer: async () => {
        throw new Error('model file missing')
      },
    }
    setRagAccess(access)
    const tool = await buildRagTool(host)

    expect(await resultOf(tool, { files: ['report.pdf'], query: 'q' })).toMatch(
      /Could not start the embedding model "emb-model" \(model file missing\)/,
    )
    expect(await resultOf(tool, { files: ['report.pdf'], query: 'q' })).toMatch(/'read' instead/)
  })

  it('is not offered to a session without an embedding model', async () => {
    const host = hostWith({ embeddingModel: undefined })
    workspaceFile(host, 'report.pdf')
    fakeAccess()
    const resolution = await resolveCapabilities(host, ['rag'])
    expect(resolution.resolved).toEqual([])
    expect(resolution.extensionFactories).toEqual([])
  })
})

describe('formatChunks', () => {
  it('labels each passage with its file and location metadata', () => {
    const labels = new Map([
      ['/ws/report.pdf', 'report.pdf'],
      ['/ws/notes.md', 'notes.md'],
    ])
    const text = formatChunks(
      [
        makeChunk('first', { source: '/ws/report.pdf', loc: { pageNumber: 3 } }),
        makeChunk('second', { source: '/ws/notes.md', loc: { lines: { from: 10, to: 20 } } }),
        makeChunk('third', { source: '/ws/report.pdf' }),
      ],
      labels,
      5,
      2,
    )
    expect(text).toContain('3 passage(s) from 2 documents (k=5)')
    expect(text).toContain('passage 1 — report.pdf (page 3)')
    expect(text).toContain('passage 2 — notes.md (lines 10-20)')
    expect(text).toContain('passage 3 — report.pdf')
    expect(text).not.toContain('left out')
  })

  it('falls back to basename when a chunk source is not in the label map', () => {
    const text = formatChunks(
      [makeChunk('x', { source: '/ws/unknown.pdf', loc: { pageNumber: 1 } })],
      new Map(),
      5,
      1,
    )
    expect(text).toContain('unknown.pdf (page 1)')
  })

  it('omits the file label when a chunk has no source metadata', () => {
    const text = formatChunks([makeChunk('x', { loc: { pageNumber: 1 } })], new Map(), 5, 1)
    expect(text).toContain('passage 1 (page 1)')
    expect(text).not.toContain(' — ')
  })

  it('stops before the result eats the context', () => {
    const chunks = Array.from({ length: 20 }, (_, i) =>
      makeChunk(`${i} `.repeat(2000), { loc: { pageNumber: i + 1 } }),
    )
    const text = formatChunks(chunks, new Map(), 20, 1)
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 400)
    expect(text).toContain('left out')
  })
})

describe('resolveWorkspaceFile', () => {
  it('rejects empty, absolute-escaping and relative-escaping paths', () => {
    const workspaceDir = hostWith().workspaceDir
    expect(resolveWorkspaceFile(workspaceDir, '')).toBeNull()
    expect(resolveWorkspaceFile(workspaceDir, '/etc/passwd')).toBeNull()
    expect(resolveWorkspaceFile(workspaceDir, '../escape.pdf')).toBeNull()
    expect(resolveWorkspaceFile(workspaceDir, '.')).toBeNull()
  })

  it('strips the /workspace sandbox prefix and resolves the rest', () => {
    const host = hostWith()
    const file = workspaceFile(host, 'report.pdf')
    const realFile = fs.realpathSync(file)
    expect(resolveWorkspaceFile(host.workspaceDir, '/workspace/report.pdf')).toBe(realFile)
    // The prefix strip must not open an escape: /workspace/../outside stays outside.
    const outside = path.join(agentDir, 'outside.pdf')
    fs.writeFileSync(outside, 'secret')
    expect(resolveWorkspaceFile(host.workspaceDir, '/workspace/../outside.pdf')).toBeNull()
  })

  it('accepts a real absolute path inside the workspace', () => {
    const host = hostWith()
    const file = workspaceFile(host, 'report.pdf')
    const realFile = fs.realpathSync(file)
    expect(resolveWorkspaceFile(host.workspaceDir, file)).toBe(realFile)
  })
})
