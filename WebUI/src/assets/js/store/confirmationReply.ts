// Pure helper for interpreting a free-text channel reply as a yes/no answer to
// a pending confirmation. Kept in its own module (no store imports) so it can
// be unit-tested in isolation.

const CONFIRM_YES = new Set([
  'yes',
  'y',
  'yeah',
  'yep',
  'yup',
  'sure',
  'ok',
  'okay',
  'confirm',
  'confirmed',
  'apply',
  'approve',
  'approved',
  'do it',
  'go ahead',
  '👍',
  '✅',
])

const CONFIRM_NO = new Set([
  'no',
  'n',
  'nope',
  'nah',
  'cancel',
  'stop',
  'abort',
  "don't",
  'dont',
  'decline',
  'reject',
  '👎',
  '❌',
])

/**
 * Interpret a free-text reply as a yes/no answer to a pending confirmation.
 * Returns `true`/`false` for a recognized answer, or `null` when the reply is
 * not a confirmation (so it can flow through as a normal message).
 */
export function parseConfirmationReply(text: string): boolean | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '')
    .trim()
  if (!normalized) return null
  if (CONFIRM_YES.has(normalized)) return true
  if (CONFIRM_NO.has(normalized)) return false
  return null
}
