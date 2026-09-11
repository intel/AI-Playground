// ── Which built-in tools a preset may use ────────────────────────────────────
//
// Chat and Agent Mode read the same live `textInference` refs, so this map has to
// belong to the active preset: as one global it made trimming the Assistant's
// media tools silently disarm Game Agent, and vice versa.
//
// It shipped as a global once, at the root of the persisted store, so an existing
// install's choice is copied into every preset's settings on hydration. No store
// imports, so this stays testable.

export type ToolEnablement = Record<string, boolean>

/** Key of the per-preset settings entry, and of the legacy global it replaced. */
export const TOOL_ENABLEMENT_KEY = 'builtinToolEnablement'

/** Tools that stay off until asked for; every other built-in tool defaults on. */
const OPT_IN_TOOLS = new Set(['captureScreenshot'])

export function isToolEnabled(enablement: ToolEnablement, toolName: string): boolean {
  const override = enablement[toolName]
  if (override !== undefined) return override
  return !OPT_IN_TOOLS.has(toolName)
}

function asToolEnablement(value: unknown): ToolEnablement | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value).filter(([, enabled]) => typeof enabled === 'boolean')
  return Object.fromEntries(entries) as ToolEnablement
}

/**
 * The map to make live for a preset: its own if it has one, else the legacy
 * global while that is still around (a preset whose settings were never saved
 * has no entry to seed), else the defaults.
 */
export function toolEnablementForPreset(
  saved: unknown,
  legacyGlobal: ToolEnablement | null,
): ToolEnablement {
  return asToolEnablement(saved) ?? (legacyGlobal ? { ...legacyGlobal } : {})
}

/**
 * Copy a pre-per-preset global map into every stored preset's settings, leaving
 * a preset that already carries its own choice alone. Idempotent.
 */
export function seedToolEnablementPerPreset(
  settingsPerPreset: Record<string, Record<string, unknown>>,
  legacyGlobal: ToolEnablement,
): Record<string, Record<string, unknown>> {
  const seeded: Record<string, Record<string, unknown>> = {}
  let changed = false
  for (const [presetKey, settings] of Object.entries(settingsPerPreset)) {
    if (asToolEnablement(settings[TOOL_ENABLEMENT_KEY])) {
      seeded[presetKey] = settings
      continue
    }
    changed = true
    seeded[presetKey] = { ...settings, [TOOL_ENABLEMENT_KEY]: { ...legacyGlobal } }
  }
  return changed ? seeded : settingsPerPreset
}

/**
 * The global map an older build persisted at the root of the store. It is read
 * out of storage rather than kept in the store's `pick` list, because a picked
 * root key is re-persisted from whichever preset is active — which is the
 * cross-talk this replaces. Returns null when there is nothing to migrate.
 */
export function readLegacyToolEnablement(rawPersistedState: string | null): ToolEnablement | null {
  if (!rawPersistedState) return null
  try {
    const parsed = JSON.parse(rawPersistedState) as Record<string, unknown>
    const legacy = asToolEnablement(parsed?.[TOOL_ENABLEMENT_KEY])
    return legacy && Object.keys(legacy).length > 0 ? legacy : null
  } catch {
    return null
  }
}
