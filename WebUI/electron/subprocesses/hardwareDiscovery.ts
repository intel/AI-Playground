import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { spawnProcessAsync } from './osProcessHelper'
import { appLoggerInstance as appLogger } from '../logging/logger.ts'
import { buildResources } from './uvBasedBackends/uv.ts'

export type GpuHardwareDevice = {
  device: string
  name: string
  gpuDeviceId: string | null
}

const XpuSmiDiscoverySchema = z.object({
  device_list: z.array(
    z.object({
      device_id: z.number(),
      device_name: z.string(),
      device_type: z.string().optional(),
      pci_device_id: z.string().optional(),
      uuid: z.string().optional(),
      vendor_name: z.string().optional(),
    }),
  ),
})

const NvidiaSmiLineSchema = z.object({
  index: z.number(),
  name: z.string(),
  uuid: z.string().optional(),
})

function getXpuSmiExePath(): string | null {
  const exePath = path.join(buildResources, 'xpu-smi.exe')
  appLogger.info('Checking for xpu-smi.exe at path: ' + exePath, 'electron-backend')
  if (fs.existsSync(exePath)) return exePath
  return null
}

export async function detectIntelGpusViaXpuSmi(): Promise<GpuHardwareDevice[]> {
  if (process.platform !== 'win32') return []
  const exePath = getXpuSmiExePath()
  if (!exePath) return []

  try {
    appLogger.info(`spawning xpu-smi for discovery at path: ${exePath}`, 'electron-backend')
    const out = await spawnProcessAsync(
      exePath,
      ['discovery', '-j'],
      () => {},
      { ONEAPI_DEVICE_SELECTOR: '*' },
      path.dirname(exePath),
    )
    appLogger.info(`xpu-smi discovery output: ${out}`, 'electron-backend')
    const parsed = XpuSmiDiscoverySchema.parse(JSON.parse(out))
    return parsed.device_list.map((d) => ({
      device: `INTEL_GPU:${d.device_id}`,
      name: d.device_name,
      gpuDeviceId: d.pci_device_id ?? null,
    }))
  } catch (e) {
    appLogger.warn(
      `Failed to detect Intel GPUs via xpu-smi ${JSON.stringify(e)}`,
      'electron-backend',
    )
    return []
  }
}

const PowerShellGpuSchema = z.array(
  z.object({
    Name: z.string(),
    PNPDeviceID: z.string().nullable().optional(),
  }),
)

export function parsePowerShellGpuOutput(output: string): GpuHardwareDevice[] {
  const raw = JSON.parse(output)
  const entries = PowerShellGpuSchema.parse(Array.isArray(raw) ? raw : [raw])

  const devices: GpuHardwareDevice[] = []
  for (const entry of entries) {
    const pnp = entry.PNPDeviceID ?? ''
    const m = pnp.match(/VEN_8086&DEV_([0-9A-Fa-f]{4})/)
    if (!m) continue
    const devId = `0x${m[1].toUpperCase()}`
    devices.push({
      device: `INTEL_GPU_PNP`,
      name: entry.Name,
      gpuDeviceId: devId,
    })
  }
  return devices
}

export async function detectIntelGpusViaPowerShell(): Promise<GpuHardwareDevice[]> {
  if (process.platform !== 'win32') return []

  try {
    appLogger.info('Falling back to PowerShell for Intel GPU detection', 'electron-backend')
    const out = await spawnProcessAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object Name, PNPDeviceID | ConvertTo-Json',
      ],
      () => {},
      undefined,
      undefined,
      5000,
    )
    appLogger.info(`PowerShell GPU detection output: ${out}`, 'electron-backend')
    return parsePowerShellGpuOutput(out)
  } catch (e) {
    appLogger.warn(
      `Failed to detect Intel GPUs via PowerShell: ${JSON.stringify(e)}`,
      'electron-backend',
    )
    return []
  }
}

function parseNvidiaSmiListOutput(output: string): Array<z.infer<typeof NvidiaSmiLineSchema>> {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const out: Array<z.infer<typeof NvidiaSmiLineSchema>> = []
  for (const line of lines) {
    const m = line.match(/^GPU\s+(\d+):\s+(.+?)(?:\s+\(UUID:\s*([^)]+)\))?$/i)
    if (!m) continue
    const index = Number.parseInt(m[1] ?? '', 10)
    if (!Number.isFinite(index)) continue
    const name = (m[2] ?? '').trim()
    const uuid = (m[3] ?? '').trim() || undefined
    out.push(NvidiaSmiLineSchema.parse({ index, name, uuid }))
  }
  return out
}

export async function detectNvidiaGpusViaSmi(): Promise<GpuHardwareDevice[]> {
  const exe = process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi'
  try {
    const out = await spawnProcessAsync(exe, ['-L'], () => {}, undefined, undefined, 2000)
    const gpus = parseNvidiaSmiListOutput(out)
    return gpus.map((g) => ({
      device: `NVIDIA_GPU:${g.index}`,
      name: g.name,
      gpuDeviceId: g.uuid ?? null,
    }))
  } catch (e) {
    appLogger.warn(
      `Failed to detect NVIDIA GPUs via nvidia-smi ${JSON.stringify(e)}`,
      'electron-backend',
    )
    return []
  }
}

export async function detectGpuHardwareDevices(): Promise<{
  detected: GpuHardwareDevice[]
  hasNvidia: boolean
}> {
  const [intel, nvidia] = await Promise.all([detectIntelGpusViaXpuSmi(), detectNvidiaGpusViaSmi()])

  const needsFallback = intel.length === 0 || intel.every((d) => d.gpuDeviceId === null)

  let finalIntel = intel
  if (needsFallback) {
    const psDevices = await detectIntelGpusViaPowerShell()
    if (intel.length === 0) {
      finalIntel = psDevices
    } else {
      finalIntel = enrichWithPowerShellIds(intel, psDevices)
    }
  }

  const detected = [...nvidia, ...finalIntel]
  return { detected, hasNvidia: nvidia.length > 0 }
}

function enrichWithPowerShellIds(
  xpuSmiDevices: GpuHardwareDevice[],
  psDevices: GpuHardwareDevice[],
): GpuHardwareDevice[] {
  return xpuSmiDevices.map((d) => {
    if (d.gpuDeviceId !== null) return d
    const match = psDevices.find((ps) => ps.name.toLowerCase() === d.name.toLowerCase())
    if (match) return { ...d, gpuDeviceId: match.gpuDeviceId }
    return d
  })
}
