type Identified = { id: string }

/**
 * A chat turn only ever appends to a thread or truncates it from the end, so a
 * live list that starts at a message the stored thread holds in the middle
 * comes from a view that lost its history: a resumed turn replays that turn
 * alone. Restore the missing prefix; anything else is returned untouched, so a
 * regenerate (truncated from the end) and a cleared thread still pass through.
 */
export function restoreMissingHistory<T extends Identified>(stored: T[], live: T[]): T[] {
  if (stored.length === 0 || live.length === 0) return live
  const index = stored.findIndex((message) => message.id === live[0].id)
  if (index <= 0) return live
  return [...stored.slice(0, index), ...live]
}
