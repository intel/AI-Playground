export type IntegerInputRange = {
  fallback: number
  min: number
  max: number
}

/** Vue's number cast hands back the raw string when input is unparsable, so coerce explicitly. */
export function sanitizeIntegerInput(value: unknown, range: IntegerInputRange): number {
  if (value === null || value === undefined) return range.fallback
  if (typeof value === 'string' && value.trim() === '') return range.fallback

  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed)) return range.fallback

  return Math.min(Math.max(parsed, range.min), range.max)
}
