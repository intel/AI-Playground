// Port parsing for the LAN chat setup step. Its own module (like
// `confirmationReply.ts`) so the rule can be unit-tested without pulling the
// Home Agent store into the test.

export const DEFAULT_LOCAL_WEB_PORT = 8765
export const MIN_LOCAL_WEB_PORT = 1024
export const MAX_LOCAL_WEB_PORT = 65535

/**
 * The usable port in `raw`, or null when there isn't one.
 *
 * Takes `unknown` on purpose: the field is bound with `v-model` to an
 * `<input type="number">`, and Vue applies the `.number` modifier implicitly
 * there — so this receives a string initially and a number after the user types
 * (or `''` when they clear it). Anything out of range is rejected rather than
 * quietly replaced by the default, which would start the server on a port nobody
 * asked for.
 */
export function parseLocalWebPort(raw: unknown): number | null {
  const text = String(raw ?? '').trim()
  if (!/^\d+$/.test(text)) return null
  const port = Number(text)
  return port >= MIN_LOCAL_WEB_PORT && port <= MAX_LOCAL_WEB_PORT ? port : null
}
