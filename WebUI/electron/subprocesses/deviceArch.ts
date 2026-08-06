// https://github.com/intel/compute-runtime/blob/master/shared/source/dll/devices/devices_base.inl
const ID2ARCH: { [key: number]: Arch } = {
  // bmg
  0xe202: 'bmg',
  0xe209: 'bmg', // Arc B580
  0xe20b: 'bmg', // Arc B580
  0xe20c: 'bmg', // Arc B570
  0xe20d: 'bmg',
  0xe210: 'bmg',
  0xe211: 'bmg', // Arc Pro B60
  0xe212: 'bmg', // Arc Pro B50
  0xe215: 'bmg',
  0xe216: 'bmg',
  0xe220: 'bmg',
  0xe221: 'bmg',
  0xe222: 'bmg', // Arc Pro B65
  0xe223: 'bmg', // Arc Pro B70

  // lnl
  0x6420: 'lnl',
  0x64a0: 'lnl',
  0x64b0: 'lnl',

  // dg2, using alias name "acm"
  0x4f80: 'acm',
  0x4f81: 'acm',
  0x4f82: 'acm',
  0x4f83: 'acm',
  0x4f84: 'acm',
  0x4f85: 'acm',
  0x4f86: 'acm',
  0x4f87: 'acm',
  0x4f88: 'acm',
  0x5690: 'acm',
  0x5691: 'acm',
  0x5692: 'acm',
  0x5693: 'acm',
  0x5694: 'acm',
  0x5695: 'acm',
  0x5696: 'acm',
  0x5697: 'acm',
  0x56a3: 'acm',
  0x56a4: 'acm',
  0x56b0: 'acm',
  0x56b1: 'acm',
  0x56b2: 'acm',
  0x56b3: 'acm',
  0x56ba: 'acm',
  0x56bb: 'acm',
  0x56bc: 'acm',
  0x56bd: 'acm',
  0x56be: 'acm',
  0x56bf: 'acm',
  0x56a0: 'acm',
  0x56a1: 'acm',
  0x56a2: 'acm',
  0x56a5: 'acm',
  0x56a6: 'acm',
  0x56c0: 'acm',
  0x56c1: 'acm',
  0x56c2: 'acm',

  // mtl
  0x7d40: 'mtl',
  0x7d55: 'mtl',
  0x7dd5: 'mtl',
  0x7d45: 'mtl',

  // // arl
  // 0x7D67: "arl",
  0x7d51: 'arl_h',
  0x7dd1: 'arl_h',
  // 0x7D41: "arl",

  // wcl
  0xfd80: 'wcl',
  0xfd81: 'wcl',
}

export function getDeviceArch(deviceId: number): Arch {
  return ID2ARCH[deviceId] || 'unknown'
}

export function getArchPriority(arch: Arch): number {
  switch (arch) {
    case 'bmg':
      return 5
    case 'acm':
      return 4
    case 'arl_h':
      return 3
    case 'wcl':
      return 2
    case 'lnl':
      return 2
    case 'mtl':
      return 1
    default:
      return 0
  }
}

const levenshteinDistance = (a: string, b: string): number => {
  if (a.length < b.length) [a, b] = [b, a]

  let prev = Array(b.length + 1).fill(0)
  let curr = Array(b.length + 1).fill(0)

  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }

  return prev[b.length]
}

export const getBestDevice = (
  availableDevices: { id: string; name: string }[],
  bestDeviceName: string,
) =>
  availableDevices
    .map((d) => ({ id: d.id, distanceToBest: levenshteinDistance(d.name, bestDeviceName) }))
    .toSorted((a, b) => a.distanceToBest - b.distanceToBest)[0].id

export type Arch = 'bmg' | 'acm' | 'arl_h' | 'wcl' | 'lnl' | 'mtl' | 'unknown'

// ---------------------------------------------------------------------------
// Device category classification (drives the post-install default device pick)
// ---------------------------------------------------------------------------
// Preference order requested by product: dedicated GPU > integrated GPU > NPU >
// CPU. Each backend enumerates devices with its own ids, so classification works
// off the (id, name) pair plus a reference list of physically detected GPUs.

export type DeviceCategory = 'dgpu' | 'igpu' | 'npu' | 'cpu' | 'unknown'

const CATEGORY_RANK: Record<DeviceCategory, number> = {
  dgpu: 4,
  igpu: 3,
  npu: 2,
  cpu: 1,
  unknown: 0,
}

// bmg (Battlemage) and acm (Alchemist / DG2 Arc) ship as discrete add-in cards;
// every other known Intel arch is an integrated GPU inside a CPU package.
const DISCRETE_INTEL_ARCHES: ReadonlySet<Arch> = new Set<Arch>(['bmg', 'acm'])

/** Minimal view of a physically detected accelerator, used as classification reference. */
export type ReferenceAccelerator = {
  vendor: 'intel' | 'nvidia' | 'amd' | 'unknown'
  name: string
  gpuDeviceId: string | null // Intel PCI id like '0x56A0'; null when unknown
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Best-effort match of a target device name against a list of named candidates.
 * Returns the candidate whose normalized name is closest by edit distance, but
 * only when the match is confident (distance under half the longer name) so
 * unrelated names aren't force-matched. Used both to map a backend device to a
 * physically detected accelerator and to map the user's preferred device (chosen
 * pre-install from raw hardware names) onto a backend's own device list.
 */
export function bestNameMatch<T extends { name: string }>(
  target: string,
  candidates: T[],
): T | undefined {
  const normalizedTarget = normalizeName(target)
  if (normalizedTarget === '' || candidates.length === 0) return undefined
  let best: { candidate: T; distance: number; length: number } | undefined
  for (const candidate of candidates) {
    const normalized = normalizeName(candidate.name)
    if (normalized === '') continue
    const distance = levenshteinDistance(normalizedTarget, normalized)
    if (best === undefined || distance < best.distance) {
      best = { candidate, distance, length: Math.max(normalizedTarget.length, normalized.length) }
    }
  }
  if (best === undefined) return undefined
  return best.distance <= best.length * 0.5 ? best.candidate : undefined
}

function matchReference(
  name: string,
  reference: ReferenceAccelerator[],
): ReferenceAccelerator | undefined {
  return bestNameMatch(name, reference)
}

/**
 * Classify a single backend device into dgpu/igpu/npu/cpu. GPU discreteness is
 * resolved via the physically detected reference list (PCI id → arch table for
 * Intel, vendor for NVIDIA). A GPU we can't confidently match is treated as
 * integrated: still ranked above NPU/CPU, but never mislabeled as discrete.
 */
export function categorizeDevice(
  device: { id: string; name: string },
  reference: ReferenceAccelerator[],
): DeviceCategory {
  const id = device.id.toUpperCase()
  const name = device.name.toUpperCase()
  if (id === 'CPU' || name === 'CPU') return 'cpu'
  if (id.includes('NPU') || name.includes('NPU')) return 'npu'

  const ref = matchReference(device.name, reference)
  if (ref === undefined) return 'igpu'
  if (ref.vendor === 'nvidia') return 'dgpu'
  if (ref.vendor === 'intel' && ref.gpuDeviceId !== null) {
    const arch = getDeviceArch(Number(ref.gpuDeviceId))
    return DISCRETE_INTEL_ARCHES.has(arch) ? 'dgpu' : 'igpu'
  }
  return 'igpu'
}

/**
 * Order a backend's detected devices by category preference
 * (dGPU > iGPU > NPU > CPU), preserving detection order within a category so
 * ties fall back to the order the backend reported.
 */
export function rankDevicesByCategory<T extends { id: string; name: string }>(
  devices: T[],
  reference: ReferenceAccelerator[],
): T[] {
  return devices
    .map((device, index) => ({
      device,
      index,
      rank: CATEGORY_RANK[categorizeDevice(device, reference)],
    }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map((entry) => entry.device)
}
