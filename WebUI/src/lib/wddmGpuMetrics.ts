import type { GpuSample, GpuVendor } from '@/types/computeMetrics'

/** PDH instance: `luid_0x00000000_0x00017AB2_phys_0` or `…_eng_0_engtype_3D`. */
export type PdhGpuInstance = {
  processId?: number
  high: number
  low: number
  phys: number
  engine?: number
  engineType?: string
}

const INSTANCE_RE =
  /^(?:pid_(\d+)_)?luid_0x([0-9a-f]+)_0x([0-9a-f]+)(?:_phys_(\d+))?(?:_eng_(\d+)_engtype_(.+))?$/i

export function parsePdhGpuInstance(name: string): PdhGpuInstance | undefined {
  const trimmed = name.trim().replace(/^\\+/, '')
  const match = INSTANCE_RE.exec(trimmed)
  if (!match) return undefined
  return {
    processId: match[1] !== undefined ? Number.parseInt(match[1], 10) : undefined,
    high: Number.parseInt(match[2] ?? '0', 16),
    low: Number.parseInt(match[3] ?? '0', 16),
    phys: Number.parseInt(match[4] ?? '0', 10),
    engine: match[5] !== undefined ? Number.parseInt(match[5], 10) : undefined,
    engineType: match[6],
  }
}

export function luidKey(high: number, low: number, phys = 0): string {
  return `${high >>> 0}:${low >>> 0}:${phys}`
}

export function bytesToMiB(bytes: number): number {
  return bytes / (1024 * 1024)
}

export function vendorFromPciId(vendorId: number): GpuVendor {
  if (vendorId === 0x8086) return 'intel'
  if (vendorId === 0x10de) return 'nvidia'
  return 'unknown'
}

/** Dedicated ≥ 3 GiB is a discrete card; below that, Task Manager's "GPU memory" is dedicated+shared. */
export const DISCRETE_DEDICATED_MIB = 3072

export function applyGpuMemoryRollup(gpu: GpuSample): GpuSample {
  const dedicatedTotal = gpu.dedicatedTotalMiB
  const sharedTotal = gpu.sharedTotalMiB
  if (dedicatedTotal == null && sharedTotal == null) return gpu
  const discrete = (dedicatedTotal ?? 0) >= DISCRETE_DEDICATED_MIB
  if (discrete) {
    return {
      ...gpu,
      memUsedMiB: gpu.dedicatedUsedMiB,
      memTotalMiB: dedicatedTotal,
    }
  }
  const usedParts = [gpu.dedicatedUsedMiB, gpu.sharedUsedMiB].filter(
    (n): n is number => n !== undefined,
  )
  const total = (dedicatedTotal ?? 0) + (sharedTotal ?? 0)
  return {
    ...gpu,
    memUsedMiB: usedParts.length > 0 ? usedParts.reduce((a, b) => a + b, 0) : undefined,
    memTotalMiB: total > 0 ? total : undefined,
  }
}

export function namesOverlap(a: string, b: string): boolean {
  const left = a.trim().toLowerCase()
  const right = b.trim().toLowerCase()
  if (!left || !right) return false
  return left.includes(right) || right.includes(left)
}

/** Keep WDDM memory/utilization; take only clocks and power from vendor SMI tools. */
export function overlaySmiOntoWddm(wddm: GpuSample[], smi: GpuSample[]): GpuSample[] {
  if (wddm.length === 0) return smi
  return wddm.map((gpu) => {
    const extra = smi.find((row) => namesOverlap(row.name, gpu.name))
    if (!extra) return gpu
    return {
      ...gpu,
      freqMHz: extra.freqMHz ?? gpu.freqMHz,
      powerW: extra.powerW ?? gpu.powerW,
    }
  })
}

export function omitSmiUtilization(gpus: GpuSample[]): GpuSample[] {
  return gpus.map((gpu) => {
    const { utilPct: _utilPct, ...withoutUtil } = gpu
    return withoutUtil
  })
}

/** Sum process contexts per physical engine, then choose the busiest engine like Task Manager. */
export function aggregatePdhEngineUtil(
  rows: { name: string; value: number }[],
): Map<string, number> {
  const enginesByAdapter = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const parsed = parsePdhGpuInstance(row.name)
    if (!parsed || parsed.engine === undefined || !Number.isFinite(row.value)) continue
    const adapterKey = luidKey(parsed.high, parsed.low, parsed.phys)
    const engines = enginesByAdapter.get(adapterKey) ?? new Map<string, number>()
    const engineKey = `${parsed.engine}:${parsed.engineType ?? ''}`
    engines.set(engineKey, (engines.get(engineKey) ?? 0) + Math.max(0, row.value))
    enginesByAdapter.set(adapterKey, engines)
  }

  const out = new Map<string, number>()
  for (const [adapterKey, engines] of enginesByAdapter) {
    if (engines.size === 0) continue
    out.set(adapterKey, Math.min(100, Math.max(...engines.values())))
  }
  return out
}
