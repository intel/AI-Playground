import { z } from 'zod'

/**
 * Wire shapes for the kernel-owned preferences file (architecture-target
 * §6.1, step 8): `AI-Playground/preferences.json` holds the user
 * preferences a person would want in a backup — one section per store
 * (theme, developerSettings, modelPreferences, textToSpeech,
 * qwen3TextToSpeech). Section payloads are store-specific and stay
 * opaque here; each store owns the interpretation of its own section.
 */

export const PREFERENCE_SECTION_PATTERN = /^[\w.-]+$/

export const PreferencesFileSchema = z.object({
  schemaVersion: z.literal(1),
  sections: z.record(z.string(), z.unknown()),
})
export type PreferencesFile = z.infer<typeof PreferencesFileSchema>

/**
 * The backendServices store's slice of the machine-level settings file
 * (step 8, §6.1): launch flags and version pins it hydrates from
 * `settings.json` at boot, plus main's device map (read-only for the
 * renderer — selectDevice persists it main-side).
 */
export const BackendVersionWireSchema = z.object({
  releaseTag: z.string().optional(),
  version: z.string(),
})
export type BackendVersionWire = z.infer<typeof BackendVersionWireSchema>

export type BackendLaunchSettings = {
  versionOverrides: Record<string, BackendVersionWire>
  comfyUiParameters: string | null
  llamaCppParameters: string | null
  llamaCppBuildVariant: 'standard' | 'ssd-offload'
  llamaCppOffloadDrive: string | null
  openvinoKvCacheU4: boolean
  lastSelectedDevicePerBackend: Record<string, string>
}
