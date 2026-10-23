import fs from 'node:fs/promises'
import { appLoggerInstance } from '../observability/logger'
import { getPreferencesDemoFile, getPreferencesFile } from './userDataPaths.ts'
import { PREFERENCE_SECTION_PATTERN, PreferencesFileSchema } from '@/types/preferencesIpc'
import { atomicWriteJson, makeWriteChains, readJson } from './fsJsonStore'

/**
 * The kernel's one-writer preferences store (architecture-target §6.1,
 * step 8): `AI-Playground/preferences.json` — one small file, one section
 * per renderer store, the same correctness contract as the other
 * user-data stores (atomic tmp+rename writes, schema validation on read,
 * every mutation serialized on one chain — the file is the unit, so one
 * chain is enough). A section payload is opaque here; the store that owns
 * it interprets it.
 *
 * Preferences are best-effort by nature: a corrupt or missing file reads
 * as "no sections" (defaults apply) and is replaced by the next write.
 */

const appLogger = appLoggerInstance

const LOG_SCOPE = 'preferences'

export type PreferencesFileDeps = {
  isDemoMode: () => boolean
}

let preferencesFileDeps: PreferencesFileDeps | null = null

export function setPreferencesFileDeps(deps: PreferencesFileDeps): void {
  preferencesFileDeps = deps
}

const { serialize, clear: clearChains } = makeWriteChains()

const FILE_CHAIN = 'file'

function prefsFile(): string {
  return preferencesFileDeps?.isDemoMode() ? getPreferencesDemoFile() : getPreferencesFile()
}

function emptyDoc() {
  return { schemaVersion: 1 as const, sections: {} as Record<string, unknown> }
}

async function readDoc(): Promise<{ schemaVersion: 1; sections: Record<string, unknown> } | null> {
  const read = await readJson(prefsFile(), LOG_SCOPE)
  if (read.status === 'missing') return null
  if (read.status === 'ok') {
    const parsed = PreferencesFileSchema.safeParse(read.value)
    if (parsed.success) return parsed.data
  }
  appLogger.warn('preferences file failed schema; treated as empty', LOG_SCOPE)
  return null
}

function assertSafeSection(section: string): void {
  if (
    typeof section !== 'string' ||
    section.length > 100 ||
    !PREFERENCE_SECTION_PATTERN.test(section)
  ) {
    throw new Error(`invalid preference section: ${String(section)}`)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** All sections at once; the file is small, so every store can pick its own. */
export async function readAllPreferences(): Promise<Record<string, unknown>> {
  return (await readDoc())?.sections ?? {}
}

/** Main-side consumer read (e.g. the DevTools-on-startup check). */
export async function readPreferenceSection(section: string): Promise<unknown> {
  assertSafeSection(section)
  return ((await readDoc())?.sections ?? {})[section]
}

export async function writePreferenceSection(section: string, value: unknown): Promise<void> {
  assertSafeSection(section)
  return serialize(FILE_CHAIN, async () => {
    const doc = (await readDoc()) ?? emptyDoc()
    doc.sections[section] = value
    await atomicWriteJson(prefsFile(), doc)
  })
}

/**
 * One-shot legacy upload (§6.1: "localStorage migrates once, do not
 * dual-write"): writes the payload only when the section is absent, so a
 * retried or racing migrate can never overwrite what the files already own.
 */
export async function migratePreferenceSection(
  section: string,
  payload: unknown,
): Promise<boolean> {
  assertSafeSection(section)
  return serialize(FILE_CHAIN, async () => {
    const doc = (await readDoc()) ?? emptyDoc()
    if (section in doc.sections) return false
    doc.sections[section] = payload
    await atomicWriteJson(prefsFile(), doc)
    return true
  })
}

/** §6.1: demo preferences are session-scoped; wipe on exit (and boot, for a crash tail). */
export async function wipeDemoPreferences(): Promise<void> {
  try {
    await fs.rm(getPreferencesDemoFile(), { force: true })
  } catch (error) {
    appLogger.warn(`demo preferences wipe failed: ${String(error)}`, LOG_SCOPE)
  }
}

export function resetPreferencesFileForTest(): void {
  preferencesFileDeps = null
  clearChains()
}
