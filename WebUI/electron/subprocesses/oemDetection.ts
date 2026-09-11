import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { appLoggerInstance } from '../logging/logger.ts'

// ── Which OEM's machine is this? ─────────────────────────────────────────────
//
// Used for co-branding: on an Acer system the Game Agent feature is presented as
// "Acer Game Agent" and gains a link to the generated "My Acer Arcade" page. Nothing
// about the feature itself changes, so a wrong answer here is cosmetic — which is
// why a failed probe simply reports 'unknown' rather than blocking anything.
//
// The manufacturer string comes from the firmware via CIM (the same value
// `Win32_ComputerSystem.Manufacturer` reports in every OEM tool). Some ODM-built
// units report a reseller or a blank string there, so the presence of Acer's own
// registry hive counts as a second, weaker signal.

const execAsync = promisify(exec)
const logger = appLoggerInstance
const LOG_SOURCE = 'oemDetection'

/** Normalized vendor id; 'unknown' when nothing identifiable was found. */
export type OemVendor = 'acer' | 'unknown' | (string & {})

export type OemInfo = {
  vendor: OemVendor
  /** Raw manufacturer string, for logs and the settings UI. */
  manufacturer: string
  /** True when the vendor came from an override rather than the hardware. */
  overridden: boolean
}

const KNOWN_VENDORS = ['acer', 'asus', 'dell', 'hp', 'lenovo', 'msi', 'samsung', 'intel'] as const

const ACER_REGISTRY_KEYS = ['HKLM:\\SOFTWARE\\Acer', 'HKLM:\\SOFTWARE\\Acer Incorporated']

/**
 * Cached for the process lifetime: the machine cannot change vendor while the app
 * is running, and every UI surface that asks would otherwise spawn PowerShell.
 */
let cached: OemInfo | null = null

function vendorFromManufacturer(manufacturer: string): OemVendor {
  const normalized = manufacturer.toLowerCase()
  return KNOWN_VENDORS.find((vendor) => normalized.includes(vendor)) ?? 'unknown'
}

async function readManufacturer(): Promise<string> {
  const { stdout } = await execAsync(
    'powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystem).Manufacturer"',
    { timeout: 20000, windowsHide: true },
  )
  return stdout.trim()
}

async function hasAcerRegistryHive(): Promise<boolean> {
  for (const key of ACER_REGISTRY_KEYS) {
    try {
      await execAsync(`powershell -NoProfile -Command "Test-Path -Path '${key}'"`, {
        timeout: 20000,
        windowsHide: true,
      }).then(({ stdout }) => {
        if (stdout.trim().toLowerCase() !== 'true') throw new Error('absent')
      })
      return true
    } catch {
      // Next key, or no Acer hive at all.
    }
  }
  return false
}

/**
 * The OEM this machine came from. `override` (a settings value) wins, so the Acer
 * experience can be exercised on any dev box.
 */
export async function detectOem(override?: string | null): Promise<OemInfo> {
  if (override) {
    return { vendor: override.toLowerCase(), manufacturer: override, overridden: true }
  }
  if (cached) return cached
  if (process.platform !== 'win32') {
    cached = { vendor: 'unknown', manufacturer: '', overridden: false }
    return cached
  }
  let manufacturer = ''
  try {
    manufacturer = await readManufacturer()
  } catch (error) {
    logger.warn(`could not read the system manufacturer: ${error}`, LOG_SOURCE)
  }
  let vendor = vendorFromManufacturer(manufacturer)
  if (vendor === 'unknown' && (await hasAcerRegistryHive())) vendor = 'acer'
  logger.info(`OEM: ${vendor} (manufacturer: '${manufacturer}')`, LOG_SOURCE)
  cached = { vendor, manufacturer, overridden: false }
  return cached
}
