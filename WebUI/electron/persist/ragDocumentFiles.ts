import fs from 'node:fs/promises'
import { appLoggerInstance } from '../observability/logger'
import { getRagDocumentsDemoFile, getRagDocumentsFile } from './userDataPaths.ts'
import { RagDocumentsFileSchema, RagDocumentSectionSchema } from '@/types/ragDocumentIpc'
import { atomicWriteJson, makeWriteChains, readJson } from './fsJsonStore'

/**
 * The kernel's one-writer RAG document store (architecture-target §6.1,
 * step 8): `AI-Playground/rag/documents.json` — the indexed document set the
 * textInference store projects, full split text included. The same
 * correctness contract as the other user-data stores (atomic tmp+rename
 * writes, schema validation on read, every mutation serialized on one chain
 * — the file is the unit). Items are opaque here; `IndexedDocument` in
 * `src/types/rag.ts` is the domain shape.
 *
 * A missing file is the never-migrated state (section null). A corrupt or
 * schema-invalid file is a failed read — leftover must not replace it.
 * Write is the recovery path and replaces either.
 */

const appLogger = appLoggerInstance

const LOG_SCOPE = 'rag-documents'

export type RagDocumentFilesDeps = {
  isDemoMode: () => boolean
}

let ragDocumentFilesDeps: RagDocumentFilesDeps | null = null

export function setRagDocumentFilesDeps(deps: RagDocumentFilesDeps): void {
  ragDocumentFilesDeps = deps
}

const { serialize, clear: clearChains } = makeWriteChains()

const FILE_CHAIN = 'file'

function ragFile(): string {
  return ragDocumentFilesDeps?.isDemoMode() ? getRagDocumentsDemoFile() : getRagDocumentsFile()
}

function emptyDoc() {
  return { schemaVersion: 1 as const, documents: [] as unknown[] }
}

type InspectedDoc =
  | { status: 'missing' }
  | { status: 'ok'; doc: { schemaVersion: 1; documents: unknown[] } }
  | { status: 'unreadable' }

async function inspectDoc(): Promise<InspectedDoc> {
  const read = await readJson(ragFile(), LOG_SCOPE)
  if (read.status === 'missing') return { status: 'missing' }
  if (read.status === 'ok') {
    const parsed = RagDocumentsFileSchema.safeParse(read.value)
    if (parsed.success) return { status: 'ok', doc: parsed.data }
  }
  appLogger.warn('rag documents file unreadable; not treated as absent', LOG_SCOPE)
  return { status: 'unreadable' }
}

function parseSection(payload: unknown): unknown[] {
  const parsed = RagDocumentSectionSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`invalid rag document section: expected { ragList: [...] }`)
  }
  return parsed.data.ragList
}

// ── Public API ────────────────────────────────────────────────────────────────

/** The section-shaped list; null when the file is absent. Throws when unreadable. */
export async function readRagDocumentSection(): Promise<{ ragList: unknown[] } | null> {
  const inspected = await inspectDoc()
  if (inspected.status === 'missing') return null
  if (inspected.status === 'ok') return { ragList: inspected.doc.documents }
  throw new Error('rag documents file unreadable')
}

export async function writeRagDocumentSection(payload: unknown): Promise<void> {
  const ragList = parseSection(payload)
  return serialize(FILE_CHAIN, async () => {
    const inspected = await inspectDoc()
    const doc = inspected.status === 'ok' ? inspected.doc : emptyDoc()
    doc.documents = ragList
    await atomicWriteJson(ragFile(), doc)
  })
}

/**
 * One-shot legacy upload (§6.1: "localStorage migrates once, do not
 * dual-write"): writes the payload only when the file is absent, so a
 * retried or racing migrate can never overwrite what the file already owns.
 * An unreadable file is owned, not absent — leftover must not replace it.
 */
export async function migrateRagDocumentSection(payload: unknown): Promise<boolean> {
  const ragList = parseSection(payload)
  return serialize(FILE_CHAIN, async () => {
    const inspected = await inspectDoc()
    if (inspected.status === 'ok') return false
    if (inspected.status === 'unreadable') {
      throw new Error('rag documents file unreadable')
    }
    await atomicWriteJson(ragFile(), { schemaVersion: 1, documents: ragList })
    return true
  })
}

/** §6.1: demo RAG documents are session-scoped; wipe on exit (and boot, for a crash tail). */
export async function wipeDemoRagDocuments(): Promise<void> {
  try {
    await fs.rm(getRagDocumentsDemoFile(), { force: true })
  } catch (error) {
    appLogger.warn(`demo rag documents wipe failed: ${String(error)}`, LOG_SCOPE)
  }
}

export function resetRagDocumentFilesForTest(): void {
  ragDocumentFilesDeps = null
  clearChains()
}
