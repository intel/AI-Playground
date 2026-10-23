import { ref, watch, type Ref } from 'vue'
import { demoAwareStorage } from '../assets/js/demoAwareStorage'
import { useErrors } from '@/assets/js/store/errors'
import { cloneForIpc } from '@/lib/cloneForIpc'

/**
 * The renderer half of the kernel-owned preferences file
 * (architecture-target §6.1, step 8): a store hands over the refs it used
 * to pinia-persist and gets back hydration + write-through against its
 * section of `AI-Playground/preferences.json`.
 *
 * `init()` (once, pre-mount): read the file, hydrate the section, and when
 * the section is absent upload the legacy Pinia payload once — then drop the
 * legacy key so it can never dual-write again (kept when the upload fails, so
 * the next boot retries). Write-through is a debounced deep watch over the
 * refs — the faithful port of the persist plugin's per-mutation
 * subscription — diffed against a JSON snapshot so unchanged state never
 * hits the file, a rejected write retries on the next flush, and the
 * flush fires immediately on `beforeunload` so a quit does not drop the
 * debounce window. Nothing writes before hydration; on a failed read the
 * defaults boot and the first user change writes them through, which is the
 * recovery path for a store that did not answer. A later slice that adds a
 * ref to a section the file already holds fills leftover-only keys (present
 * keys stay the file's) and write-throughs the merge — migrate is
 * section-absent only and would skip them.
 */

export type FileBackedPreferenceRefs = Record<string, Ref>

export type FileBackedPreference = {
  init: () => Promise<void>
  hydrated: Ref<boolean>
  dispose: () => void
  /** Leftover Pinia payload captured at construction, before persist can rewrite it. */
  legacyRaw: string | null
}

/** The IPC seam the helper talks through. Defaults to the preferences file
 * channels; a store whose section lives in another file (e.g. settings.json)
 * injects an adapter over its own channels with the same shape. */
export type FileBackedPreferencesApi = {
  read(): Promise<
    { success: true; sections: Record<string, unknown> } | { success: false; error: string }
  >
  migrate(
    section: string,
    payload: unknown,
  ): Promise<{ success: true } | { success: false; error: string }>
  write(
    section: string,
    value: unknown,
  ): Promise<{ success: true } | { success: false; error: string }>
}

const FLUSH_DEBOUNCE_MS = 300

export function makeFileBackedPreference(options: {
  section: string
  refs: FileBackedPreferenceRefs
  /** The pre-step-8 Pinia key; its own keys are slimmed out after the one-shot
   * upload succeeds (or dropped entirely when `legacySlim` is not set). */
  legacyKey?: string
  /** The Pinia key is shared with another section's migrator or still persists
   * other fields: remove only this section's keys and drop the key when it
   * runs empty, instead of removing it outright. */
  legacySlim?: boolean
  /** Run the one-shot legacy upload even though the read answered with a
   * section. For a file whose section always exists — settings.json fields
   * are schema-defaulted at boot — absence can never mean "never migrated".
   * Leftover is a merge source, not a hydrate: the file section stays until
   * a successful upload, then a re-read (or a demo-session overlay). */
  alwaysMigrateLegacy?: boolean
  /** Shape the section for the file — e.g. scrub data URIs the way the old
   * pinia serializer did. Applied to the write payload, the migrate payload
   * and the diff base, never to hydration. */
  toFile?: (section: Record<string, unknown>) => Record<string, unknown>
  /** Adapter over the IPC channels that own this section's file. Defaults to
   * the `preferences` channels. */
  api?: FileBackedPreferencesApi
  /** Names the error codes and log messages — 'preferences' by default. */
  errorScope?: string
}): FileBackedPreference {
  const { section, refs, legacyKey, legacySlim, toFile } = options
  const errorScope = options.errorScope ?? 'preferences'
  const resolveApi = (): FileBackedPreferencesApi => options.api ?? window.electronAPI.preferences
  const hydrated = ref(false)
  let initPromise: Promise<void> | null = null
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let flushInFlight = false
  let lastFlushedJson: string | null = null
  let legacyKeyDropped = false
  // Pinia persist of the remaining pick can rewrite this key between store
  // setup (now) and init(); capture the leftover while it is still whole.
  // Store tests may construct without localStorage — no leftover then.
  let legacyRaw: string | null = null
  if (legacyKey) {
    try {
      legacyRaw = demoAwareStorage.getItem(legacyKey)
    } catch {
      legacyRaw = null
    }
  }

  function snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(refs)) out[key] = value.value
    const shaped = toFile ? toFile(out) : out
    return cloneForIpc(shaped)
  }

  function applySection(sectionValue: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(refs)) {
      if (key in sectionValue) value.value = sectionValue[key]
    }
  }

  function legacyPick(raw: unknown): Record<string, unknown> | null {
    if (!raw || typeof raw !== 'object') return null
    const out: Record<string, unknown> = {}
    let any = false
    for (const key of Object.keys(refs)) {
      if (key in raw) {
        out[key] = (raw as Record<string, unknown>)[key]
        any = true
      }
    }
    return any ? out : null
  }

  /** Leftover keys a later slice added to an already-migrated section. */
  function fillLeftoverGaps(fileSection: Record<string, unknown>): boolean {
    if (!legacyRaw) return false
    let leftover: Record<string, unknown> | null = null
    try {
      leftover = legacyPick(JSON.parse(legacyRaw))
    } catch {
      return false
    }
    if (!leftover) return false
    const gap: Record<string, unknown> = {}
    let any = false
    for (const key of Object.keys(refs)) {
      if (!(key in fileSection) && key in leftover) {
        gap[key] = leftover[key]
        any = true
      }
    }
    if (!any) return false
    applySection(gap)
    return true
  }

  function dropLegacyKey(): void {
    if (!legacyKey || legacyKeyDropped) return
    legacyKeyDropped = true
    if (legacySlim) {
      // Remove only this section's keys; the key may hold other consumers'
      // data (another section's migrator, or fields the store still persists).
      const raw = demoAwareStorage.getItem(legacyKey)
      if (!raw) return
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        if (!parsed || typeof parsed !== 'object') return
        let any = false
        for (const key of Object.keys(parsed)) {
          if (key in refs) {
            delete parsed[key]
            any = true
          }
        }
        if (any && Object.keys(parsed).length === 0) {
          demoAwareStorage.removeItem(legacyKey)
        } else if (any) {
          demoAwareStorage.setItem(legacyKey, JSON.stringify(parsed))
        }
      } catch {
        // An unparsable payload is best left alone.
      }
      return
    }
    demoAwareStorage.removeItem(legacyKey)
  }

  function scheduleFlush(): void {
    if (!hydrated.value) return
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, FLUSH_DEBOUNCE_MS)
  }

  async function flush(): Promise<void> {
    if (!hydrated.value) return
    if (flushInFlight) {
      // Re-arm instead of overlapping: this flush must diff against the
      // post-IPC state the in-flight one is about to confirm.
      scheduleFlush()
      return
    }
    const current = snapshot()
    const json = JSON.stringify(current)
    if (json === lastFlushedJson) return
    flushInFlight = true
    const errorsStore = useErrors()
    try {
      const result = await resolveApi().write(section, current)
      if (result.success) {
        lastFlushedJson = json
        // alwaysMigrateLegacy: a write of the file section is not proof leftover
        // was merged — drop only on migrate success.
        if (options.alwaysMigrateLegacy !== true) dropLegacyKey()
      } else {
        errorsStore.report(new Error(result.error), {
          category: 'backend',
          code: `${errorScope}/write-failed`,
          severity: 'warning',
          surface: 'silent',
          technicalMessage: `the ${errorScope} file store rejected the '${section}' write`,
        })
      }
    } catch (error) {
      errorsStore.report(error, {
        category: 'backend',
        code: `${errorScope}/write-failed`,
        severity: 'warning',
        surface: 'silent',
        technicalMessage: `the ${errorScope} file store rejected the '${section}' write`,
      })
    } finally {
      flushInFlight = false
    }
  }

  async function init(): Promise<void> {
    if (initPromise) return initPromise
    initPromise = (async () => {
      const errorsStore = useErrors()
      let sections: Record<string, unknown> | null = null
      let hydratedFileSection: Record<string, unknown> | null = null
      try {
        const read = await resolveApi().read()
        sections = read.success ? read.sections : null
      } catch {
        sections = null
      }
      if (sections === null) {
        // The file store did not answer: defaults boot, and the first user
        // change writes the section through — the recovery path. The legacy
        // key is NOT migrated here: with the file unreadable, nothing proves
        // the legacy payload is newer than what the file may already hold.
        errorsStore.report(new Error('preferences read failed'), {
          category: 'backend',
          code: `${errorScope}/read-failed`,
          severity: 'warning',
          surface: 'silent',
          technicalMessage: `the ${errorScope} file store did not answer; defaults apply this session`,
        })
      } else {
        const fileSection = sections[section]
        const sectionPresent = !!(fileSection && typeof fileSection === 'object')
        if (sectionPresent) {
          hydratedFileSection = fileSection as Record<string, unknown>
          applySection(hydratedFileSection)
        }
        if (legacyKey && (!sectionPresent || options.alwaysMigrateLegacy === true)) {
          // One-shot legacy upload (§6.1: "localStorage migrates once").
          let legacySection: Record<string, unknown> | null = null
          if (legacyRaw) {
            try {
              legacySection = legacyPick(JSON.parse(legacyRaw))
            } catch {
              legacySection = null
            }
          }
          if (legacySection) {
            // Leftover hydrates only when the section is absent. A present
            // section (alwaysMigrateLegacy) is the file's; leftover is a
            // merge source, never an overlay — except a demo session, which
            // overlays in memory after a successful upload and never writes.
            if (!sectionPresent) applySection(legacySection)
            const payload = cloneForIpc(toFile ? toFile(legacySection) : legacySection)
            try {
              const migrated = await resolveApi().migrate(section, payload)
              if (migrated.success) {
                dropLegacyKey()
                if (typeof window !== 'undefined' && window.__AIPG_DEMO_MODE__ === true) {
                  applySection(legacySection)
                } else if (options.alwaysMigrateLegacy === true && sectionPresent) {
                  try {
                    const again = await resolveApi().read()
                    if (again.success) {
                      const next = again.sections[section]
                      if (next && typeof next === 'object') {
                        hydratedFileSection = next as Record<string, unknown>
                        applySection(hydratedFileSection)
                      }
                    }
                  } catch {
                    // First hydrate stands; main already merged.
                  }
                }
              } else {
                // The file store answered but refused: retry next boot.
                errorsStore.report(new Error(migrated.error), {
                  category: 'backend',
                  code: `${errorScope}/migrate-failed`,
                  severity: 'warning',
                  surface: 'silent',
                  technicalMessage: `the '${section}' legacy upload failed; keeping the key to retry`,
                })
              }
            } catch (error) {
              // Read succeeded; a thrown migrate is a different failure and
              // must not stay silent — the leftover key is kept to retry.
              errorsStore.report(error, {
                category: 'backend',
                code: `${errorScope}/migrate-failed`,
                severity: 'warning',
                surface: 'silent',
                technicalMessage: `the '${section}' legacy upload failed; keeping the key to retry`,
              })
            }
          } else {
            // No payload worth keeping: the key is stale, and it can never
            // migrate — drop it so it cannot linger forever.
            dropLegacyKey()
          }
        }
      }
      const preGapJson = JSON.stringify(snapshot())
      const filledGaps = hydratedFileSection !== null && fillLeftoverGaps(hydratedFileSection)
      lastFlushedJson = preGapJson
      hydrated.value = true
      if (filledGaps) scheduleFlush()
    })()
    return initPromise
  }

  const stopWatch = watch(() => Object.values(refs).map((value) => value.value), scheduleFlush, {
    deep: true,
  })

  const flushNow = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    void flush()
  }
  // Store tests instantiate stores in a bare Node env; beforeunload only
  // exists in a real window.
  const hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
  if (hasWindow) {
    window.addEventListener('beforeunload', flushNow)
  }

  return {
    init,
    hydrated,
    legacyRaw,
    dispose: () => {
      stopWatch()
      if (flushTimer) clearTimeout(flushTimer)
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('beforeunload', flushNow)
      }
    },
  }
}
