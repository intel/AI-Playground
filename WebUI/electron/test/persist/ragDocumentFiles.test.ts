import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The kernel's one-writer RAG document store (architecture-target §6.1,
// step 8). Driven against a real file in a temp dir: the section-shaped
// read/write/migrate contract, schema rejection of a corrupt file or
// payload, and demo routing + wipe.

const files = vi.hoisted(() => ({ real: '', demo: '' }))
let tmpRoot = ''

vi.mock('../../persist/userDataPaths.ts', () => ({
  getRagDocumentsFile: () => files.real,
  getRagDocumentsDemoFile: () => files.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const {
  migrateRagDocumentSection,
  readRagDocumentSection,
  resetRagDocumentFilesForTest,
  setRagDocumentFilesDeps,
  wipeDemoRagDocuments,
  writeRagDocumentSection,
} = await import('../../persist/ragDocumentFiles')

const DOCUMENTS = [
  { filename: 'a.txt', filepath: '/tmp/a.txt', hash: 'h1', isChecked: true, splitDB: [] },
  { filename: 'b.txt', filepath: '/tmp/b.txt', hash: 'h2', isChecked: false, splitDB: [] },
]

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
  resetRagDocumentFilesForTest()
  if (!tmpRoot) {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-rag-documents-'))
  }
  files.real = path.join(tmpRoot, 'rag', 'documents.json')
  files.demo = path.join(tmpRoot, 'rag-demo', 'documents.json')
  for (const file of [files.real, files.demo]) await fs.rm(file, { force: true })
  setRagDocumentFilesDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  resetRagDocumentFilesForTest()
})

describe('the kernel rag documents file store', () => {
  it('reads an absent file as null (the never-migrated state)', async () => {
    expect(await readRagDocumentSection()).toBeNull()
  })

  it('writes the section into a fresh file with a schema version', async () => {
    await writeRagDocumentSection({ ragList: DOCUMENTS })
    const raw = asRecord(await readRaw(files.real))
    expect(raw?.schemaVersion).toBe(1)
    expect(raw?.documents).toEqual(DOCUMENTS)
  })

  it('replaces the list without leaving stale documents behind', async () => {
    await writeRagDocumentSection({ ragList: DOCUMENTS })
    await writeRagDocumentSection({ ragList: [DOCUMENTS[0]] })
    const section = await readRagDocumentSection()
    expect(section?.ragList).toEqual([DOCUMENTS[0]])
  })

  it('keeps split text verbatim — the payload is opaque', async () => {
    const withText = [{ ...DOCUMENTS[0], splitDB: [{ pageContent: 'full text' }] }]
    await writeRagDocumentSection({ ragList: withText })
    const raw = asRecord(await readRaw(files.real))
    expect(raw?.documents).toEqual(withText)
  })

  it('rejects a payload that is not { ragList: [...] }', async () => {
    await expect(writeRagDocumentSection({ wrong: true })).rejects.toThrow(/rag document section/)
    await expect(writeRagDocumentSection({ ragList: 'nope' })).rejects.toThrow(
      /rag document section/,
    )
    expect(await readRaw(files.real)).toBeNull()
  })

  it('migrates only when the file is absent', async () => {
    expect(await migrateRagDocumentSection({ ragList: DOCUMENTS })).toBe(true)
    expect(await migrateRagDocumentSection({ ragList: [DOCUMENTS[1]] })).toBe(false)
    const section = await readRagDocumentSection()
    expect(section?.ragList).toEqual(DOCUMENTS)
  })

  it('treats a corrupt file as a failed read, not as never-migrated', async () => {
    await fs.mkdir(path.dirname(files.real), { recursive: true })
    await fs.writeFile(files.real, 'not json', 'utf8')
    await expect(readRagDocumentSection()).rejects.toThrow(/unreadable/)
    await expect(migrateRagDocumentSection({ ragList: DOCUMENTS })).rejects.toThrow(/unreadable/)
    expect(await fs.readFile(files.real, 'utf8')).toBe('not json')
  })

  it('replaces a corrupt file on the next write', async () => {
    await fs.mkdir(path.dirname(files.real), { recursive: true })
    await fs.writeFile(files.real, 'not json', 'utf8')
    await writeRagDocumentSection({ ragList: DOCUMENTS })
    const section = await readRagDocumentSection()
    expect(section?.ragList).toEqual(DOCUMENTS)
  })

  it('treats a schema-invalid file as unreadable too', async () => {
    await fs.mkdir(path.dirname(files.real), { recursive: true })
    await fs.writeFile(files.real, JSON.stringify({ schemaVersion: 1, documents: 'nope' }), 'utf8')
    await expect(readRagDocumentSection()).rejects.toThrow(/unreadable/)
    await expect(migrateRagDocumentSection({ ragList: DOCUMENTS })).rejects.toThrow(/unreadable/)
  })

  it('routes writes through the demo file when demo mode is on', async () => {
    setRagDocumentFilesDeps({ isDemoMode: () => true })
    await writeRagDocumentSection({ ragList: DOCUMENTS })
    expect(await readRaw(files.real)).toBeNull()
    expect((await readRaw(files.demo))?.documents).toEqual(DOCUMENTS)
  })

  it('wipes only the demo file', async () => {
    await writeRagDocumentSection({ ragList: DOCUMENTS })
    setRagDocumentFilesDeps({ isDemoMode: () => true })
    await writeRagDocumentSection({ ragList: [DOCUMENTS[0]] })
    await wipeDemoRagDocuments()
    expect(await readRaw(files.demo)).toBeNull()
    setRagDocumentFilesDeps({ isDemoMode: () => false })
    const real = await readRagDocumentSection()
    expect(real?.ragList).toEqual(DOCUMENTS)
  })

  it('creates the rag directory on first write', async () => {
    await writeRagDocumentSection({ ragList: [] })
    const section = await readRagDocumentSection()
    expect(section).toEqual({ ragList: [] })
  })
})
