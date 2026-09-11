import type { PiniaPluginContext, Store } from 'pinia'

type PlainRecord = Record<string, unknown>

/** Pinia's per-store HMR hook. Internal in its public types, present in dev builds. */
type HotUpdate = (newStore: Store) => void

/**
 * Pinia drops every entry of plain-object state when a store module is hot
 * swapped: its merge walks the old entries but skips any key the freshly
 * created store does not already have, and a `ref<Record<…>>` starts out
 * empty. Scalars and arrays are transferred wholesale, so the loss goes
 * unnoticed until the persistence plugin — which saves the store right after a
 * hot update — commits the emptied map to storage. Editing `agentMode.ts` with
 * the dev server running deleted the agent session list that way; the same
 * hazard covers chat conversations and the per-preset settings maps.
 *
 * This restores the old entries while the update is still running, so what gets
 * persisted afterwards is the merge Pinia intended: old values win, keys the
 * edited module adds survive.
 */
export function preserveStateAcrossHmr({ store }: PiniaPluginContext): void {
  const internals = store as Store & { _hotUpdate?: HotUpdate }
  const hotUpdate = internals._hotUpdate
  // Production builds have no hot update hook, making this plugin a no-op.
  if (!hotUpdate) return
  internals._hotUpdate = (newStore) => {
    const previous = { ...(store.$state as PlainRecord) }
    hotUpdate(newStore)
    store.$patch((state) => {
      const next = state as PlainRecord
      // State the edited module no longer declares stays gone.
      const kept = Object.entries(previous).filter(([key]) => key in next)
      overlay(next, Object.fromEntries(kept))
    })
  }
}

function overlay(next: PlainRecord, previous: PlainRecord): void {
  for (const [key, value] of Object.entries(previous)) {
    const target = next[key]
    if (isPlainRecord(target) && isPlainRecord(value)) overlay(target, value)
    else next[key] = value
  }
}

function isPlainRecord(value: unknown): value is PlainRecord {
  return Object.prototype.toString.call(value) === '[object Object]'
}
