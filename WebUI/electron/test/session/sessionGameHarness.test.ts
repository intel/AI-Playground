import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Game Agent and Quick Coder in a Session: one Harness Session per (Session,
// games preset), whose workspace is a game folder in the games library — never
// part of the Session Folder, so deleting the Session leaves the game alone.

const dirs = vi.hoisted(() => ({ real: '', demo: '', games: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getSessionsDemoDir: () => dirs.demo,
  getGamesDir: () => dirs.games,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../kernel/kernelBus', () => ({ emitSessionChanged: vi.fn() }))

const { createSession, deleteSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { cleanUpHarnessSessionsOnDelete, harnessSessionFor } =
  await import('../../session/sessionHarness')
const { trackAgentTurnInSession } = await import('../../session/sessionAgentTurns')
const { readHistoryEntries } = await import('../../session/sessionHistory')
const { noteGeneratedMedia } = await import('../../agent/generatedMedia')
const { sessionPaths } = await import('../../session/sessions')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-games-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.games = path.join(root, 'games')
})

beforeEach(() => {
  setSessionDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.games, { recursive: true, force: true })
})

async function makeGame(slug: string): Promise<string> {
  const dir = path.join(dirs.games, slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'index.html'), '<canvas></canvas>')
  return dir
}

describe('Game Agent and Quick Coder Harness Sessions', () => {
  it('has no workspace until the first turn mints the game', async () => {
    const session = await createSession()

    const harness = await harnessSessionFor(session.id, 'Game Agent', { kind: 'game' })

    expect(harness.harnessSessionId).toMatch(/^aipg-agent-/)
    expect(harness.workspaceDir).toBe('')
  })

  it('keeps the game folder, so a second visit continues the same game', async () => {
    const session = await createSession()
    const game = await makeGame('space-race')
    const first = await harnessSessionFor(session.id, 'Game Agent', {
      kind: 'game',
      gameDir: game,
    })

    const again = await harnessSessionFor(session.id, 'Game Agent', { kind: 'game' })

    expect(again).toEqual({ harnessSessionId: first.harnessSessionId, workspaceDir: game })
  })

  it('gives Game Agent and Quick Coder their own Harness Session and game', async () => {
    const session = await createSession()
    const oneShot = await makeGame('one-shot')
    const studio = await makeGame('studio')

    const quick = await harnessSessionFor(session.id, 'Quick Coder', {
      kind: 'game',
      gameDir: oneShot,
    })
    const agent = await harnessSessionFor(session.id, 'Game Agent', {
      kind: 'game',
      gameDir: studio,
    })

    expect(quick.harnessSessionId).not.toBe(agent.harnessSessionId)
    expect(quick.workspaceDir).toBe(oneShot)
    expect(agent.workspaceDir).toBe(studio)
  })

  it('refuses a workspace outside the games library', async () => {
    const session = await createSession()

    await expect(
      harnessSessionFor(session.id, 'Game Agent', { kind: 'game', gameDir: os.tmpdir() }),
    ).rejects.toThrow(/games library/)
  })

  it('starts a fresh Harness Session on the handed-over game, still cleaned up with the old one', async () => {
    const session = await createSession()
    const earlier = await makeGame('earlier')
    const handedOver = await makeGame('handed-over')
    const old = await harnessSessionFor(session.id, 'Game Agent', {
      kind: 'game',
      gameDir: earlier,
    })

    const fresh = await harnessSessionFor(session.id, 'Game Agent', {
      kind: 'game',
      gameDir: handedOver,
      fresh: true,
    })

    expect(fresh.harnessSessionId).not.toBe(old.harnessSessionId)
    expect(fresh.workspaceDir).toBe(handedOver)
    const cleaned: string[] = []
    const stop = cleanUpHarnessSessionsOnDelete(async (id) => cleaned.push(id))
    await deleteSession(session.id)
    stop()
    expect(cleaned.sort()).toEqual([old.harnessSessionId, fresh.harnessSessionId].sort())
  })

  it('never deletes the game folder with the Session', async () => {
    const session = await createSession()
    const game = await makeGame('keep-me')
    await harnessSessionFor(session.id, 'Game Agent', { kind: 'game', gameDir: game })
    const stop = cleanUpHarnessSessionsOnDelete(async () => {})

    await deleteSession(session.id)
    stop()

    await expect(fs.readFile(path.join(game, 'index.html'), 'utf8')).resolves.toBe(
      '<canvas></canvas>',
    )
  })
})

describe("a game turn's History Entry", () => {
  it("references the Session's copy of the media, not the game folder's", async () => {
    const session = await createSession()
    const game = await makeGame('ships')
    const turn = trackAgentTurnInSession({
      sessionRef: session.id,
      presetName: 'Game Agent',
      workspaceDir: game,
      prompt: 'draw the ship',
    })

    noteGeneratedMedia(
      game,
      ['generated/ship.png'],
      [path.join(sessionPaths(session.id).filesDir, 'ship.png')],
    )
    await turn.settle({ sessionId: 'h1', turnId: 't1', outcome: 'completed', reply: 'done' })

    expect(await readHistoryEntries(session.id)).toEqual([
      expect.objectContaining({
        preset: 'Game Agent',
        artifacts: [{ path: 'files/ship.png', mediaType: 'image' }],
      }),
    ])
  })
})
