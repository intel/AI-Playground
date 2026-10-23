import koffi, { type TypeObject } from 'koffi'
import { appLoggerInstance } from '../../observability/logger.ts'
import type { GpuSample } from '@/types/computeMetrics.ts'
import {
  aggregatePdhEngineUtil,
  applyGpuMemoryRollup,
  bytesToMiB,
  luidKey,
  parsePdhGpuInstance,
  vendorFromPciId,
} from '@/lib/wddmGpuMetrics.ts'

const LOG_SOURCE = 'compute-metrics'
const HOST_IS_WIN32 = process.platform === 'win32'
const DXGI_ADAPTER_FLAG_SOFTWARE = 2
const PDH_FMT_DOUBLE = 0x00000200
const PDH_FMT_NOCAP100 = 0x00008000
const PDH_MORE_DATA = 0x800007d2
const COINIT_MULTITHREADED = 0x0

const COUNTERS = {
  dedicated: String.raw`\GPU Adapter Memory(*)\Dedicated Usage`,
  shared: String.raw`\GPU Adapter Memory(*)\Shared Usage`,
  engine: String.raw`\GPU Engine(*)\Utilization Percentage`,
} as const

type DxgiAdapter = {
  name: string
  vendorId: number
  dedicatedTotalMiB: number
  sharedTotalMiB: number
  high: number
  low: number
}

type Native = {
  CreateDXGIFactory1: (riid: object, ppFactory: unknown[]) => number
  IID_IDXGIFactory1: object
  EnumAdapters1: TypeObject
  GetDesc1: TypeObject
  Release: TypeObject
  DXGI_ADAPTER_DESC1: TypeObject
  PdhOpenQueryW: (src: unknown, user: number, out: unknown[]) => number
  PdhAddEnglishCounterW: (query: unknown, path: string, user: number, out: unknown[]) => number
  PdhCollectQueryData: (query: unknown) => number
  PdhGetFormattedCounterArrayW: (
    counter: unknown,
    fmt: number,
    bufSize: unknown[],
    itemCount: unknown[],
    buffer: unknown,
  ) => number
  PdhCloseQuery: (query: unknown) => number
  PDH_FMT_COUNTERVALUE_ITEM_W: TypeObject
}

type PdhQuery = {
  query: unknown
  dedicated: unknown
  shared: unknown
  engine: unknown
}

let native: Native | null = null
let nativeError: string | undefined
let pdh: PdhQuery | null = null
let pdhPrimed = false
let dxgiCache: DxgiAdapter[] | null = null
const loggedFailures = new Set<string>()

function logFail(message: string): void {
  if (loggedFailures.has(message)) return
  loggedFailures.add(message)
  appLoggerInstance.warn(message, LOG_SOURCE, true)
}

function failed(hr: number): boolean {
  return hr < 0
}

function initNative(): Native | null {
  if (native) return native
  if (nativeError) return null
  try {
    const ole32 = koffi.load('ole32.dll')
    const CoInitializeEx = ole32.func(
      'int __stdcall CoInitializeEx(void *pvReserved, uint dwCoInit)',
    )
    const hrInit = CoInitializeEx(null, COINIT_MULTITHREADED)
    // RPC_E_CHANGED_MODE (already initialized the other way) is fine.
    if (failed(hrInit) && hrInit >>> 0 !== 0x80010106) {
      logFail(`wddm: CoInitializeEx failed: 0x${(hrInit >>> 0).toString(16)}`)
    }

    koffi.struct('GUID', {
      Data1: 'uint32',
      Data2: 'uint16',
      Data3: 'uint16',
      Data4: koffi.array('uint8', 8),
    })
    const LUID = koffi.struct('LUID', {
      LowPart: 'uint32',
      HighPart: 'int32',
    })
    const DXGI_ADAPTER_DESC1 = koffi.struct('DXGI_ADAPTER_DESC1', {
      Description: koffi.array('char16_t', 128),
      VendorId: 'uint32',
      DeviceId: 'uint32',
      SubSysId: 'uint32',
      Revision: 'uint32',
      DedicatedVideoMemory: 'size_t',
      DedicatedSystemMemory: 'size_t',
      SharedSystemMemory: 'size_t',
      AdapterLuid: LUID,
      Flags: 'uint32',
    })

    const dxgi = koffi.load('dxgi.dll')
    const CreateDXGIFactory1 = dxgi.func(
      'int __stdcall CreateDXGIFactory1(GUID *riid, _Out_ void **ppFactory)',
    )
    const EnumAdapters1 = koffi.proto(
      'int __stdcall EnumAdapters1(void *this, uint Adapter, _Out_ void **ppAdapter)',
    )
    const GetDesc1 = koffi.proto(
      'int __stdcall GetDesc1(void *this, _Out_ DXGI_ADAPTER_DESC1 *pDesc)',
    )
    const Release = koffi.proto('uint __stdcall Release(void *this)')

    const pdhDll = koffi.load('pdh.dll')
    const PdhOpenQueryW = pdhDll.func(
      'long __stdcall PdhOpenQueryW(const char16_t *szDataSource, uintptr dwUserData, _Out_ void **phQuery)',
    )
    const PdhAddEnglishCounterW = pdhDll.func(
      'long __stdcall PdhAddEnglishCounterW(void *hQuery, const char16_t *szFullCounterPath, uintptr dwUserData, _Out_ void **phCounter)',
    )
    const PdhCollectQueryData = pdhDll.func('long __stdcall PdhCollectQueryData(void *hQuery)')
    const PdhGetFormattedCounterArrayW = pdhDll.func(
      'long __stdcall PdhGetFormattedCounterArrayW(void *hCounter, uint dwFormat, _Inout_ uint32 *lpdwBufferSize, _Out_ uint32 *lpdwItemCount, void *ItemBuffer)',
    )
    const PdhCloseQuery = pdhDll.func('long __stdcall PdhCloseQuery(void *hQuery)')
    const PDH_FMT_COUNTERVALUE_ITEM_W = koffi.struct('PDH_FMT_COUNTERVALUE_ITEM_W', {
      szName: 'char16_t *',
      CStatus: 'uint32',
      doubleValue: 'double',
    })

    native = {
      CreateDXGIFactory1,
      IID_IDXGIFactory1: {
        Data1: 0x770aae78,
        Data2: 0xf26f,
        Data3: 0x4dba,
        Data4: [0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87],
      },
      EnumAdapters1,
      GetDesc1,
      Release,
      DXGI_ADAPTER_DESC1,
      PdhOpenQueryW,
      PdhAddEnglishCounterW,
      PdhCollectQueryData,
      PdhGetFormattedCounterArrayW,
      PdhCloseQuery,
      PDH_FMT_COUNTERVALUE_ITEM_W,
    }
    return native
  } catch (error) {
    nativeError = String(error)
    logFail(`wddm: failed to load DXGI/PDH: ${nativeError}`)
    return null
  }
}

function vtableSlot(thisPtr: unknown, slot: number): unknown {
  const vtbl = koffi.decode(thisPtr, 'void *')
  const slots = koffi.decode(vtbl, koffi.array('void *', slot + 1)) as unknown[]
  return slots[slot]
}

function decodeDescription(raw: unknown): string {
  if (typeof raw === 'string') return raw.replace(/\0.*$/, '').trim()
  if (!Array.isArray(raw)) return ''
  let out = ''
  for (const code of raw) {
    if (!code) break
    out += String.fromCharCode(Number(code))
  }
  return out.trim()
}

function enumDxgiAdapters(api: Native): DxgiAdapter[] {
  const factoryOut: unknown[] = [null]
  const hr = api.CreateDXGIFactory1(api.IID_IDXGIFactory1, factoryOut)
  const factory = factoryOut[0]
  if (failed(hr) || !factory) {
    throw new Error(`CreateDXGIFactory1 0x${(hr >>> 0).toString(16)}`)
  }
  const adapters: DxgiAdapter[] = []
  try {
    for (let index = 0; index < 16; index++) {
      const adapterOut: unknown[] = [null]
      const enumHr = koffi.call(
        vtableSlot(factory, 12),
        api.EnumAdapters1,
        factory,
        index,
        adapterOut,
      ) as number
      if (failed(enumHr) || !adapterOut[0]) break
      const adapter = adapterOut[0]
      try {
        const desc: Record<string, unknown> = {}
        const descHr = koffi.call(vtableSlot(adapter, 10), api.GetDesc1, adapter, desc) as number
        if (failed(descHr)) continue
        const flags = Number(desc.Flags ?? 0)
        if (flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue
        const luid = desc.AdapterLuid as { LowPart?: number; HighPart?: number } | undefined
        const name = decodeDescription(desc.Description)
        if (!name || /basic render/i.test(name)) continue
        adapters.push({
          name,
          vendorId: Number(desc.VendorId ?? 0),
          dedicatedTotalMiB: bytesToMiB(Number(desc.DedicatedVideoMemory ?? 0)),
          sharedTotalMiB: bytesToMiB(Number(desc.SharedSystemMemory ?? 0)),
          high: Number(luid?.HighPart ?? 0),
          low: Number(luid?.LowPart ?? 0),
        })
      } finally {
        koffi.call(vtableSlot(adapter, 2), api.Release, adapter)
      }
    }
  } finally {
    koffi.call(vtableSlot(factory, 2), api.Release, factory)
  }
  return adapters
}

function ensurePdh(api: Native): PdhQuery {
  if (pdh) return pdh
  const queryOut: unknown[] = [null]
  const open = api.PdhOpenQueryW(null, 0, queryOut)
  if (open !== 0 || !queryOut[0]) throw new Error(`PdhOpenQueryW ${open}`)
  const query = queryOut[0]
  const add = (path: string): unknown => {
    const counterOut: unknown[] = [null]
    const status = api.PdhAddEnglishCounterW(query, path, 0, counterOut)
    if (status !== 0 || !counterOut[0]) {
      throw new Error(`PdhAddEnglishCounterW ${path} → ${status}`)
    }
    return counterOut[0]
  }
  pdh = {
    query,
    dedicated: add(COUNTERS.dedicated),
    shared: add(COUNTERS.shared),
    engine: add(COUNTERS.engine),
  }
  return pdh
}

function readCounterArray(api: Native, counter: unknown): { name: string; value: number }[] {
  const fmt = PDH_FMT_DOUBLE | PDH_FMT_NOCAP100
  const bufSize = [0]
  const itemCount = [0]
  let status = api.PdhGetFormattedCounterArrayW(counter, fmt, bufSize, itemCount, null)
  if (status !== 0 && status !== PDH_MORE_DATA && status >>> 0 !== PDH_MORE_DATA) {
    return []
  }
  const bytes = bufSize[0]
  if (!bytes) return []
  const buffer = Buffer.alloc(bytes)
  bufSize[0] = bytes
  status = api.PdhGetFormattedCounterArrayW(counter, fmt, bufSize, itemCount, buffer)
  if (status !== 0) return []
  const count = itemCount[0] ?? 0
  const size = koffi.sizeof(api.PDH_FMT_COUNTERVALUE_ITEM_W)
  const rows: { name: string; value: number }[] = []
  for (let i = 0; i < count; i++) {
    const item = koffi.decode(buffer, i * size, api.PDH_FMT_COUNTERVALUE_ITEM_W) as {
      szName?: string
      CStatus?: number
      doubleValue?: number
    }
    if (item.CStatus) continue
    const name = item.szName ?? ''
    const value = item.doubleValue
    if (!name || value == null || !Number.isFinite(value)) continue
    rows.push({ name, value })
  }
  return rows
}

function usageByLuid(rows: { name: string; value: number }[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const row of rows) {
    const parsed = parsePdhGpuInstance(row.name)
    if (!parsed) continue
    out.set(luidKey(parsed.high, parsed.low, parsed.phys), bytesToMiB(row.value))
  }
  return out
}

export function collectWddmGpus(): GpuSample[] {
  if (!HOST_IS_WIN32) return []
  const api = initNative()
  if (!api) return []
  try {
    if (!dxgiCache) {
      dxgiCache = enumDxgiAdapters(api)
      appLoggerInstance.info(
        `wddm: DXGI enumerated ${dxgiCache.length} adapter(s): ${dxgiCache
          .map((a) => a.name)
          .join(', ')}`,
        LOG_SOURCE,
        true,
      )
    }
    const query = ensurePdh(api)
    const collect = api.PdhCollectQueryData(query.query)
    if (collect !== 0) throw new Error(`PdhCollectQueryData ${collect}`)
    const firstCollect = !pdhPrimed
    pdhPrimed = true
    const dedicated = usageByLuid(readCounterArray(api, query.dedicated))
    const shared = usageByLuid(readCounterArray(api, query.shared))
    // Engine util is a rate counter; the first collect only arms it.
    const util = firstCollect
      ? new Map<string, number>()
      : aggregatePdhEngineUtil(readCounterArray(api, query.engine))
    return dxgiCache.map((adapter, index) => {
      const key = luidKey(adapter.high, adapter.low, 0)
      return applyGpuMemoryRollup({
        id: String(index),
        name: adapter.name,
        vendor: vendorFromPciId(adapter.vendorId),
        dedicatedTotalMiB: adapter.dedicatedTotalMiB,
        sharedTotalMiB: adapter.sharedTotalMiB,
        dedicatedUsedMiB: dedicated.get(key),
        sharedUsedMiB: shared.get(key),
        utilPct: util.get(key),
      })
    })
  } catch (error) {
    logFail(`wddm probe failed: ${error}`)
    return []
  }
}

export function wddmLastError(): string | undefined {
  return nativeError
}

export function resetWddmMetricsForTests(): void {
  if (pdh && native) {
    try {
      native.PdhCloseQuery(pdh.query)
    } catch {
      // ignore
    }
  }
  pdh = null
  pdhPrimed = false
  dxgiCache = null
  native = null
  nativeError = undefined
  loggedFailures.clear()
}
