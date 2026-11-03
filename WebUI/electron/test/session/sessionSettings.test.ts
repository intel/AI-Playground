import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getSessionsDemoDir: () => dirs.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { createSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const { presetSettingsFor, readSessionSettings, writePresetSettings } =
  await import('../../session/sessionSettings')

async function settingsOnDisk(id: string): Promise<unknown> {
  const file = JSON.parse(await fs.readFile(path.join(dirs.real, id, 'session.json'), 'utf8'))
  return file.settings
}

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-settings-'))
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

describe('Session Settings', () => {
  it('copies the Default Settings into the Session on first read', async () => {
    const session = await createSession()

    const bag = await presetSettingsFor(session.id, 'Image Gen', 'Image Gen', { seed: 7 })

    expect(bag).toEqual({ values: { seed: 7 }, fromDefaults: true })
    expect(await settingsOnDisk(session.id)).toEqual({
      'Image Gen': { bags: { 'Image Gen': { values: { seed: 7 }, fromDefaults: true } } },
    })
  })

  it("returns the Session's copy on later reads, not the current defaults", async () => {
    const session = await createSession()
    await presetSettingsFor(session.id, 'Image Gen', 'Image Gen', { seed: 7 })

    const later = await presetSettingsFor(session.id, 'Image Gen', 'Image Gen', { seed: 99 })

    expect(later.values).toEqual({ seed: 7 })
  })

  it('keeps each Session to its own settings', async () => {
    const first = await createSession()
    const second = await createSession()
    await writePresetSettings(first.id, 'Image Gen', {
      variant: 'Fast',
      bags: { 'Image Gen:Fast': { values: { seed: 1 }, fromDefaults: false } },
    })

    expect(await readSessionSettings(second.id)).toEqual({})
    expect(
      (await presetSettingsFor(second.id, 'Image Gen', 'Image Gen:Fast', { seed: 5 })).values,
    ).toEqual({ seed: 5 })
    expect((await readSessionSettings(first.id))['Image Gen']).toEqual({
      variant: 'Fast',
      bags: { 'Image Gen:Fast': { values: { seed: 1 }, fromDefaults: false } },
    })
  })

  it('gives a new Session the saved defaults while older Sessions keep their copy', async () => {
    const old = await createSession()
    await presetSettingsFor(old.id, 'Chat', 'Chat', { temperature: 0.7 })

    const savedAsDefault = { temperature: 0.2 }
    const fresh = await createSession()

    expect((await presetSettingsFor(fresh.id, 'Chat', 'Chat', savedAsDefault)).values).toEqual({
      temperature: 0.2,
    })
    expect((await presetSettingsFor(old.id, 'Chat', 'Chat', savedAsDefault)).values).toEqual({
      temperature: 0.7,
    })
  })

  it('takes the Default Settings again once a reset dropped the bag', async () => {
    const session = await createSession()
    await writePresetSettings(session.id, 'Chat', {
      bags: { Chat: { values: { temperature: 1 }, fromDefaults: false } },
    })

    await writePresetSettings(session.id, 'Chat', { bags: {} })

    expect(await presetSettingsFor(session.id, 'Chat', 'Chat', { temperature: 0.3 })).toEqual({
      values: { temperature: 0.3 },
      fromDefaults: true,
    })
  })

  it('drops an unreadable entry instead of failing the whole Session', async () => {
    const session = await createSession()
    await writePresetSettings(session.id, 'Chat', {
      bags: { Chat: { values: { temperature: 1 }, fromDefaults: false } },
    })
    const file = path.join(dirs.real, session.id, 'session.json')
    const json = JSON.parse(await fs.readFile(file, 'utf8'))
    await fs.writeFile(file, JSON.stringify({ ...json, settings: { ...json.settings, Bad: 'x' } }))

    expect(Object.keys(await readSessionSettings(session.id))).toEqual(['Chat'])
  })
})
