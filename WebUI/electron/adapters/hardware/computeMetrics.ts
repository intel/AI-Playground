import os from 'node:os'
import path from 'node:path'
import { spawnProcessAsync, type ProcessResult } from '../install/osProcessHelper.ts'
import { appLoggerInstance } from '../../observability/logger.ts'
import type {
  ComputeSnapshot,
  ComputeWindowStats,
  GpuSample,
  GpuVendor,
  ProbeReport,
  XpuDialect,
} from '@/types/computeMetrics.ts'
import { omitSmiUtilization, overlaySmiOntoWddm } from '@/lib/wddmGpuMetrics.ts'
import { pickPrimaryGpu, summarizeWindow } from '@/lib/computeMetricsWindow.ts'
import { integrateGpuEnergyWh } from '@/lib/chatEnergy.ts'
import { collectWddmGpus, resetWddmMetricsForTests, wddmLastError } from './windowsWddmMetrics.ts'

export type { ComputeSnapshot, ComputeWindowStats, GpuSample, GpuVendor, ProbeReport, XpuDialect }
export { pickPrimaryGpu, summarizeWindow }

const LOG_SOURCE = 'compute-metrics'
const logger = appLoggerInstance

/** Level Zero queries from xpu-smi reset Vulkan llama.cpp on Intel Arc (ErrorDeviceLost). */
export const XPU_SMI_WINDOWS_DISABLED =
  'disabled on Windows: xpu-smi Level Zero queries reset Vulkan llama.cpp (ErrorDeviceLost)'

const MAX_SAMPLES = 120
const DEFAULT_INTERVAL_MS = 2000
const NVIDIA_TIMEOUT_MS = 2500
const XPU_DUMP_TIMEOUT_MS = 8000
const DISCOVERY_TIMEOUT_MS = 5000

export type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
  spawnOptions?: { cwd?: string; env?: Record<string, string> },
) => Promise<string>

export type ComputeMetricsOptions = {
  intervalMs?: number
  runCommand?: CommandRunner
  xpuSmiPath?: string | null
  now?: () => number
  collectWddm?: () => GpuSample[] | Promise<GpuSample[]>
}

const NVIDIA_QUERY =
  'index,name,uuid,utilization.gpu,memory.used,memory.total,power.draw,clocks.current.graphics'

/** GPU util, power, frequency, memory utilization, memory used. */
const XPU_DUMP_METRICS = '0,1,2,5,18'

type IntelCatalogEntry = { name: string; memTotalMiB?: number }

let samples: ComputeSnapshot[] = []
let timer: ReturnType<typeof setInterval> | null = null
let inFlight = false
let sink: ((snapshot: ComputeSnapshot) => void) | null = null
let options: ComputeMetricsOptions = {}
let intelCatalog: Map<string, IntelCatalogEntry> | null = null
let intelCatalogAttempted = false
let xpuDialect: XpuDialect | null = null
let xpuQueryFields: string | null = null

const defaultRunner: CommandRunner = (command, args, timeoutMs, spawnOptions) =>
  spawnProcessAsync(command, args, () => {}, spawnOptions?.env, spawnOptions?.cwd, timeoutMs)

function runner(): CommandRunner {
  return options.runCommand ?? defaultRunner
}

function nowMs(): number {
  return options.now?.() ?? Date.now()
}

export function setComputeMetricsSink(next: ((snapshot: ComputeSnapshot) => void) | null): void {
  sink = next
}

export function latestComputeSnapshot(): ComputeSnapshot | null {
  return samples.at(-1) ?? null
}

export function resetComputeMetricsForTests(): void {
  stopComputeMetricsSampler()
  samples = []
  intelCatalog = null
  intelCatalogAttempted = false
  xpuDialect = null
  xpuQueryFields = null
  sink = null
  options = {}
  report = freshReport()
  loggedFailures.clear()
  resetWddmMetricsForTests()
}

export function recordComputeSnapshotForTests(snapshot: ComputeSnapshot): void {
  pushSample(snapshot)
}

function pushSample(snapshot: ComputeSnapshot): void {
  samples.push(snapshot)
  if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES)
}

export function hostMemorySnapshot(): { memUsedMiB: number; memTotalMiB: number } {
  const memTotalMiB = os.totalmem() / (1024 * 1024)
  const memUsedMiB = (os.totalmem() - os.freemem()) / (1024 * 1024)
  return { memUsedMiB, memTotalMiB }
}

export function parseOptionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || /^n\/a$/i.test(trimmed) || trimmed === '[N/A]') return undefined
  const value = Number.parseFloat(trimmed.replace(/,/g, ''))
  return Number.isFinite(value) ? value : undefined
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur.trim())
  return out
}

/** `--query-gpu` field name → the sample property it fills. Unlisted fields are ignored. */
const QUERY_FIELDS = {
  index: 'id',
  name: 'name',
  'utilization.gpu': 'utilPct',
  'memory.used': 'memUsedMiB',
  'memory.total': 'memTotalMiB',
  'power.draw': 'powerW',
  'clocks.current.graphics': 'freqMHz',
} as const

/**
 * Rows of `--query-gpu=<fields> --format=csv,noheader,nounits`, read by the
 * field list that was asked for rather than by column position — the field list
 * varies (see the dialect ladder below), and nvidia-smi and the nvidia-style
 * xpu-smi builds answer in the same shape.
 */
export function parseQueryGpuCsv(
  output: string,
  fields: string[],
  vendor: GpuVendor,
  fallbackId?: string,
): GpuSample[] {
  const gpus: GpuSample[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const cols = splitCsvLine(trimmed)
    // A header slipped through (or a banner line): no numeric/known columns.
    if (cols.length < fields.length) continue
    const sample: GpuSample = {
      id: fallbackId ?? String(gpus.length),
      name: '',
      vendor,
    }
    let usable = false
    fields.forEach((field, column) => {
      const key = QUERY_FIELDS[field as keyof typeof QUERY_FIELDS]
      if (!key) return
      const raw = cols[column]
      if (key === 'id') {
        if (raw !== undefined && /^\d+$/.test(raw)) sample.id = raw
        return
      }
      if (key === 'name') {
        if (raw) sample.name = raw
        return
      }
      const value = parseOptionalNumber(raw)
      if (value === undefined) return
      ;(sample as Record<string, unknown>)[key] = value
      usable = true
    })
    if (!usable && !sample.name) continue
    if (!sample.name) sample.name = `${vendor === 'nvidia' ? 'NVIDIA' : 'Intel'} GPU ${sample.id}`
    gpus.push(sample)
  }
  return gpus
}

/** nvidia-smi `--format=csv,noheader,nounits` rows. */
export function parseNvidiaSmiCsv(output: string): GpuSample[] {
  return parseQueryGpuCsv(output, NVIDIA_QUERY.split(','), 'nvidia')
}

/**
 * `xpu-smi discovery --dump 1,2,16` — Device ID, Device Name, Memory Physical Size.
 * Memory may be `N/A` on some iGPUs.
 */
export function parseXpuSmiDiscoveryCsv(output: string): Map<string, IntelCatalogEntry> {
  const catalog = new Map<string, IntelCatalogEntry>()
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const start = lines.findIndex((line) => /device\s*id/i.test(line))
  const rows = start >= 0 ? lines.slice(start + 1) : lines
  for (const line of rows) {
    const cols = splitCsvLine(line)
    const id = cols[0]
    if (id === undefined || !/^\d+$/.test(id)) continue
    const sizeRaw = cols[2] ?? ''
    const sizeMatch = sizeRaw.match(/([\d.]+)/)
    const unit = sizeRaw.toLowerCase()
    let memTotalMiB: number | undefined
    if (sizeMatch) {
      const n = Number.parseFloat(sizeMatch[1] ?? '')
      if (Number.isFinite(n)) {
        memTotalMiB = unit.includes('gi') || unit.includes('gb') ? n * 1024 : n
      }
    }
    catalog.set(id, { name: cols[1] || `Intel GPU ${id}`, memTotalMiB })
  }
  return catalog
}

/** `xpu-smi discovery -j` (the Windows CLI's only listing form) → id → name. */
export function parseXpuSmiDiscoveryJson(output: string): Map<string, string> {
  const catalog = new Map<string, string>()
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return catalog
  }
  const list = (parsed as { device_list?: unknown })?.device_list
  if (!Array.isArray(list)) return catalog
  for (const entry of list) {
    const device = entry as { device_id?: unknown; device_name?: unknown }
    if (device.device_id === undefined || device.device_id === null) continue
    const id = String(device.device_id)
    catalog.set(id, typeof device.device_name === 'string' ? device.device_name : `Intel GPU ${id}`)
  }
  return catalog
}

/**
 * Board memory out of `xpu-smi discovery -d <id> -j`. The key has been spelled
 * both in bytes and in MiB across versions, so it is matched rather than named.
 */
export function parseXpuSmiMemoryTotalMiB(output: string): number | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/memory_physical_size/i.test(key)) continue
    const raw = parseOptionalNumber(typeof value === 'number' ? String(value) : String(value ?? ''))
    if (raw === undefined) return undefined
    return /byte/i.test(key) ? raw / (1024 * 1024) : raw
  }
  return undefined
}

/**
 * One or more `xpu-smi dump` CSV rows. Header names vary slightly by version;
 * columns are matched by name, not position, except DeviceId.
 */
export function parseXpuSmiDumpCsv(
  output: string,
  catalog?: Map<string, IntelCatalogEntry>,
): GpuSample[] {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const headerIndex = lines.findIndex((line) => /deviceid/i.test(line.replace(/\s/g, '')))
  if (headerIndex < 0) return []
  const headers = splitCsvLine(lines[headerIndex] ?? '').map((h) => h.toLowerCase())
  const idx = (match: RegExp) => headers.findIndex((h) => match.test(h))
  const deviceIdx = idx(/device\s*id/)
  const utilIdx = idx(/gpu utilization/)
  const powerIdx = idx(/gpu power/)
  const freqIdx = idx(/gpu frequency/)
  const memUtilIdx = idx(/memory utilization/)
  const memUsedIdx = idx(/memory used/)

  const byId = new Map<string, GpuSample>()
  for (const line of lines.slice(headerIndex + 1)) {
    const cols = splitCsvLine(line)
    const id = deviceIdx >= 0 ? cols[deviceIdx] : undefined
    if (id === undefined || !/^\d+$/.test(id)) continue
    const entry = catalog?.get(id)
    const memUsedMiB = memUsedIdx >= 0 ? parseOptionalNumber(cols[memUsedIdx]) : undefined
    const memUtilPct = memUtilIdx >= 0 ? parseOptionalNumber(cols[memUtilIdx]) : undefined
    const memTotalFromUtil =
      memUsedMiB !== undefined && memUtilPct !== undefined && memUtilPct > 0
        ? (memUsedMiB / memUtilPct) * 100
        : undefined
    byId.set(id, {
      id,
      name: entry?.name ?? `Intel GPU ${id}`,
      vendor: 'intel',
      utilPct: utilIdx >= 0 ? parseOptionalNumber(cols[utilIdx]) : undefined,
      memUsedMiB,
      memTotalMiB: entry?.memTotalMiB ?? memTotalFromUtil,
      freqMHz: freqIdx >= 0 ? parseOptionalNumber(cols[freqIdx]) : undefined,
      powerW: powerIdx >= 0 ? parseOptionalNumber(cols[powerIdx]) : undefined,
    })
  }
  return [...byId.values()]
}

export function computeWindowSince(sinceMs: number, hint?: string): ComputeWindowStats {
  return summarizeWindow(
    samples.filter((sample) => sample.ts >= sinceMs),
    hint,
  )
}

/**
 * GPU energy drawn since `sinceMs`, integrated over the sampled power readings.
 * Undefined when no sample in the window carried a power figure — the chat turn
 * then ships no energy metadata rather than a zero that looks measured.
 */
export function computeEnergyWhSince(sinceMs: number, hint?: string): number | undefined {
  return integrateGpuEnergyWh(samples, sinceMs, Date.now(), hint)
}

let report: ProbeReport = freshReport()

function freshReport(): ProbeReport {
  return {
    platform: process.platform,
    intel: { bin: null, devices: [] },
    nvidia: { bin: nvidiaBin() },
    wddm: { adapters: [] },
  }
}

export function computeMetricsProbeReport(): ProbeReport {
  return report
}

/**
 * Failures are expected (no NVIDIA card, no XPU Manager) and are polled every
 * couple of seconds, so the same failure is logged once rather than forever.
 */
const loggedFailures = new Set<string>()

function describeFailure(error: unknown): string {
  const result = (error as { result?: ProcessResult })?.result
  if (!result) return String(error)
  const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(0, 3).join(' | ')
  return `exit ${result.exitCode}${detail ? `: ${detail}` : ''}`
}

async function tryRun(
  command: string,
  args: string[],
  timeoutMs: number,
  spawnOptions?: { cwd?: string; env?: Record<string, string> },
): Promise<{ out: string } | { error: string }> {
  try {
    const out = await runner()(command, args, timeoutMs, spawnOptions)
    return { out }
  } catch (error) {
    const described = describeFailure(error)
    const key = `${command} ${args.join(' ')} → ${described}`
    if (!loggedFailures.has(key)) {
      loggedFailures.add(key)
      logger.warn(`probe failed: ${command} ${args.join(' ')} — ${described}`, LOG_SOURCE)
    }
    return { error: described }
  }
}

function nvidiaBin(): string {
  return process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi'
}

/**
 * The bundled exe on Windows (resolved by the caller), or whatever XPU Manager
 * put on PATH elsewhere. Windows has no `xpu-smi` on PATH, so without the
 * bundled binary there is no Intel probe at all.
 */
function xpuBin(): string | null {
  if (options.xpuSmiPath) return options.xpuSmiPath
  if (process.platform === 'win32') return null
  return 'xpu-smi'
}

/** Same environment and working directory the (known-working) discovery probe uses. */
function xpuSpawnOptions(bin: string): { cwd?: string; env: Record<string, string> } {
  return {
    ...(path.isAbsolute(bin) ? { cwd: path.dirname(bin) } : {}),
    env: { ONEAPI_DEVICE_SELECTOR: '*' },
  }
}

async function nvidiaGpus(): Promise<GpuSample[]> {
  const result = await tryRun(
    nvidiaBin(),
    [`--query-gpu=${NVIDIA_QUERY}`, '--format=csv,noheader,nounits'],
    NVIDIA_TIMEOUT_MS,
  )
  if ('error' in result) {
    report.nvidia.lastError = result.error
    return []
  }
  report.nvidia.lastOkAt = nowMs()
  delete report.nvidia.lastError
  return parseNvidiaSmiCsv(result.out)
}

/**
 * Windows and Linux ship different CLIs under the same name: the Windows build
 * has no `discovery --dump`, so the catalog is read from `discovery -j` there
 * and per-device detail is a second call.
 */
async function ensureIntelCatalog(bin: string): Promise<Map<string, IntelCatalogEntry>> {
  if (intelCatalog) return intelCatalog
  if (intelCatalogAttempted) return new Map()
  intelCatalogAttempted = true
  const spawnOptions = xpuSpawnOptions(bin)
  const catalog = new Map<string, IntelCatalogEntry>()

  if (process.platform === 'win32') {
    const listed = await tryRun(bin, ['discovery', '-j'], DISCOVERY_TIMEOUT_MS, spawnOptions)
    if ('error' in listed) {
      report.intel.lastError = listed.error
      return catalog
    }
    for (const [id, name] of parseXpuSmiDiscoveryJson(listed.out)) {
      // `--query-gpu` reports memory.total itself, so the per-device detail call
      // would be a second spawn (and a spurious failure on a build whose
      // `discovery` takes no -d) for something already known.
      if (xpuDialect === 'query-gpu') {
        catalog.set(id, { name })
        continue
      }
      const detail = await tryRun(
        bin,
        ['discovery', '-d', id, '-j'],
        DISCOVERY_TIMEOUT_MS,
        spawnOptions,
      )
      catalog.set(id, {
        name,
        memTotalMiB: 'out' in detail ? parseXpuSmiMemoryTotalMiB(detail.out) : undefined,
      })
    }
  } else {
    const dumped = await tryRun(
      bin,
      ['discovery', '--dump', '1,2,16'],
      DISCOVERY_TIMEOUT_MS,
      spawnOptions,
    )
    if ('error' in dumped) {
      report.intel.lastError = dumped.error
      return catalog
    }
    for (const [id, entry] of parseXpuSmiDiscoveryCsv(dumped.out)) catalog.set(id, entry)
  }

  intelCatalog = catalog
  report.intel.devices = [...catalog.keys()]
  logger.info(
    `xpu-smi discovered ${catalog.size} device(s): ${
      [...catalog.entries()].map(([id, e]) => `${id}=${e.name}`).join(', ') || 'none'
    }`,
    LOG_SOURCE,
  )
  return catalog
}

/**
 * Builds of `xpu-smi` differ in how a single sample is asked for, and the name
 * and version do not tell them apart: v2.0 on Arc B-series exposes an
 * nvidia-smi-style `--query-gpu`, while the CLI Intel documents uses a `dump`
 * subcommand — whose `-m`/`-n` options that same v2.0 build rejects. So the
 * dialect is read out of `--help` once rather than assumed, and the command
 * that worked is logged.
 */
export function detectXpuDialect(helpOutput: string): XpuDialect {
  return /--query-gpu/.test(helpOutput) ? 'query-gpu' : 'dump'
}

/**
 * Field sets to try, richest first. A build that rejects one unknown field
 * rejects the whole query, so falling back costs a sample but never the probe;
 * the set that worked is remembered for the session.
 */
const XPU_QUERY_CANDIDATES = [
  'index,name,utilization.gpu,memory.used,memory.total,power.draw,clocks.current.graphics',
  'index,name,utilization.gpu,memory.used,memory.total',
  'utilization.gpu,memory.used,memory.total',
  'memory.used',
]

async function intelViaQueryGpu(
  bin: string,
  catalog: Map<string, IntelCatalogEntry>,
): Promise<GpuSample[]> {
  const spawnOptions = xpuSpawnOptions(bin)
  const candidates = xpuQueryFields ? [xpuQueryFields] : XPU_QUERY_CANDIDATES
  for (const fields of candidates) {
    const result = await tryRun(
      bin,
      [`--query-gpu=${fields}`, '--format=csv,noheader,nounits'],
      XPU_DUMP_TIMEOUT_MS,
      spawnOptions,
    )
    if ('error' in result) {
      report.intel.lastError = result.error
      continue
    }
    const requested = fields.split(',')
    const gpus = parseQueryGpuCsv(result.out, requested, 'intel')
    if (gpus.length === 0) continue
    if (xpuQueryFields !== fields) {
      xpuQueryFields = fields
      report.intel.command = `--query-gpu=${fields}`
      logger.info(`xpu-smi sampling with --query-gpu=${fields}`, LOG_SOURCE, true)
    }
    // A query that could not ask for `name`/`memory.total` still identifies its
    // device through the catalog, which discovery filled in.
    return gpus.map((gpu, position) => {
      const entry = catalog.get(gpu.id) ?? [...catalog.values()][position]
      return {
        ...gpu,
        name: requested.includes('name') ? gpu.name : (entry?.name ?? gpu.name),
        memTotalMiB: gpu.memTotalMiB ?? entry?.memTotalMiB,
      }
    })
  }
  return []
}

async function intelViaDump(
  bin: string,
  catalog: Map<string, IntelCatalogEntry>,
): Promise<GpuSample[]> {
  // `dump` takes one device id: `-d -1` is the Linux `xpumcli` spelling and is
  // rejected by the Windows CLI, so every device is dumped by its own id.
  const ids = catalog.size > 0 ? [...catalog.keys()] : ['0']
  const spawnOptions = xpuSpawnOptions(bin)
  const gpus: GpuSample[] = []
  for (const id of ids) {
    const result = await tryRun(
      bin,
      ['dump', '-d', id, '-m', XPU_DUMP_METRICS, '-n', '1'],
      XPU_DUMP_TIMEOUT_MS,
      spawnOptions,
    )
    if ('error' in result) {
      report.intel.lastError = result.error
      continue
    }
    gpus.push(...parseXpuSmiDumpCsv(result.out, catalog))
  }
  return gpus
}

async function ensureXpuDialect(bin: string): Promise<XpuDialect> {
  if (xpuDialect) return xpuDialect
  const help = await tryRun(bin, ['--help'], DISCOVERY_TIMEOUT_MS, xpuSpawnOptions(bin))
  // A build whose --help fails is not necessarily broken, so assume the
  // documented dialect rather than giving up on the probe.
  xpuDialect = 'out' in help ? detectXpuDialect(help.out) : 'dump'
  report.intel.dialect = xpuDialect
  logger.info(`xpu-smi dialect: ${xpuDialect}`, LOG_SOURCE, true)
  return xpuDialect
}

async function intelGpus(): Promise<GpuSample[]> {
  const bin = xpuBin()
  report.intel.bin = bin
  if (process.platform === 'win32') {
    report.intel.lastError = XPU_SMI_WINDOWS_DISABLED
    return []
  }
  if (!bin) return []
  const dialect = await ensureXpuDialect(bin)
  const catalog = await ensureIntelCatalog(bin)
  const gpus =
    dialect === 'query-gpu'
      ? await intelViaQueryGpu(bin, catalog)
      : await intelViaDump(bin, catalog)
  if (gpus.length > 0) {
    report.intel.lastOkAt = nowMs()
    delete report.intel.lastError
  }
  return gpus
}

function mergeGpus(nvidia: GpuSample[], intel: GpuSample[]): GpuSample[] {
  if (nvidia.length === 0) return intel
  if (intel.length === 0) return nvidia
  return [...nvidia, ...intel]
}

function sourceOf(
  nvidia: GpuSample[],
  intel: GpuSample[],
  wddm: GpuSample[],
): ComputeSnapshot['source'] {
  const smi = nvidia.length + intel.length
  if (wddm.length > 0 && smi > 0) return 'mixed'
  if (wddm.length > 0) return 'wddm'
  if (nvidia.length > 0 && intel.length > 0) return 'mixed'
  if (nvidia.length > 0) return 'nvidia-smi'
  if (intel.length > 0) return 'xpu-smi'
  return 'host'
}

async function wddmGpus(): Promise<GpuSample[]> {
  const collect = options.collectWddm ?? collectWddmGpus
  try {
    const gpus = await collect()
    if (gpus.length > 0 && report.wddm) {
      report.wddm.adapters = gpus.map((gpu) => gpu.name)
      report.wddm.lastOkAt = nowMs()
      delete report.wddm.lastError
    } else if (report.wddm) {
      const err = wddmLastError()
      if (err) report.wddm.lastError = err
    }
    return gpus
  } catch (error) {
    if (report.wddm) report.wddm.lastError = String(error)
    return []
  }
}

export async function collectComputeSnapshot(): Promise<ComputeSnapshot> {
  const [nvidia, intel, wddm] = await Promise.all([nvidiaGpus(), intelGpus(), wddmGpus()])
  const smi = mergeGpus(nvidia, intel)
  const smiFallback = process.platform === 'win32' ? omitSmiUtilization(smi) : smi
  const gpus = overlaySmiOntoWddm(wddm, smiFallback)
  const snapshot: ComputeSnapshot = {
    ts: nowMs(),
    source: sourceOf(nvidia, intel, wddm),
    host: hostMemorySnapshot(),
    gpus,
  }
  return snapshot
}

async function tick(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    const snapshot = await collectComputeSnapshot()
    pushSample(snapshot)
    sink?.(snapshot)
  } catch (error) {
    logger.warn(`sample failed: ${error}`, LOG_SOURCE)
  } finally {
    inFlight = false
  }
}

export function startComputeMetricsSampler(next: ComputeMetricsOptions = {}): void {
  options = next
  if (timer) return
  // Forced to the log file: without it, "no GPU numbers" on a user's machine is
  // indistinguishable from a probe that was never attempted.
  const intelProbe =
    process.platform === 'win32'
      ? 'disabled (Vulkan device-lost)'
      : (xpuBin() ?? 'unavailable (no xpu-smi)')
  logger.info(
    `sampling every ${next.intervalMs ?? DEFAULT_INTERVAL_MS}ms on ${process.platform}; ` +
      `wddm: ${process.platform === 'win32' ? 'DXGI+PDH' : 'n/a'}; ` +
      `intel probe: ${intelProbe}; nvidia probe: ${nvidiaBin()}`,
    LOG_SOURCE,
    true,
  )
  void tick()
  timer = setInterval(() => void tick(), next.intervalMs ?? DEFAULT_INTERVAL_MS)
  timer.unref?.()
}

export function stopComputeMetricsSampler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  inFlight = false
}

export function computeAttributes(
  stats: ComputeWindowStats,
  includeGpu: boolean,
): Record<string, number | string> {
  const attrs: Record<string, number | string> = {}
  if (stats.hostMemLastMiB !== undefined)
    attrs['aipg.host.mem_used_mib'] = round1(stats.hostMemLastMiB)
  if (stats.hostMemPeakMiB !== undefined)
    attrs['aipg.host.mem_peak_mib'] = round1(stats.hostMemPeakMiB)
  if (stats.hostMemTotalMiB !== undefined)
    attrs['aipg.host.mem_total_mib'] = round1(stats.hostMemTotalMiB)
  if (!includeGpu) return attrs
  if (stats.gpuName) attrs['aipg.gpu.name'] = stats.gpuName
  if (stats.gpuUtilLastPct !== undefined) attrs['aipg.gpu.util_pct'] = round1(stats.gpuUtilLastPct)
  if (stats.gpuUtilPeakPct !== undefined)
    attrs['aipg.gpu.util_peak_pct'] = round1(stats.gpuUtilPeakPct)
  if (stats.gpuMemLastMiB !== undefined)
    attrs['aipg.gpu.mem_used_mib'] = round1(stats.gpuMemLastMiB)
  if (stats.gpuMemPeakMiB !== undefined)
    attrs['aipg.gpu.mem_peak_mib'] = round1(stats.gpuMemPeakMiB)
  if (stats.gpuMemTotalMiB !== undefined)
    attrs['aipg.gpu.mem_total_mib'] = round1(stats.gpuMemTotalMiB)
  return attrs
}

export function computeMetadata(
  stats: ComputeWindowStats,
  includeGpu: boolean,
): Record<string, number> {
  const attrs: Record<string, number> = {}
  if (stats.hostMemPeakMiB !== undefined) attrs.hostMemPeakMib = round1(stats.hostMemPeakMiB)
  if (includeGpu && stats.gpuUtilPeakPct !== undefined)
    attrs.gpuUtilPeak = round1(stats.gpuUtilPeakPct)
  if (includeGpu && stats.gpuMemPeakMiB !== undefined)
    attrs.gpuMemPeakMib = round1(stats.gpuMemPeakMiB)
  return attrs
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}
