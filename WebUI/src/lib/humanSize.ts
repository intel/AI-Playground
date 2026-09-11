// The download API reports each model's size as an already-formatted string
// (psutil's `bytes2human`, e.g. `3.20G`), so totalling a batch means parsing it
// back. Kept here as pure functions because the confirm dialog is the only place
// that needs the sum and a wrong total there is worse than none.

const SYMBOLS = ['B', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'] as const

/** Bytes for a `bytes2human` string, or undefined if it is not one. */
export function parseHumanSize(value: string): number | undefined {
  const match = /^\s*(-?[\d.]+)\s*([BKMGTPEZY])?B?\s*$/i.exec(value)
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return undefined
  const symbol = (match[2] ?? 'B').toUpperCase() as (typeof SYMBOLS)[number]
  const exponent = SYMBOLS.indexOf(symbol)
  return amount * 1024 ** exponent
}

export function formatHumanSize(bytes: number): string {
  let exponent = 0
  let value = bytes
  while (value >= 1024 && exponent < SYMBOLS.length - 1) {
    value /= 1024
    exponent += 1
  }
  return `${value.toFixed(exponent === 0 ? 0 : 2)}${SYMBOLS[exponent]}`
}

/**
 * Total of the sizes that could be parsed. Returns undefined when none could be
 * — a batch whose sizes are still loading, or that the API returned blank for,
 * gets no total rather than a misleading `0B`.
 */
export function sumHumanSizes(values: readonly string[]): string | undefined {
  let total = 0
  let parsed = 0
  for (const value of values) {
    const bytes = parseHumanSize(value)
    if (bytes === undefined) continue
    total += bytes
    parsed += 1
  }
  if (parsed === 0) return undefined
  return formatHumanSize(total)
}
