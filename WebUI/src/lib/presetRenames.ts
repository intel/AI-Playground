// ── Presets that changed name after shipping ─────────────────────────────────
//
// A preset's name IS its identity: it keys the active/last-used selection, the
// per-preset chat settings, a chat thread's stamped preset and an agent session's
// preset. Renaming one in `modes/base/presets/` therefore orphans everything an
// existing install has stored under the old name — the session panel would list
// nothing, resuming a session would fail to switch preset, and the settings the
// user tuned would silently revert to defaults.
//
// Every store that persists a preset name runs its state through here on
// hydration. Types only, no store imports, so it stays testable.

/**
 * Old preset name → the name it ships under now. Lookup is single-hop, so a
 * preset renamed twice lists every one of its old names against the current one.
 */
export const RENAMED_PRESETS: Record<string, string> = {
  'Game Maker': 'Game Agent',
  'Game Maker Quick': 'Quick Coder',
  'Game Agent Quick': 'Quick Coder',
}

/** The current name for a stored one, unchanged when it was never renamed. */
export function currentPresetName(name: string): string {
  return RENAMED_PRESETS[name] ?? name
}

/**
 * Re-key a map whose keys are preset names (or `<preset>:<variant>`, which the
 * per-preset settings use). An entry already stored under the new name wins, so
 * running this twice is a no-op and a rename never overwrites current state.
 */
export function renamePresetKeys<T>(entries: Record<string, T>): Record<string, T> {
  let changed = false
  const next: Record<string, T> = {}
  for (const [key, value] of Object.entries(entries)) {
    const [name, ...rest] = key.split(':')
    const renamed = RENAMED_PRESETS[name]
    if (!renamed) {
      next[key] = value
      continue
    }
    changed = true
    const nextKey = [renamed, ...rest].join(':')
    if (!(nextKey in entries)) next[nextKey] = value
  }
  return changed ? next : entries
}
