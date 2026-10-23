import type { GpuSample } from '@/types/computeMetrics'

export function formatMib(mib: number): string {
  if (!Number.isFinite(mib)) return '—'
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GB`
  return `${Math.round(mib)} MB`
}

export type ComputeDetailRow = { label: string; value: string }
export type ComputeDetailSection = { title: string; rows: ComputeDetailRow[] }

/** Adapter names as Windows reports them, without the trademark marks that make them wrap. */
export function displayGpuName(name: string): string {
  return name
    .replace(/\((R|TM|C)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function usage(used: number | undefined, total: number | undefined): string {
  return `${formatMib(used ?? 0)}${total != null ? ` / ${formatMib(total)}` : ''}`
}

/**
 * The compute tooltip, one section per device. WDDM's dedicated / shared split
 * replaces the combined figure, which on a discrete card is just the dedicated one.
 */
export function computeDetailSections(
  gpu: GpuSample | undefined,
  host: { memUsedMiB: number; memTotalMiB: number },
): ComputeDetailSection[] {
  const sections: ComputeDetailSection[] = []
  if (gpu) {
    const rows: ComputeDetailRow[] = []
    const hasDedicated = gpu.dedicatedUsedMiB != null || gpu.dedicatedTotalMiB != null
    const hasShared = gpu.sharedUsedMiB != null || gpu.sharedTotalMiB != null
    if (hasDedicated)
      rows.push({ label: 'Dedicated', value: usage(gpu.dedicatedUsedMiB, gpu.dedicatedTotalMiB) })
    if (hasShared)
      rows.push({ label: 'Shared', value: usage(gpu.sharedUsedMiB, gpu.sharedTotalMiB) })
    if (!hasDedicated && !hasShared && gpu.memUsedMiB != null)
      rows.push({ label: 'Memory', value: usage(gpu.memUsedMiB, gpu.memTotalMiB) })
    if (gpu.utilPct != null) rows.push({ label: 'Load', value: formatPct(gpu.utilPct) })
    if (gpu.freqMHz != null) rows.push({ label: 'Clock', value: `${Math.round(gpu.freqMHz)} MHz` })
    if (gpu.powerW != null) rows.push({ label: 'Power', value: `${gpu.powerW.toFixed(1)} W` })
    if (rows.length > 0) sections.push({ title: displayGpuName(gpu.name) || 'GPU', rows })
  }
  sections.push({
    title: 'System',
    rows: [{ label: 'RAM', value: usage(host.memUsedMiB, host.memTotalMiB) }],
  })
  return sections
}

export function formatPct(pct: number): string {
  if (!Number.isFinite(pct)) return '—'
  return `${Math.round(pct)}%`
}

export function formatEnergyWh(wattHours: number): string {
  if (!Number.isFinite(wattHours)) return '—'
  if (wattHours < 0.01) return `${(wattHours * 1000).toFixed(1)} mWh`
  if (wattHours < 1) return `${wattHours.toFixed(3)} Wh`
  return `${wattHours.toFixed(2)} Wh`
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const digits = value < 0.01 ? 4 : value < 1 ? 3 : 2
  return `$${value.toFixed(digits)}`
}
