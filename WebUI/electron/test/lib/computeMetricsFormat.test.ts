import { describe, expect, it } from 'vitest'
import { computeDetailSections, displayGpuName } from '@/lib/computeMetricsFormat'

const host = { memUsedMiB: 15.2 * 1024, memTotalMiB: 63.3 * 1024 }

describe('computeDetailSections', () => {
  it('shows the dedicated / shared split instead of the combined figure', () => {
    const sections = computeDetailSections(
      {
        id: 'gpu0',
        name: 'Intel(R) Arc(TM) Pro B70 Graphics',
        vendor: 'intel',
        utilPct: 0,
        memUsedMiB: 254,
        memTotalMiB: 31.8 * 1024,
        dedicatedUsedMiB: 254,
        dedicatedTotalMiB: 31.8 * 1024,
        sharedUsedMiB: 80,
        sharedTotalMiB: 47.3 * 1024,
      },
      host,
    )
    expect(sections).toEqual([
      {
        title: 'Intel Arc Pro B70 Graphics',
        rows: [
          { label: 'Dedicated', value: '254 MB / 31.8 GB' },
          { label: 'Shared', value: '80 MB / 47.3 GB' },
          { label: 'Load', value: '0%' },
        ],
      },
      { title: 'System', rows: [{ label: 'RAM', value: '15.2 GB / 63.3 GB' }] },
    ])
  })

  it('falls back to the combined memory figure without a WDDM split', () => {
    const [gpu] = computeDetailSections(
      { id: 'gpu0', name: 'NVIDIA RTX', vendor: 'nvidia', memUsedMiB: 2048, memTotalMiB: 8192 },
      host,
    )
    expect(gpu.rows).toEqual([{ label: 'Memory', value: '2.0 GB / 8.0 GB' }])
  })

  it('lists only the system when no GPU was sampled', () => {
    expect(computeDetailSections(undefined, host).map((s) => s.title)).toEqual(['System'])
  })
})

describe('displayGpuName', () => {
  it('drops trademark marks', () => {
    expect(displayGpuName('Intel(R) Core(TM) Ultra 7 (r) Graphics')).toBe(
      'Intel Core Ultra 7 Graphics',
    )
  })
})
