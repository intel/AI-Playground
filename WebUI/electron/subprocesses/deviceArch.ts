// https://github.com/intel/compute-runtime/blob/master/shared/source/dll/devices/devices_base.inl
const ID2ARCH: { [key: number]: Arch } = {
  // bmg
  0xe202: 'bmg',
  0xe20b: 'bmg',
  0xe20c: 'bmg',
  0xe20d: 'bmg',
  0xe212: 'bmg',

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

export type Arch = 'bmg' | 'acm' | 'arl_h' | 'lnl' | 'mtl' | 'unknown'
