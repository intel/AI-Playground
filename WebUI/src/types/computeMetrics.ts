/** One GPU as of a sample. Missing fields are unavailable from that probe. */
export type GpuVendor = 'intel' | 'nvidia' | 'unknown'

export type GpuSample = {
  id: string
  name: string
  vendor: GpuVendor
  utilPct?: number
  memUsedMiB?: number
  memTotalMiB?: number
  /** VidMm dedicated (DXGI capacity + PDH usage). Discrete cards use this as vRAM. */
  dedicatedUsedMiB?: number
  dedicatedTotalMiB?: number
  /** VidMm shared / system-stolen. Dominant on Intel iGPU. */
  sharedUsedMiB?: number
  sharedTotalMiB?: number
  freqMHz?: number
  powerW?: number
}

export type ComputeSnapshot = {
  ts: number
  /** How the GPU rows were filled. Host RAM is always present. */
  source: 'nvidia-smi' | 'xpu-smi' | 'wddm' | 'host' | 'mixed'
  host: { memUsedMiB: number; memTotalMiB: number }
  gpus: GpuSample[]
}

/** Which command shape a given `xpu-smi` build speaks. See docs/compute-resource-metrics.md. */
export type XpuDialect = 'query-gpu' | 'dump'

/** What each probe last did, so a missing GPU row can be explained rather than guessed at. */
export type ProbeReport = {
  platform: string
  intel: {
    bin: string | null
    dialect?: XpuDialect
    /** The sampling command that last worked, once one has. */
    command?: string
    devices: string[]
    lastError?: string
    lastOkAt?: number
  }
  nvidia: { bin: string; lastError?: string; lastOkAt?: number }
  wddm?: { adapters: string[]; lastError?: string; lastOkAt?: number }
}

/** Peaks and last values over a time window, for a trace or a chat turn. */
export type ComputeWindowStats = {
  sampleCount: number
  gpuName?: string
  gpuUtilPeakPct?: number
  gpuUtilLastPct?: number
  gpuMemPeakMiB?: number
  gpuMemLastMiB?: number
  gpuMemTotalMiB?: number
  hostMemPeakMiB?: number
  hostMemLastMiB?: number
  hostMemTotalMiB?: number
}
