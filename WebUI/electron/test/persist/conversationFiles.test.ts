import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The kernel's one-writer conversation store (architecture-target §6.1,
// step 8). Driven against real files in a temp dir: atomic upserts, index
// bookkeeping, the one-shot legacy migration, demo-mode routing and the
// save-time sanitize (orphaned tool parts + inline data URIs).

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getConversationsDir: () => dirs.real,
  getConversationsDemoDir: () => dirs.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { appLoggerInstance } = await import('../../observability/logger')
const {
  bootstrapConversations,
  deleteConversation,
  migrateLegacyConversations,
  resetConversationFilesForTest,
  saveChatTurnConversation,
  saveConversation,
  saveConversationLastMainKey,
  setConversationFileDeps,
  wipeDemoConversations,
} = await import('../../persist/conversationFiles')

const userMessage = (text: string) => ({
  id: `u-${text}`,
  role: 'user',
  parts: [{ type: 'text', text }],
  metadata: { timestamp: 1 },
})

const titledThread = (title: string) => [
  // The UI writes the title onto the FIRST message's metadata (see
  // renameConversationTitle), so that is where the index reader looks.
  { ...userMessage('hello'), metadata: { conversationTitle: title } },
  {
    id: 'a-1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'hi' }],
  },
]

/** An assistant tool part stuck mid-call — the brick-on-reload shape. */
const orphanedToolMessage = () => ({
  id: 'a-tool',
  role: 'assistant',
  parts: [
    {
      type: 'tool-comfyUI',
      toolCallId: 'call-1',
      state: 'input-available',
      input: { workflow: 'W1' },
    },
  ],
})

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function listDir(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch(() => [])
}

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-conversations-'))
  dirs.real = path.join(root, 'real')
  dirs.demo = path.join(root, 'demo')
})

let demoMode = false

beforeEach(async () => {
  resetConversationFilesForTest()
  demoMode = false
  setConversationFileDeps({ isDemoMode: () => demoMode })
  vi.mocked(appLoggerInstance.warn).mockClear()
})

afterEach(async () => {
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.demo, { recursive: true, force: true })
  resetConversationFilesForTest()
})

async function writeThreadFile(
  id: string,
  messages: unknown[],
  meta: { presetName: string; kind: 'main' | 'homeAgent' } | null = {
    presetName: 'Qwen',
    kind: 'main',
  },
): Promise<void> {
  await fs.mkdir(dirs.real, { recursive: true })
  await fs.writeFile(
    path.join(dirs.real, `${id}.json`),
    `${JSON.stringify({
      schemaVersion: 1,
      meta,
      ragHashes: [],
      messages,
      updatedAt: 1,
    })}\n`,
    'utf8',
  )
}

describe('bootstrapConversations', () => {
  it('reports empty on a fresh install', async () => {
    await expect(bootstrapConversations()).resolves.toEqual({ status: 'empty' })
  })

  it('hydrates threads and lastMainKey after a migration wrote them', async () => {
    const boot = await migrateLegacyConversations({
      conversationList: {
        '100': titledThread('First'),
        '200': [userMessage('second')],
      },
      conversationThreadMeta: {
        '100': { presetName: 'Qwen', kind: 'main' },
        '200': { presetName: 'Home Agent', kind: 'homeAgent' },
      },
      conversationRagSelection: { '100': ['hash-a'] },
      lastMainKey: '100',
    })
    expect(boot).toMatchObject({ status: 'ok', lastMainKey: '100' })
    if (boot.status !== 'ok') return
    expect(boot.threads).toHaveLength(2)

    const again = await bootstrapConversations()
    expect(again).toMatchObject({ status: 'ok', lastMainKey: '100' })
    if (again.status !== 'ok') return
    const byId = Object.fromEntries(again.threads.map((thread) => [thread.id, thread]))
    expect(byId['100'].messages).toHaveLength(2)
    expect(byId['100'].ragHashes).toEqual(['hash-a'])
    expect(byId['100'].meta).toMatchObject({ presetName: 'Qwen', kind: 'main' })
    expect(byId['200'].meta).toMatchObject({ kind: 'homeAgent' })
  })

  it('treats a thread whose file is gone as empty, not as a boot failure', async () => {
    await migrateLegacyConversations({
      conversationList: { '100': [userMessage('x')] },
      conversationThreadMeta: {},
      conversationRagSelection: {},
      lastMainKey: '100',
    })
    await fs.rm(path.join(dirs.real, '100.json'))
    const boot = await bootstrapConversations()
    expect(boot).toMatchObject({ status: 'ok', lastMainKey: '100' })
    if (boot.status !== 'ok') return
    expect(boot.threads).toEqual([{ id: '100', meta: null, ragHashes: [], messages: [] }])
  })

  it('rebuilds from thread files when index.json is unreadable', async () => {
    await writeThreadFile('800', titledThread('Survived'))
    await fs.writeFile(path.join(dirs.real, 'index.json'), '{not json', 'utf8')
    const boot = await bootstrapConversations()
    expect(boot).toMatchObject({ status: 'ok', lastMainKey: null })
    if (boot.status !== 'ok') return
    expect(boot.threads).toHaveLength(1)
    expect(boot.threads[0].id).toBe('800')
    expect(boot.threads[0].meta).toMatchObject({ presetName: 'Qwen', kind: 'main' })
    const index = await readJson(path.join(dirs.real, 'index.json'))
    expect(index).toMatchObject({
      schemaVersion: 1,
      threads: [{ id: '800', title: 'Survived' }],
    })
  })

  it('rebuilds from thread files when index.json fails schema', async () => {
    await writeThreadFile('800', titledThread('Survived'))
    await fs.writeFile(
      path.join(dirs.real, 'index.json'),
      `${JSON.stringify({ schemaVersion: 99, threads: [] })}\n`,
      'utf8',
    )
    const boot = await bootstrapConversations()
    expect(boot).toMatchObject({ status: 'ok' })
    if (boot.status !== 'ok') return
    expect(boot.threads.map((thread) => thread.id)).toEqual(['800'])
  })

  it('rebuilds from thread files when index.json is missing but threads remain', async () => {
    await writeThreadFile('800', titledThread('Orphan'))
    const boot = await bootstrapConversations()
    expect(boot).toMatchObject({ status: 'ok' })
    if (boot.status !== 'ok') return
    expect(boot.threads.map((thread) => thread.id)).toEqual(['800'])
    expect(await listDir(dirs.real)).toEqual(expect.arrayContaining(['800.json', 'index.json']))
  })
})

describe('saveConversation', () => {
  it('writes the thread atomically and upserts its index entry', async () => {
    await saveConversation({
      id: '300',
      meta: { presetName: 'Qwen', kind: 'main' },
      ragHashes: [],
      messages: titledThread('My thread'),
      lastMainKey: '300',
    })
    const doc = await readJson(path.join(dirs.real, '300.json'))
    expect(doc.schemaVersion).toBe(1)
    expect(doc.meta).toMatchObject({ presetName: 'Qwen' })

    const index = await readJson(path.join(dirs.real, 'index.json'))
    expect(index).toMatchObject({
      schemaVersion: 1,
      lastMainKey: '300',
      threads: [{ id: '300', title: 'My thread', presetName: 'Qwen', kind: 'main' }],
    })

    // A second save replaces the entry instead of duplicating it.
    await saveConversation({
      id: '300',
      meta: { presetName: 'Qwen', kind: 'main' },
      ragHashes: [],
      messages: titledThread('Renamed'),
    })
    const indexAgain = await readJson(path.join(dirs.real, 'index.json'))
    expect(indexAgain.threads as unknown[]).toHaveLength(1)
    expect((indexAgain.threads as { title?: string }[])[0].title).toBe('Renamed')
  })

  it('repairs an orphaned tool call before the file is written', async () => {
    await saveConversation({
      id: '400',
      meta: null,
      ragHashes: [],
      messages: [userMessage('go'), orphanedToolMessage()],
    })
    const doc = await readJson(path.join(dirs.real, '400.json'))
    const messages = doc.messages as {
      parts: { state?: string; output?: unknown; errorText?: string }[]
    }[]
    const toolPart = messages[1].parts[0]
    // The repair completes the orphan with a synthetic output-error part.
    expect(toolPart.state).toBe('output-error')
    expect(toolPart.errorText).toContain('interrupted')
  })

  it('routes to the demo directory and the wipe removes it', async () => {
    demoMode = true
    await saveConversation({
      id: '500',
      meta: null,
      ragHashes: [],
      messages: [userMessage('demo')],
    })
    expect((await listDir(dirs.demo)).sort()).toEqual(['500.json', 'index.json'])
    expect(await listDir(dirs.real)).toEqual([])

    await wipeDemoConversations()
    expect(await listDir(dirs.demo)).toEqual([])
  })

  it('orders concurrent saves of different threads through the index', async () => {
    await Promise.all([
      saveConversation({
        id: '600',
        meta: null,
        ragHashes: [],
        messages: [userMessage('a')],
      }),
      saveConversation({
        id: '700',
        meta: null,
        ragHashes: [],
        messages: [userMessage('b')],
      }),
      saveConversationLastMainKey('600'),
    ])
    const index = await readJson(path.join(dirs.real, 'index.json'))
    const ids = (index.threads as { id: string }[]).map((thread) => thread.id).sort()
    expect(ids).toEqual(['600', '700'])
    expect(index.lastMainKey).toBe('600')
  })

  it('rejects an id that would overwrite index.json', async () => {
    await expect(
      saveConversation({
        id: 'index',
        meta: null,
        ragHashes: [],
        messages: [userMessage('attacker')],
      }),
    ).rejects.toThrow(/invalid conversation id/)
    expect(await listDir(dirs.real)).toEqual([])
  })

  it('rejects a path-shaped id', async () => {
    await expect(
      saveConversation({
        id: '../x',
        meta: null,
        ragHashes: [],
        messages: [userMessage('attacker')],
      }),
    ).rejects.toThrow(/invalid conversation id/)
    expect(await listDir(dirs.real)).toEqual([])
  })
})

describe('saveChatTurnConversation', () => {
  const assistantMessage = (id: string) => ({
    id,
    role: 'assistant',
    parts: [{ type: 'text', text: 'ok' }],
  })

  async function storedMessageIds(id: string): Promise<string[]> {
    const doc = await readJson(path.join(dirs.real, `${id}.json`))
    return (doc.messages as { id: string }[]).map((message) => message.id)
  }

  it('restores the history a resumed renderer dropped', async () => {
    const turn = { id: '900', meta: null, ragHashes: [] }
    await saveChatTurnConversation({
      ...turn,
      messages: [userMessage('one'), assistantMessage('a-1'), userMessage('two')],
    })
    await saveChatTurnConversation({
      ...turn,
      messages: [
        userMessage('one'),
        assistantMessage('a-1'),
        userMessage('two'),
        assistantMessage('a-2'),
      ],
    })

    // What a renderer that resumed mid-turn submits next: the turn it adopted,
    // then the new prompt.
    await saveChatTurnConversation({
      ...turn,
      messages: [assistantMessage('a-2'), userMessage('three')],
    })

    expect(await storedMessageIds('900')).toEqual(['u-one', 'a-1', 'u-two', 'a-2', 'u-three'])
  })

  it('still lets a regenerate truncate the thread from the end', async () => {
    const turn = { id: '901', meta: null, ragHashes: [] }
    await saveChatTurnConversation({
      ...turn,
      messages: [userMessage('one'), assistantMessage('a-1'), userMessage('two')],
    })
    await saveChatTurnConversation({ ...turn, messages: [userMessage('one')] })

    expect(await storedMessageIds('901')).toEqual(['u-one'])
  })
})

describe('deleteConversation', () => {
  it('removes the file and the index entry', async () => {
    await migrateLegacyConversations({
      conversationList: { '100': [userMessage('x')], '200': [userMessage('y')] },
      conversationThreadMeta: {},
      conversationRagSelection: {},
      lastMainKey: null,
    })
    await deleteConversation('100')
    expect((await listDir(dirs.real)).sort()).toEqual(['200.json', 'index.json'])
    const index = await readJson(path.join(dirs.real, 'index.json'))
    expect((index.threads as { id: string }[]).map((thread) => thread.id)).toEqual(['200'])
  })

  it('is a no-op for an unknown id', async () => {
    await expect(deleteConversation('missing')).resolves.toBeUndefined()
  })
})

describe('migrateLegacyConversations', () => {
  it('writes an index even for an empty legacy state, so it never runs twice', async () => {
    const boot = await migrateLegacyConversations({
      conversationList: {},
      conversationThreadMeta: {},
      conversationRagSelection: {},
      lastMainKey: null,
    })
    expect(boot).toMatchObject({ status: 'ok', threads: [] })
    const again = await bootstrapConversations()
    expect(again.status).toBe('ok')
  })

  it('merges into an existing index instead of refusing (the stranded-threads rescue)', async () => {
    await migrateLegacyConversations({
      conversationList: { '100': [userMessage('first')] },
      conversationThreadMeta: {},
      conversationRagSelection: {},
      lastMainKey: '100',
    })
    const second = await migrateLegacyConversations({
      conversationList: { '999': [userMessage('rescued')] },
      conversationThreadMeta: {},
      conversationRagSelection: {},
      lastMainKey: '999',
    })
    expect(second).toMatchObject({ status: 'ok', lastMainKey: '100' })
    if (second.status !== 'ok') return
    expect(second.threads.map((thread) => thread.id).sort()).toEqual(['100', '999'])
    expect(await listDir(dirs.real)).toEqual(expect.arrayContaining(['100.json', '999.json']))
  })

  it('is idempotent: an id the files already hold is not written twice', async () => {
    await migrateLegacyConversations({
      conversationList: { '100': [userMessage('first')] },
      conversationThreadMeta: {},
      conversationRagSelection: {},
      lastMainKey: '100',
    })
    const second = await migrateLegacyConversations({
      conversationList: { '100': [userMessage('attacker')] },
      conversationThreadMeta: {},
      conversationRagSelection: {},
      lastMainKey: '100',
    })
    if (second.status !== 'ok') throw new Error('expected ok')
    const messages = second.threads[0].messages as { parts: { text?: string }[] }[]
    expect(messages[0].parts[0].text).toBe('first')
  })

  it('migrates the Home Agent singleton id', async () => {
    const boot = await migrateLegacyConversations({
      conversationList: { __aipg_home_agent__: [userMessage('hi')] },
      conversationThreadMeta: {
        __aipg_home_agent__: { presetName: 'Home Agent', kind: 'homeAgent' },
      },
      conversationRagSelection: {},
      lastMainKey: null,
    })
    expect(boot).toMatchObject({ status: 'ok' })
    if (boot.status !== 'ok') return
    expect(boot.threads).toHaveLength(1)
    expect(boot.threads[0].id).toBe('__aipg_home_agent__')
    expect(boot.threads[0].meta).toMatchObject({ kind: 'homeAgent' })
    expect(await listDir(dirs.real)).toEqual(
      expect.arrayContaining(['__aipg_home_agent__.json', 'index.json']),
    )
  })

  it('skips a legacy id that would overwrite the index file', async () => {
    const boot = await migrateLegacyConversations({
      conversationList: {
        index: [userMessage('attacker')],
        '100': [userMessage('keeper')],
      },
      conversationThreadMeta: {},
      conversationRagSelection: {},
      lastMainKey: null,
    })
    expect(boot).toMatchObject({ status: 'ok' })
    if (boot.status !== 'ok') return
    expect(boot.threads.map((thread) => thread.id)).toEqual(['100'])
    const index = await readJson(path.join(dirs.real, 'index.json'))
    expect(index.schemaVersion).toBe(1)
    expect((index.threads as { id: string }[]).map((thread) => thread.id)).toEqual(['100'])
  })
})
