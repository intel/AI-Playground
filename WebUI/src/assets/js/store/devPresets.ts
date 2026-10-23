/**
 * Renderer-side wiring for the dev-only dummy ComfyUI presets: the debug gate
 * (`debugToolsEnabled` i.e. `npm run dev`, or Settings › Developer) and
 * injection into the preset list. The preset definitions live in
 * `@/lib/devPresetWorkflows` (pure data) so the main-process artifact catalog
 * can inject them under the same gate, and the main-process runner owns the
 * 3D dummy's fixture upload; see the header comment there for what the dummies
 * are for.
 */
import type { Preset } from './presets'
import { useDeveloperSettings } from './developerSettings'
import { debugSettingsVisible } from './debugSettings'
import { devPresets } from '@/lib/devPresetWorkflows'

export { buildDummyGlb, devPresets, DEV_PRESET_NAMES } from '@/lib/devPresetWorkflows'

function devPresetsEnabled(): boolean {
  return window.envVars?.debugToolsEnabled === true || debugSettingsVisible()
}

/** Appends the dev-only dummy presets to a freshly loaded preset list. */
export function withDevPresets(presets: Preset[]): Preset[] {
  if (!devPresetsEnabled()) return presets
  return [...presets, ...devPresets]
}

/**
 * Whether the media tool catalogs should offer nothing but the dummy workflows
 * (Settings › Developer). Picking a workflow is otherwise up to the model, which
 * makes a verification run take minutes as soon as it reaches for a real one.
 */
export function dummyWorkflowsOnly(): boolean {
  return devPresetsEnabled() && useDeveloperSettings().forceDummyMediaWorkflows
}
