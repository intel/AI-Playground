import { pickBestDeviceId } from './hardwareDiscovery.ts'
import { bestNameMatch } from './deviceArch.ts'
import { appLoggerInstance as appLogger } from '../logging/logger.ts'
import type { PreferredDevice } from '../main.ts'

// Bridges backend services (which mutate the shared LocalSettings object while
// auto-selecting a default device) to main.ts's disk-persistence routine,
// without threading a callback through every service constructor.
let persistFn: (() => void) | null = null

export function registerSettingsPersist(fn: () => void): void {
  persistFn = fn
}

/** Persist the current in-memory local settings to disk, if a writer is registered. */
export function persistSettings(): void {
  persistFn?.()
}

/** A backend-detected device, optionally carrying stable identifiers. */
export type DetectedDevice = {
  id: string
  name: string
  /** Stable vendor UUID (NVIDIA/Intel where available). */
  uuid?: string | null
  /** PCI model id (e.g. Intel `0x56A0`) — disambiguates model, not identical twins. */
  pciId?: string | null
}

/**
 * Resolve the device a backend should default to. Precedence:
 *   1. an existing persisted per-backend choice for `key`. When a UUID was also
 *      persisted (`uuidMap`) and still matches a detected device, that device's
 *      current id is returned — so a driver/enumeration change that shifts the
 *      backend-local id doesn't strand the selection on the wrong device.
 *   2. the user's wizard-chosen `preferred` GPU, matched to this backend's own
 *      detected list: UUID → PCI id → name (edit distance).
 *   3. the automatic ranking (dedicated GPU > integrated GPU > NPU > CPU).
 * The resolved id (and its UUID, when known) is written back and persisted, so
 * the choice survives restarts and later detection changes.
 */
export async function resolveDefaultDevice(
  devices: DetectedDevice[],
  settingsMap: Record<string, string>,
  key: string,
  preferred: PreferredDevice | null | undefined,
  uuidMap?: Record<string, string>,
): Promise<string | undefined> {
  const persistedId = settingsMap[key]
  if (persistedId !== undefined) {
    const persistedUuid = uuidMap?.[key]
    if (persistedUuid) {
      const byUuid = devices.find((d) => d.uuid != null && d.uuid === persistedUuid)
      if (byUuid) return byUuid.id
    }
    return persistedId
  }
  if (devices.length === 0) return undefined

  let chosenId: string | undefined
  let source = 'auto-ranked'

  if (preferred) {
    // UUID is deterministic; PCI id disambiguates the model; name is the
    // last-resort fuzzy match (the previous behavior).
    if (preferred.uuid) {
      chosenId = devices.find((d) => d.uuid != null && d.uuid === preferred.uuid)?.id
      if (chosenId !== undefined) source = 'wizard preference (uuid)'
    }
    if (chosenId === undefined && preferred.gpuDeviceId) {
      chosenId = devices.find((d) => d.pciId != null && d.pciId === preferred.gpuDeviceId)?.id
      if (chosenId !== undefined) source = 'wizard preference (pci)'
    }
    if (chosenId === undefined) {
      chosenId = bestNameMatch(preferred.name, devices)?.id
      if (chosenId !== undefined) source = 'wizard preference (name)'
    }
  }

  if (chosenId === undefined) {
    chosenId = await pickBestDeviceId(devices)
  }

  if (chosenId !== undefined) {
    settingsMap[key] = chosenId
    const chosenUuid = devices.find((d) => d.id === chosenId)?.uuid
    if (uuidMap) {
      if (chosenUuid) uuidMap[key] = chosenUuid
      else delete uuidMap[key]
    }
    persistSettings()
    appLogger.info(
      `Selected default device '${chosenId}' for '${key}' (${source}, no prior selection)`,
      'electron-backend',
    )
  }
  return chosenId
}
