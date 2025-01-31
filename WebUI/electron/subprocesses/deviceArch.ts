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
  // 0x7D51: "arl",
  // 0x7DD1: "arl",
  // 0x7D41: "arl",
}

export function getDeviceArch(deviceId: number): Arch {
  return ID2ARCH[deviceId] || 'unknown'
}

export function getArchPriority(arch: Arch): number {
  switch (arch) {
    case 'bmg':
      return 4
    case 'acm':
      return 3
    case 'lnl':
      return 2
    case 'mtl':
      return 1
    default:
      return 0
  }
}

export type Arch = 'bmg' | 'acm' | 'lnl' | 'mtl' | 'unknown'
