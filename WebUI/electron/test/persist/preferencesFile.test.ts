import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The kernel's one-writer preferences store (architecture-target §6.1,
// step 8). Driven against a real file in a temp dir: the sectioned
// read/write/migrate contract, schema rejection of a corrupt file, unsafe
// section names, and demo routing + wipe.

const files = vi.hoisted(() => ({ real: '', demo: '' }))
let tmpRoot = ''

vi.mock('../../persist/userDataPaths.ts', () => ({
  getPreferencesFile: () => files.real,
  getPreferencesDemoFile: () => files.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { appLoggerInstance } = await import('../../observability/logger')
const {
  migratePreferenceSection,
  readAllPreferences,
  readPreferenceSection,
  resetPreferencesFileForTest,
  setPreferencesFileDeps,
  wipeDemoPreferences,
  writePreferenceSection,
} = await import('../../persist/preferencesFile')

const asRecord = (value: unknown) => value as Record<string, unknown>

async function readRaw(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  resetPreferencesFileForTest()
  if (!tmpRoot) {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-preferences-'))
  }
  files.real = path.join(tmpRoot, 'preferences.json')
  files.demo = path.join(tmpRoot, 'preferences-demo.json')
  for (const file of [files.real, files.demo]) await fs.rm(file, { force: true })
  setPreferencesFileDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  resetPreferencesFileForTest()
})

describe('the kernel preferences file store', () => {
  it('reads an absent file as no sections', async () => {
    expect(await readAllPreferences()).toEqual({})
  })

  it('writes a section into a fresh file with a schema version', async () => {
    await writePreferenceSection('theme', { selected: 'dark' })
    const raw = asRecord(await readRaw(files.real))
    expect(raw?.schemaVersion).toBe(1)
    expect(asRecord(raw?.sections)).toEqual({ theme: { selected: 'dark' } })
  })

  it('merges sections without touching the others', async () => {
    await writePreferenceSection('theme', { selected: 'dark' })
    await writePreferenceSection('developerSettings', { keepModelsLoaded: true })
    expect(await readAllPreferences()).toEqual({
      theme: { selected: 'dark' },
      developerSettings: { keepModelsLoaded: true },
    })
  })

  it('reads a single section for a main-side consumer', async () => {
    await writePreferenceSection('developerSettings', { openDevConsoleOnStartup: false })
    expect(asRecord(await readPreferenceSection('developerSettings'))).toEqual({
      openDevConsoleOnStartup: false,
    })
    expect(await readPreferenceSection('theme')).toBeUndefined()
  })

  it('treats a corrupt file as empty rather than throwing', async () => {
    await fs.writeFile(files.real, '{not json', 'utf8')
    expect(await readAllPreferences()).toEqual({})
    await writePreferenceSection('theme', { selected: 'dark' })
    expect(await readAllPreferences()).toEqual({ theme: { selected: 'dark' } })
  })

  it('treats a schema-invalid file as empty rather than throwing', async () => {
    await fs.writeFile(files.real, JSON.stringify({ sections: {} }), 'utf8')
    expect(await readAllPreferences()).toEqual({})
    expect(appLoggerInstance.warn).toHaveBeenCalled()
  })

  it('migrates a section only when it is absent', async () => {
    expect(await migratePreferenceSection('theme', { selected: 'dark' })).toBe(true)
    expect(await migratePreferenceSection('theme', { selected: 'light' })).toBe(false)
    expect(asRecord((await readAllPreferences()).theme)).toEqual({ selected: 'dark' })
  })

  it('rejects an unsafe section name', async () => {
    await expect(writePreferenceSection('../escape', {})).rejects.toThrow(
      /invalid preference section/,
    )
    await expect(migratePreferenceSection('a b', {})).rejects.toThrow(/invalid preference section/)
  })

  it('routes through the demo file and wipes it on demand', async () => {
    setPreferencesFileDeps({ isDemoMode: () => true })
    await writePreferenceSection('theme', { selected: 'bmg' })
    expect(await readAllPreferences()).toEqual({ theme: { selected: 'bmg' } })
    expect(await readRaw(files.real)).toBeNull()

    await wipeDemoPreferences()
    expect(await readRaw(files.demo)).toBeNull()
  })

  it('serializes concurrent writes so no section is lost', async () => {
    const names = ['theme', 'developerSettings', 'modelPreferences', 'textToSpeech']
    await Promise.all(names.map((name) => writePreferenceSection(name, { n: name })))
    expect(Object.keys(await readAllPreferences()).sort()).toEqual([...names].sort())
  })
})
