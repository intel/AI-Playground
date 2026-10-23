import type { ComputeSnapshot, ComputeWindowStats, GpuSample } from '@/types/computeMetrics'
import { DISCRETE_DEDICATED_MIB } from '@/lib/wddmGpuMetrics'

function isDiscrete(gpu: GpuSample): boolean {
  return (gpu.dedicatedTotalMiB ?? 0) >= DISCRETE_DEDICATED_MIB
}

export function pickPrimaryGpu(gpus: GpuSample[], hint?: string): GpuSample | undefined {
  if (gpus.length === 0) return undefined
  const needle = hint?.trim().toLowerCase()
  if (needle) {
    const named = gpus.find(
      (gpu) => gpu.name.toLowerCase().includes(needle) || needle.includes(gpu.name.toLowerCase()),
    )
    if (named) return named
  }
  // A discrete card is the one we run on, however idle it looks. Busy-ness can't
  // rank it against an iGPU, whose usage counts shared system RAM and the iGPU's
  // total would then show host RAM as vRAM.
  const discrete = gpus.filter(isDiscrete)
  if (discrete.length > 0) {
    return [...discrete].sort((a, b) => (b.dedicatedTotalMiB ?? 0) - (a.dedicatedTotalMiB ?? 0))[0]
  }
  return [...gpus].sort((a, b) => (b.memUsedMiB ?? 0) - (a.memUsedMiB ?? 0))[0]
}

export function summarizeWindow(window: ComputeSnapshot[], hint?: string): ComputeWindowStats {
  if (window.length === 0) return { sampleCount: 0 }
  let gpuUtilPeakPct: number | undefined
  let gpuMemPeakMiB: number | undefined
  let hostMemPeakMiB: number | undefined
  let lastGpu: GpuSample | undefined
  let lastHost = window[window.length - 1]?.host
  for (const sample of window) {
    const gpu = pickPrimaryGpu(sample.gpus, hint)
    lastGpu = gpu ?? lastGpu
    if (gpu?.utilPct !== undefined) {
      gpuUtilPeakPct = Math.max(gpuUtilPeakPct ?? gpu.utilPct, gpu.utilPct)
    }
    if (gpu?.memUsedMiB !== undefined) {
      gpuMemPeakMiB = Math.max(gpuMemPeakMiB ?? gpu.memUsedMiB, gpu.memUsedMiB)
    }
    hostMemPeakMiB = Math.max(hostMemPeakMiB ?? sample.host.memUsedMiB, sample.host.memUsedMiB)
    lastHost = sample.host
  }
  return {
    sampleCount: window.length,
    gpuName: lastGpu?.name,
    gpuUtilPeakPct,
    gpuUtilLastPct: lastGpu?.utilPct,
    gpuMemPeakMiB,
    gpuMemLastMiB: lastGpu?.memUsedMiB,
    gpuMemTotalMiB: lastGpu?.memTotalMiB,
    hostMemPeakMiB,
    hostMemLastMiB: lastHost?.memUsedMiB,
    hostMemTotalMiB: lastHost?.memTotalMiB,
  }
}
