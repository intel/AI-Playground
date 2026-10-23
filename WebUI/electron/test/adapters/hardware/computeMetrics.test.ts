import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    isPackaged: false,
    getAppPath: () => '/tmp',
  },
}))

import {
  computeAttributes,
  computeMetricsProbeReport,
  computeWindowSince,
  detectXpuDialect,
  latestComputeSnapshot,
  parseNvidiaSmiCsv,
  parseQueryGpuCsv,
  parseOptionalNumber,
  parseXpuSmiDiscoveryCsv,
  parseXpuSmiDiscoveryJson,
  parseXpuSmiDumpCsv,
  parseXpuSmiMemoryTotalMiB,
  pickPrimaryGpu,
  recordComputeSnapshotForTests,
  resetComputeMetricsForTests,
  setComputeMetricsSink,
  startComputeMetricsSampler,
  stopComputeMetricsSampler,
  summarizeWindow,
  XPU_SMI_WINDOWS_DISABLED,
} from '../../../adapters/hardware/computeMetrics.ts'
import type { ComputeSnapshot } from '@/types/computeMetrics.ts'

describe('parseNvidiaSmiCsv', () => {
  it('reads a one-GPU query row', () => {
    const gpus = parseNvidiaSmiCsv(
      '0, NVIDIA GeForce RTX 4090, GPU-abc, 37, 8192, 24576, 120.50, 2100\n',
    )
    expect(gpus).toEqual([
      {
        id: '0',
        name: 'NVIDIA GeForce RTX 4090',
        vendor: 'nvidia',
        utilPct: 37,
        memUsedMiB: 8192,
        memTotalMiB: 24576,
        powerW: 120.5,
        freqMHz: 2100,
      },
    ])
  })

  it('skips N/A fields', () => {
    const [gpu] = parseNvidiaSmiCsv('0, NVIDIA, GPU-x, [N/A], 1024, 8192, N/A, [N/A]')
    expect(gpu?.utilPct).toBeUndefined()
    expect(gpu?.memUsedMiB).toBe(1024)
    expect(gpu?.powerW).toBeUndefined()
  })
})

describe('parseXpuSmiDumpCsv', () => {
  const dump = [
    'Timestamp, DeviceId, GPU Utilization (%), GPU Power (W), GPU Frequency (MHz), GPU Memory Utilization (%), GPU Memory Used (MiB)',
    '15:44:36.481, 0, 88.2, 42.1, 2400, 51.0, 8160.0',
    '15:44:36.481, 1, N/A, 12.0, 400, 2.03, 82.44',
  ].join('\n')

  it('matches columns by header name and keeps the last row per device', () => {
    const catalog = new Map([['0', { name: 'Intel Arc B580', memTotalMiB: 16384 }]])
    const gpus = parseXpuSmiDumpCsv(dump, catalog)
    expect(gpus).toHaveLength(2)
    expect(gpus[0]).toMatchObject({
      id: '0',
      name: 'Intel Arc B580',
      vendor: 'intel',
      utilPct: 88.2,
      memUsedMiB: 8160,
      memTotalMiB: 16384,
      freqMHz: 2400,
      powerW: 42.1,
    })
    expect(gpus[1]?.name).toBe('Intel GPU 1')
    expect(gpus[1]?.utilPct).toBeUndefined()
    expect(gpus[1]?.memTotalMiB).toBeCloseTo((82.44 / 2.03) * 100)
  })
})

describe('parseXpuSmiDiscoveryCsv', () => {
  it('reads quoted names and GiB sizes', () => {
    const csv = [
      'Device ID,Device Name,Memory Physical Size',
      '0,"Intel(R) Arc(TM) B580 Graphics","16 GiB"',
      '1,"Intel(R) Graphics",N/A',
    ].join('\n')
    const catalog = parseXpuSmiDiscoveryCsv(csv)
    expect(catalog.get('0')).toEqual({
      name: 'Intel(R) Arc(TM) B580 Graphics',
      memTotalMiB: 16384,
    })
    expect(catalog.get('1')?.memTotalMiB).toBeUndefined()
  })
})

describe('summarizeWindow', () => {
  const sample = (
    ts: number,
    util: number,
    mem: number,
    host: number,
    name = 'Intel Arc B580',
  ): ComputeSnapshot => ({
    ts,
    source: 'xpu-smi',
    host: { memUsedMiB: host, memTotalMiB: 32000 },
    gpus: [
      {
        id: '0',
        name,
        vendor: 'intel',
        utilPct: util,
        memUsedMiB: mem,
        memTotalMiB: 16384,
      },
    ],
  })

  it('takes peaks and last values for the hinted GPU', () => {
    const stats = summarizeWindow(
      [
        sample(1, 10, 1000, 8000, 'Intel Arc B580'),
        sample(2, 90, 8000, 12000, 'Intel Arc B580'),
        sample(3, 40, 4000, 9000, 'Intel Arc B580'),
      ],
      'B580',
    )
    expect(stats.sampleCount).toBe(3)
    expect(stats.gpuUtilPeakPct).toBe(90)
    expect(stats.gpuUtilLastPct).toBe(40)
    expect(stats.gpuMemPeakMiB).toBe(8000)
    expect(stats.gpuMemLastMiB).toBe(4000)
    expect(stats.hostMemPeakMiB).toBe(12000)
    expect(stats.hostMemLastMiB).toBe(9000)
    expect(stats.gpuName).toBe('Intel Arc B580')
  })
})

describe('pickPrimaryGpu', () => {
  it('prefers a name match over the hungriest card', () => {
    const picked = pickPrimaryGpu(
      [
        { id: '0', name: 'Intel Graphics', vendor: 'intel', memUsedMiB: 100 },
        { id: '1', name: 'Intel Arc B580', vendor: 'intel', memUsedMiB: 10 },
      ],
      'Arc B580',
    )
    expect(picked?.id).toBe('1')
  })
})

describe('computeAttributes', () => {
  it('omits GPU keys for a cloud turn', () => {
    const attrs = computeAttributes(
      {
        sampleCount: 1,
        gpuName: 'Intel Arc B580',
        gpuUtilPeakPct: 80,
        gpuMemPeakMiB: 8000,
        hostMemPeakMiB: 12000,
        hostMemLastMiB: 11000,
        hostMemTotalMiB: 32000,
      },
      false,
    )
    expect(attrs['aipg.gpu.util_peak_pct']).toBeUndefined()
    expect(attrs['aipg.host.mem_peak_mib']).toBe(12000)
  })
})

describe('sampler', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetComputeMetricsForTests()
  })

  it('records host RAM even when GPU probes fail', async () => {
    const snapshots: ComputeSnapshot[] = []
    setComputeMetricsSink((s) => snapshots.push(s))
    startComputeMetricsSampler({
      intervalMs: 60_000,
      runCommand: async () => {
        throw new Error('missing')
      },
      // The WDDM probe does not go through `runCommand` — it is DXGI/PDH in
      // process. Without stubbing it too, this case only held on a box with no
      // adapter; on a real Windows machine the live probe answered and the
      // source came back 'wddm'.
      collectWddm: () => [],
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    stopComputeMetricsSampler()
    expect(snapshots[0]?.source).toBe('host')
    expect(snapshots[0]?.host.memTotalMiB).toBeGreaterThan(0)
    expect(snapshots[0]?.gpus).toEqual([])
  })

  it('uses WDDM dedicated/shared memory when that probe returns a row', async () => {
    const snapshots: ComputeSnapshot[] = []
    setComputeMetricsSink((s) => snapshots.push(s))
    startComputeMetricsSampler({
      intervalMs: 60_000,
      runCommand: async () => {
        throw new Error('no smi')
      },
      collectWddm: () => [
        {
          id: '0',
          name: 'Intel(R) Arc(TM) B390 GPU',
          vendor: 'intel',
          dedicatedUsedMiB: 80,
          dedicatedTotalMiB: 128,
          sharedUsedMiB: 4000,
          sharedTotalMiB: 16384,
          memUsedMiB: 4080,
          memTotalMiB: 16512,
          utilPct: 22,
        },
      ],
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    stopComputeMetricsSampler()
    expect(snapshots[0]?.source).toBe('wddm')
    expect(snapshots[0]?.gpus[0]).toMatchObject({
      name: 'Intel(R) Arc(TM) B390 GPU',
      memUsedMiB: 4080,
      memTotalMiB: 16512,
      dedicatedTotalMiB: 128,
      sharedUsedMiB: 4000,
    })
  })

  it('windows samples from a start timestamp', () => {
    recordComputeSnapshotForTests({
      ts: 1000,
      source: 'host',
      host: { memUsedMiB: 1, memTotalMiB: 10 },
      gpus: [],
    })
    recordComputeSnapshotForTests({
      ts: 2000,
      source: 'host',
      host: { memUsedMiB: 5, memTotalMiB: 10 },
      gpus: [],
    })
    expect(computeWindowSince(1500).hostMemPeakMiB).toBe(5)
    expect(computeWindowSince(1500).sampleCount).toBe(1)
  })
})

// xpu-smi Level Zero queries reset Vulkan llama.cpp on Intel Arc (Windows).
// The Windows sampler is DXGI+PDH only; Linux still uses xpu-smi.
describe('intel probe commands', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetComputeMetricsForTests()
  })

  const DISCOVERY_CSV = [
    'Device ID,Device Name,Memory Physical Size',
    '0,"Intel(R) Arc(TM) B580 Graphics","16 GiB"',
  ].join('\n')
  const DUMP_CSV = [
    'Timestamp, DeviceId, GPU Utilization (%), GPU Power (W), GPU Frequency (MHz), GPU Memory Utilization (%), GPU Memory Used (MiB)',
    '15:44:36.481, 0, 64.0, 40.0, 2400, 50.0, 8192.0',
  ].join('\n')

  /** The CLI Intel documents: a `dump` subcommand, no `--query-gpu`. */
  const DUMP_HELP = [
    'Usage: xpu-smi [Options]',
    'Subcommands:',
    '  discovery                   Discover the GPU devices',
    '  dump                        Dump device statistics data',
  ].join('\n')

  /** xpu-smi v2.0 on Arc B-series: nvidia-smi-style, and its `dump` rejects -m/-n. */
  const QUERY_HELP = [
    'Intel XPU System Management Interface -- v2.0',
    'Options:',
    '  --list-gpus                 Print a list of GPUs and exit',
    '  --query-gpu=<fields>        Single-shot query of per-GPU metrics',
    '  --format=csv[,noheader][,nounits]  Output format for --query-gpu',
    'Subcommands:',
    '  dump                        Dump device statistics data',
  ].join('\n')

  function linuxRunner(calls: string[][], help = DUMP_HELP) {
    return async (command: string, args: string[]) => {
      calls.push([command, ...args])
      if (args[0] === '--help') return help
      if (args[0] === 'discovery') return DISCOVERY_CSV
      if (args[0] === 'dump') {
        if (args.includes('-1')) throw new Error('Error: invalid device id')
        return DUMP_CSV
      }
      throw new Error(`unexpected: ${command} ${args.join(' ')}`)
    }
  }

  it('does not spawn xpu-smi on Windows even when the bundled exe is present', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const calls: string[][] = []
    startComputeMetricsSampler({
      intervalMs: 60_000,
      xpuSmiPath: 'C:\\app\\resources\\device-service\\xpu-smi.exe',
      runCommand: linuxRunner(calls),
      // DXGI/PDH is in-process, not a `runCommand` spawn, so the live probe
      // would answer here and the "xpu-smi contributed nothing" assertion
      // below would read whatever card the test box has.
      collectWddm: () => [],
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    stopComputeMetricsSampler()

    expect(calls.some((c) => c[0].includes('xpu-smi'))).toBe(false)
    expect(computeMetricsProbeReport().intel.bin).toBe(
      'C:\\app\\resources\\device-service\\xpu-smi.exe',
    )
    expect(computeMetricsProbeReport().intel.lastError).toBe(XPU_SMI_WINDOWS_DISABLED)
    expect(latestComputeSnapshot()?.gpus).toEqual([])
  })

  it('has no Intel probe on Windows without the bundled exe, and says so', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const calls: string[][] = []
    startComputeMetricsSampler({
      intervalMs: 60_000,
      xpuSmiPath: null,
      runCommand: linuxRunner(calls),
      collectWddm: () => [],
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    stopComputeMetricsSampler()

    expect(calls.some((c) => c[0].includes('xpu-smi'))).toBe(false)
    expect(computeMetricsProbeReport().intel.bin).toBeNull()
    expect(computeMetricsProbeReport().intel.lastError).toBe(XPU_SMI_WINDOWS_DISABLED)
  })

  it('uses discovery --dump and a per-device dump on Linux', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const calls: string[][] = []
    startComputeMetricsSampler({
      intervalMs: 60_000,
      collectWddm: () => [],
      runCommand: linuxRunner(calls),
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    stopComputeMetricsSampler()

    const xpuCalls = calls.filter((c) => c[0] === 'xpu-smi')
    expect(xpuCalls.some((c) => c[1] === 'discovery' && c.includes('--dump'))).toBe(true)
    const dump = xpuCalls.find((c) => c[1] === 'dump')
    expect(dump?.slice(1)).toEqual(['dump', '-d', '0', '-m', '0,1,2,5,18', '-n', '1'])

    const snapshot = latestComputeSnapshot()
    expect(snapshot?.source).toBe('xpu-smi')
    expect(snapshot?.gpus[0]).toMatchObject({
      name: 'Intel(R) Arc(TM) B580 Graphics',
      memUsedMiB: 8192,
      memTotalMiB: 16384,
      utilPct: 64,
    })
  })

  it('uses --query-gpu on a Linux build that advertises it', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const calls: string[][] = []
    startComputeMetricsSampler({
      intervalMs: 60_000,
      collectWddm: () => [],
      runCommand: async (command, args) => {
        calls.push([command, ...args])
        if (args[0] === '--help') return QUERY_HELP
        if (args[0] === 'discovery') return DISCOVERY_CSV
        if (args[0] === 'dump') {
          throw new Error('[Error] The following arguments were not expected: -m 0,1,2,5,18 -n 1')
        }
        if (args[0]?.startsWith('--query-gpu=')) {
          return '0, Intel(R) Arc(TM) B390 GPU, 71, 9001, 16384, 88.5, 2200'
        }
        throw new Error(`unexpected: ${command} ${args.join(' ')}`)
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    stopComputeMetricsSampler()

    expect(calls.some((c) => c[1] === 'dump')).toBe(false)
    expect(calls.some((c) => c[1]?.startsWith('--query-gpu='))).toBe(true)
    expect(computeMetricsProbeReport().intel.dialect).toBe('query-gpu')
    expect(latestComputeSnapshot()?.gpus[0]).toMatchObject({
      id: '0',
      name: 'Intel(R) Arc(TM) B390 GPU',
      vendor: 'intel',
      utilPct: 71,
      memUsedMiB: 9001,
      memTotalMiB: 16384,
      powerW: 88.5,
      freqMHz: 2200,
    })
  })

  it('falls back to a smaller field set when a field is rejected', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const tried: string[] = []
    startComputeMetricsSampler({
      intervalMs: 60_000,
      collectWddm: () => [],
      runCommand: async (_command, args) => {
        if (args[0] === '--help') return QUERY_HELP
        if (args[0] === 'discovery') return DISCOVERY_CSV
        const query = args[0]?.startsWith('--query-gpu=') ? args[0].slice(12) : null
        if (query === null) throw new Error(`unexpected: ${args.join(' ')}`)
        tried.push(query)
        if (query.includes('clocks') || query.includes('power')) {
          throw new Error('[Error] Unknown field: clocks.current.graphics')
        }
        return '0, Intel(R) Arc(TM) B390 GPU, 71, 9001, 16384'
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    stopComputeMetricsSampler()

    expect(tried[0]).toContain('clocks.current.graphics')
    expect(computeMetricsProbeReport().intel.command).toBe(
      '--query-gpu=index,name,utilization.gpu,memory.used,memory.total',
    )
    expect(latestComputeSnapshot()?.gpus[0]).toMatchObject({ memUsedMiB: 9001, utilPct: 71 })
  })

  it('records why a probe failed', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    startComputeMetricsSampler({
      intervalMs: 60_000,
      collectWddm: () => [],
      runCommand: async () => {
        throw new Error('spawn ENOENT')
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    stopComputeMetricsSampler()
    expect(computeMetricsProbeReport().intel.lastError).toContain('ENOENT')
  })
})

describe('detectXpuDialect', () => {
  it('picks query-gpu when --help advertises it', () => {
    expect(detectXpuDialect('  --query-gpu=<fields>  Single-shot query')).toBe('query-gpu')
  })

  it('defaults to the documented dump subcommand', () => {
    expect(detectXpuDialect('Subcommands:\n  dump  Dump device statistics data')).toBe('dump')
  })
})

describe('parseQueryGpuCsv', () => {
  it('reads columns by the field list that was requested', () => {
    const gpus = parseQueryGpuCsv(
      '0, Intel Arc B390, 71, 9001, 16384',
      ['index', 'name', 'utilization.gpu', 'memory.used', 'memory.total'],
      'intel',
    )
    expect(gpus).toEqual([
      {
        id: '0',
        name: 'Intel Arc B390',
        vendor: 'intel',
        utilPct: 71,
        memUsedMiB: 9001,
        memTotalMiB: 16384,
      },
    ])
  })

  it('numbers rows itself when the query has no index field', () => {
    const gpus = parseQueryGpuCsv('4096\n2048', ['memory.used'], 'intel')
    expect(gpus.map((g) => [g.id, g.memUsedMiB])).toEqual([
      ['0', 4096],
      ['1', 2048],
    ])
  })
})

describe('parseXpuSmiDiscoveryJson', () => {
  it('reads the Windows device list', () => {
    const catalog = parseXpuSmiDiscoveryJson(
      JSON.stringify({ device_list: [{ device_id: 1, device_name: 'Intel Arc A770' }] }),
    )
    expect(catalog.get('1')).toBe('Intel Arc A770')
  })

  it('survives non-JSON output', () => {
    expect(parseXpuSmiDiscoveryJson('not json').size).toBe(0)
  })
})

describe('parseXpuSmiMemoryTotalMiB', () => {
  it('converts a byte-spelled key', () => {
    expect(
      parseXpuSmiMemoryTotalMiB(JSON.stringify({ memory_physical_size_byte: 1073741824 })),
    ).toBe(1024)
  })

  it('takes a MiB-spelled key as-is', () => {
    expect(parseXpuSmiMemoryTotalMiB(JSON.stringify({ memory_physical_size: '14336.00' }))).toBe(
      14336,
    )
  })
})

describe('parseOptionalNumber', () => {
  it('treats blanks and N/A as missing', () => {
    expect(parseOptionalNumber('')).toBeUndefined()
    expect(parseOptionalNumber('N/A')).toBeUndefined()
    expect(parseOptionalNumber(' 12.5 ')).toBe(12.5)
  })
})
