import { describe, expect, it } from 'vitest'
import type { GpuSample } from '@/types/computeMetrics'
import { pickPrimaryGpu } from './computeMetricsWindow.ts'

/** Radeon 780M: 2 GiB dedicated, the rest shared out of host RAM. */
const igpu: GpuSample = {
  id: '0',
  name: 'AMD Radeon 780M Graphics',
  vendor: 'unknown',
  dedicatedTotalMiB: 2048,
  dedicatedUsedMiB: 1122,
  sharedTotalMiB: 16384,
  sharedUsedMiB: 627,
  memUsedMiB: 1749,
  memTotalMiB: 18432,
}

/** RTX 4060 Laptop: 8 GiB dedicated, idle. */
const discrete: GpuSample = {
  id: '1',
  name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
  vendor: 'nvidia',
  dedicatedTotalMiB: 8188,
  dedicatedUsedMiB: 1278,
  sharedTotalMiB: 16384,
  sharedUsedMiB: 220,
  memUsedMiB: 1278,
  memTotalMiB: 8188,
}

describe('pickPrimaryGpu', () => {
  it('takes the discrete card even when the iGPU looks busier', () => {
    expect(pickPrimaryGpu([igpu, discrete])?.name).toBe(discrete.name)
    expect(pickPrimaryGpu([discrete, igpu])?.memTotalMiB).toBe(8188)
  })

  it('honours a name hint over the discrete preference', () => {
    expect(pickPrimaryGpu([igpu, discrete], 'Radeon 780M')?.name).toBe(igpu.name)
  })

  it('takes the largest card when several are discrete', () => {
    const smaller = { ...discrete, id: '2', name: 'NVIDIA RTX A1000', dedicatedTotalMiB: 4096 }
    expect(pickPrimaryGpu([smaller, discrete])?.name).toBe(discrete.name)
  })

  it('falls back to the busiest when nothing is discrete', () => {
    const second = { ...igpu, id: '3', name: 'Intel Arc Graphics', memUsedMiB: 2500 }
    expect(pickPrimaryGpu([igpu, second])?.name).toBe('Intel Arc Graphics')
  })

  it('returns undefined with no GPUs', () => {
    expect(pickPrimaryGpu([])).toBeUndefined()
  })
})
