import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// What the Session module keeps for agent presets: one Harness Session per
// (Session, agent preset), and the display timeline the renderer saves. Asserted on the Session Folder's own files.

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getSessionsDemoDir: () => dirs.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { createSession, deleteSession, onSessionDeleted, openSession } =
  await import('../../session/sessions')
const { resetSessionsForTest, setSessionDeps } = await import('../../session/sessions')
const { harnessSessionFor } = await import('../../session/sessionHarness')
const { upsertTimelineMessages } = await import('../../session/sessionTimeline')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-agent-'))
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

async function sessionJson(id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(dirs.real, id, 'session.json'), 'utf8'))
}

describe('Harness Sessions of a Session', () => {
  it('mints one Harness Session per agent preset and returns it again', async () => {
    const session = await createSession()

    const first = await harnessSessionFor(session.id, 'Agent')
    const again = await harnessSessionFor(session.id, 'Agent')
    const other = await harnessSessionFor(session.id, 'Game Agent')

    expect(first.harnessSessionId).toMatch(/^aipg-agent-/)
    expect(again.harnessSessionId).toBe(first.harnessSessionId)
    expect(other.harnessSessionId).not.toBe(first.harnessSessionId)
    expect((await sessionJson(session.id)).harnessSessions).toEqual({
      Agent: first.harnessSessionId,
      'Game Agent': other.harnessSessionId,
    })
  })

  it("roots the agent's workspace in the Session's files folder", async () => {
    const session = await createSession()

    const { workspaceDir } = await harnessSessionFor(session.id, 'Agent')

    expect(workspaceDir).toBe(path.join(dirs.real, session.id, 'files'))
  })

  it("tells deletion listeners the deleted Session's Harness Sessions", async () => {
    const session = await createSession()
    const { harnessSessionId } = await harnessSessionFor(session.id, 'Agent')
    const heard: string[][] = []
    onSessionDeleted((_id, deleted) => {
      heard.push(Object.values(deleted?.harnessSessions ?? {}))
    })

    await deleteSession(session.id)

    expect(heard).toEqual([[harnessSessionId]])
  })
})

describe('display timeline', () => {
  it('appends new messages and replaces ones it already holds, keeping their place', async () => {
    const session = await createSession()
    const user = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }
    const draft = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'wor' }] }
    const settled = { ...draft, parts: [{ type: 'text', text: 'working' }] }
    const next = { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'again' }] }

    await upsertTimelineMessages(session.id, [user, draft])
    await upsertTimelineMessages(session.id, [user, settled, next])

    expect((await openSession(session.id)).timeline).toEqual([user, settled, next])
  })
})
