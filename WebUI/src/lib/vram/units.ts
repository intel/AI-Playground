export const MIB = 1024 * 1024
export const GIB = 1024 * MIB

export function bytesToMiB(bytes: number): number {
  return bytes / MIB
}

export function mibToBytes(mib: number): number {
  return mib * MIB
}

/** llama.cpp pads KV cell counts to 256. */
export function padKvCells(cells: number): number {
  if (cells <= 0) return 0
  return Math.ceil(cells / 256) * 256
}

const KV_BYTES_PER_ELEM: Record<string, number> = {
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 34 / 32,
  q5_1: 0.75,
  q5_0: 0.6875,
  q4_1: 0.625,
  q4_0: 0.5625,
  iq4_nl: 0.5625,
}

export function kvBytesPerElem(cacheType: string | undefined): number {
  return KV_BYTES_PER_ELEM[(cacheType ?? 'f16').trim().toLowerCase()] ?? 2
}
