import z from 'zod'

// Machine-level settings (`ai-playground-local-settings.json` / `settings.json`).
// They live here rather than in `main.ts` so a backend adapter can type its
// configuration without importing the composition root.

const ProductModeSchema = z.enum(['studio', 'essentials', 'nvidia'])

// User's preferred GPU, captured in the setup wizard. Identified by name
// (+ PCI id when known) so it can be matched to each backend's own device
// enumeration.
const PreferredDeviceSchema = z.object({
  name: z.string(),
  gpuDeviceId: z.string().nullable(),
  // Stable vendor UUID when the pre-install probe supplied one; preferred over
  // name/PCI when matching this device onto a backend's own detected list.
  uuid: z.string().nullable().optional(),
  // Per-instance probe id (GpuHardwareDevice.device); disambiguates two
  // identically-named GPUs in the wizard when no UUID is available.
  instanceId: z.string().optional(),
})
export type PreferredDevice = z.infer<typeof PreferredDeviceSchema>

export const LocalSettingsSchema = z.object({
  productMode: ProductModeSchema.optional(),
  isDemoModeEnabled: z.boolean().default(false),
  demoModeResetInSeconds: z.number().min(1).nullable().default(null),
  demoModePasscode: z.string().optional(),
  // Gates the experimental "Agent" chat preset. Written by the Settings →
  // Developer checkbox, not a documented hand-edit flag. See docs/agent-preset.md.
  isAgentPresetEnabled: z.boolean().default(false),
  // Shows the machine-level debug controls (OEM override, Phison pretend, remote
  // repository, OpenVINO image-gen devices, verbose agent logging, dummy media
  // workflows, the title-bar wizard shortcut) in Settings → Developer, and
  // unlocks the dev-only test model + dummy workflows in a packaged build.
  showDebugSettingsInUI: z.boolean().default(false),
  // Components the user switched off in the setup wizard. Persisted because the
  // toggle used to live only in the renderer's wizard store: an installed
  // component the user had disabled was auto-started again by the main process on
  // the next launch (holding its port and GPU memory).
  disabledBackends: z.array(z.string()).default([]),
  languageOverride: z.string().nullable().default(null),
  remoteRepository: z.string().default('intel/ai-playground'),
  huggingfaceEndpoint: z.string().default('https://huggingface.co'),
  mcpAutoDetectionDismissed: z.array(z.string()).default([]),
  // Allowed OpenVINO devices for image-gen dropdowns (in-process upscale +
  // OVMS image variants). Case-insensitive prefix match against device IDs.
  // Default excludes NPU because RealESRGAN_x4plus and SDXL exceed current
  // Intel NPU memory budgets on most shipping hardware. Override per-machine
  // by editing settings.json, e.g. ["AUTO", "CPU", "GPU", "NPU"] to re-enable.
  openvinoImageGenDevices: z.array(z.string()).default(['CPU', 'GPU']),
  // Last inference device chosen per backend, keyed by service name
  // (e.g. 'llamacpp-backend') or '<serviceName>:stt' for the OpenVINO STT
  // sub-device. Restored at boot in each service's detectDevices() so the app
  // does not reset to the default GPU (iGPU) on every restart.
  lastSelectedDevicePerBackend: z.record(z.string(), z.string()).default({}),
  // UUID counterpart of lastSelectedDevicePerBackend, same keys. Lets a backend
  // re-find the chosen device (and re-derive its current selector id) after a
  // driver update or enumeration reorder shifts the backend-local id. Empty when
  // the chosen device exposes no UUID (e.g. OpenVINO/llama.cpp devices).
  lastSelectedDeviceUuidPerBackend: z.record(z.string(), z.string()).default({}),
  // Backend launch configuration (step 8, §6.1), formerly renderer-persisted
  // Pinia state. The flags a service is launched with and the version a
  // backend is pinned to — machine-level by nature, edited alongside the
  // device maps. null flags mean "use the backend's default".
  versionOverrides: z
    .record(z.string(), z.object({ releaseTag: z.string().optional(), version: z.string() }))
    .default({}),
  comfyUiParameters: z.string().nullable().default(null),
  llamaCppParameters: z.string().nullable().default(null),
  llamaCppBuildVariant: z.enum(['standard', 'ssd-offload']).default('standard'),
  llamaCppOffloadDrive: z.string().nullable().default(null),
  openvinoKvCacheU4: z.boolean().default(false),
  // Machine-wide preferred inference device, chosen in the setup wizard from the
  // raw pre-install hardware probe. Consulted by each backend's detectDevices()
  // (when it has no per-backend selection yet) to pick a matching device, before
  // falling back to the automatic dGPU > iGPU > NPU > CPU ranking. null = no
  // explicit preference (use the automatic ranking).
  preferredDevice: PreferredDeviceSchema.nullable().default(null),
  /** When true, skip hardware probe and treat Phison SSD as detected (optional overlay in userData settings). */
  PhisonSSDdetected: z.boolean().optional().default(false),
  /**
   * Pretend the machine came from this OEM ('acer', …) instead of probing the
   * firmware, so partner branding can be exercised on any dev box.
   */
  oemVendorOverride: z.string().nullable().optional().default(null),
  // Linux without an OS keyring: the user confirmed the in-app Warning dialog
  // while saving a LAN chat password. Re-applied at startup so decrypt still
  // works; first-time opt-in is the renderer WarningDialog, not a native prompt.
  allowPlaintextSecretStorage: z.boolean().default(false),
})
export type LocalSettings = z.infer<typeof LocalSettingsSchema>
export type ProductMode = z.infer<typeof ProductModeSchema>

export function resolveProductMode(s: LocalSettings): string {
  return s.productMode === 'essentials'
    ? 'essentials'
    : s.productMode === 'nvidia'
      ? 'nvidia'
      : 'studio'
}
