import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryEntry } from '@/types/sessionIpc'

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getSessionsDemoDir: () => dirs.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { createSession, readSession, resetSessionsForTest, setSessionDeps, sessionPaths } =
  await import('../../session/sessions')
const { appendHistoryEntry } = await import('../../session/sessionHistory')
const { buildSessionUpdate, takeSessionUpdate, listSessionHistory, getSessionHistoryEntry } =
  await import('../../session/sessionUpdate')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-update-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
})

beforeEach(() => {
  setSessionDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
})

const at = (hours: number, minutes: number) => new Date(2026, 10, 3, hours, minutes).getTime()

function entry(overrides: Partial<HistoryEntry>): HistoryEntry {
  return {
    id: 'entry-1',
    timestamp: at(14, 5),
    preset: 'Image Gen',
    kind: 'image',
    prompt: 'a red fox',
    status: 'completed',
    artifacts: [],
    ...overrides,
  }
}

const imageTurn = {
  preset: 'Image Gen',
  kind: 'image' as const,
  prompt: 'a red fox',
  status: 'completed' as const,
  artifacts: [{ path: 'files/fox.png', mediaType: 'image' as const }],
}

const agentTurn = {
  preset: 'Agent',
  kind: 'agent' as const,
  prompt: 'describe that image',
  status: 'completed' as const,
  artifacts: [],
  response: 'A fox.',
}

describe('buildSessionUpdate', () => {
  it('writes one template line per entry, files for media and a response excerpt otherwise', () => {
    const update = buildSessionUpdate([
      entry({
        id: 'a',
        artifacts: [
          { path: 'files/fox.png', mediaType: 'image' },
          { path: 'files/fox-2.png', mediaType: 'image' },
        ],
      }),
      entry({
        id: 'b',
        timestamp: at(9, 30),
        preset: 'Chat',
        kind: 'chat',
        prompt: 'what is a fox?',
        response: 'A fox is a small omnivorous mammal. '.repeat(20),
      }),
    ])

    const lines = update!.split('\n')
    expect(lines).toContain('[14:05] Image Gen: "a red fox" → files/fox.png, files/fox-2.png')
    const chatLine = lines.find((line) => line.startsWith('[09:30] Chat: "what is a fox?" → '))!
    expect(chatLine).toContain('"A fox is a small omnivorous mammal.')
    expect(chatLine.length).toBeLessThan(260)
  })

  it('says how a turn ended when it produced nothing', () => {
    const update = buildSessionUpdate([entry({ status: 'failed' })])
    expect(update).toContain('[14:05] Image Gen: "a red fox" → (failed)')
  })

  it('hands artifact paths out as the consumer sees them', () => {
    const update = buildSessionUpdate(
      [entry({ artifacts: [{ path: 'files/fox.png', mediaType: 'image' }] })],
      { artifactPath: (p) => p.replace(/^files\//, '') },
    )
    expect(update).toContain('→ fox.png')
  })

  it('returns nothing when there is nothing new', () => {
    expect(buildSessionUpdate([])).toBeNull()
  })

  it('keeps the newest entries within the cap and ends with the omitted line', () => {
    const entries = Array.from({ length: 40 }, (_, index) =>
      entry({ id: `e${index}`, prompt: `prompt number ${index} ${'x'.repeat(40)}` }),
    )

    const update = buildSessionUpdate(entries)!

    expect(update.length).toBeLessThanOrEqual(1500)
    expect(update).toContain('prompt number 39 ')
    expect(update).not.toContain('prompt number 0 ')
    const kept = update.split('\n').filter((line) => line.startsWith('[14:05]')).length
    expect(update.split('\n').at(-1)).toBe(
      `${40 - kept} earlier entries omitted — use \`session_history\``,
    )
  })
})

describe('takeSessionUpdate', () => {
  it('reports the entries since the consumer last took one, and nothing the second time', async () => {
    const { id } = await createSession()
    await appendHistoryEntry(id, imageTurn)

    const first = await takeSessionUpdate(id, { key: 'agent-1', ownPreset: 'Agent' })
    expect(first).toContain('Image Gen: "a red fox" → files/fox.png')

    expect(await takeSessionUpdate(id, { key: 'agent-1', ownPreset: 'Agent' })).toBeNull()

    await appendHistoryEntry(id, { ...imageTurn, prompt: 'a blue fox' })
    const third = await takeSessionUpdate(id, { key: 'agent-1', ownPreset: 'Agent' })
    expect(third).toContain('a blue fox')
    expect(third).not.toContain('a red fox')
  })

  it("leaves out the consumer's own turns", async () => {
    const { id } = await createSession()
    await takeSessionUpdate(id, { key: 'agent-1', ownPreset: 'Agent' })
    await appendHistoryEntry(id, agentTurn)

    expect(await takeSessionUpdate(id, { key: 'agent-1', ownPreset: 'Agent' })).toBeNull()
  })

  it('keeps an independent cursor per consumer, stored in session.json', async () => {
    const { id } = await createSession()
    await appendHistoryEntry(id, imageTurn)
    await takeSessionUpdate(id, { key: 'agent-1', ownPreset: 'Agent' })
    await appendHistoryEntry(id, agentTurn)

    const chat = await takeSessionUpdate(id, { key: 'chat', isOwn: (e) => e.kind === 'chat' })
    expect(chat).toContain('a red fox')
    expect(chat).toContain('Agent: "describe that image" → "A fox."')

    const file = await readSession(id)
    expect(Object.keys(file.updateCursors).sort()).toEqual(['agent-1', 'chat'])
  })

  it('shows Session Folder files relative to the consumer workspace', async () => {
    const { id } = await createSession()
    await appendHistoryEntry(id, imageTurn)

    const update = await takeSessionUpdate(id, {
      key: 'agent-1',
      workspaceDir: sessionPaths(id).filesDir,
    })
    expect(update).toContain('→ fox.png')
  })
})

describe('session_history', () => {
  async function seeded() {
    const { id } = await createSession()
    await appendHistoryEntry(id, imageTurn)
    await appendHistoryEntry(id, agentTurn)
    await appendHistoryEntry(id, { ...imageTurn, prompt: `a blue fox ${'y'.repeat(200)}` })
    return id
  }

  it('lists newest first with short prompts, filtered by preset and paged', async () => {
    const id = await seeded()

    const all = await listSessionHistory(id, {})
    expect(all.map((row) => row.preset)).toEqual(['Image Gen', 'Agent', 'Image Gen'])
    expect(all[0].prompt.length).toBeLessThanOrEqual(80)
    expect(all[0].prompt.startsWith('a blue fox')).toBe(true)

    const images = await listSessionHistory(id, { preset: 'Image Gen' })
    expect(images.map((row) => row.prompt.slice(0, 10))).toEqual(['a blue fox', 'a red fox'])

    const page = await listSessionHistory(id, { limit: 1, offset: 1 })
    expect(page.map((row) => row.preset)).toEqual(['Agent'])
  })

  it('gets one entry in full, with paths as the consumer sees them', async () => {
    const id = await seeded()
    const [, , first] = await listSessionHistory(id, {})

    const full = await getSessionHistoryEntry(id, first.id, sessionPaths(id).filesDir)
    expect(full).toMatchObject({
      id: first.id,
      preset: 'Image Gen',
      prompt: 'a red fox',
      artifacts: [{ path: 'fox.png', mediaType: 'image' }],
    })
    expect(await getSessionHistoryEntry(id, 'entry-missing')).toBeNull()
  })
})
