// Capability override merging. Kept separate from the stores so the precedence
// rules are unit-testable without Pinia.
import { CAPABILITY_KEYS, type ModelCapabilityValues } from './types'

/**
 * Drop keys whose value is `undefined` so spreading an override object can only
 * ever *set* fields, never blank one out.
 *
 * This matters because a materialised `Model` carries explicit `undefined` for
 * every capability the catalog didn't specify. Spreading it over a layer that
 * did specify one would silently erase the value.
 */
export function pickDefined<T extends object>(source: T | undefined): Partial<T> {
  if (!source) return {}
  const result: Partial<T> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      result[key as keyof T] = value as T[keyof T]
    }
  }
  return result
}

/**
 * Merge capability layers, lowest precedence first. User overrides are meant to
 * be passed last: they win over `models.json`, which otherwise always did — the
 * reason editing a predefined model's capabilities used to be discarded on the
 * next `refreshModels()`.
 *
 * Only known capability keys are taken, so a layer that happens to be a full
 * `Model` contributes its capabilities without leaking `name`, `downloaded` and
 * friends into the result.
 */
export function mergeCapabilities(
  ...layers: (Partial<ModelCapabilityValues> | undefined)[]
): ModelCapabilityValues {
  const merged: ModelCapabilityValues = {}
  for (const layer of layers) {
    if (!layer) continue
    for (const key of CAPABILITY_KEYS) {
      const value = layer[key]
      if (value !== undefined) {
        // Each key's type is preserved by the CAPABILITY_KEYS mapped access; the
        // assignment needs a cast only because the key is a union here.
        ;(merged as Record<string, unknown>)[key] = value
      }
    }
  }
  return merged
}

/** Whether the user has overridden at least one capability of this model. */
export function hasCapabilityOverrides(
  overrides: Partial<ModelCapabilityValues> | undefined,
): boolean {
  return Object.keys(pickDefined(overrides)).length > 0
}
