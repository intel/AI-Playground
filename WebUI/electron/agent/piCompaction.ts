// Pi auto-compacts when occupancy > window − reserve, then keeps keepRecent of
// the tail. Its defaults (16k reserve, 20k keep) need a ~36k+ window; on 32k,
// keep sits above the trigger and the next llama.cpp request still exceeds n_ctx.

export type AgentCompactionSettings = {
  enabled: true
  reserveTokens: number
  keepRecentTokens: number
}

const DEFAULT_RESERVE = 16384
const DEFAULT_KEEP = 20000
const OUTPUT_TOKEN_TARGET = { local: 32768, cloud: 16384 } as const

function slackFor(window: number): number {
  return Math.min(4096, Math.floor(window / 8))
}

export function compactionSettingsForWindow(contextWindow: number): AgentCompactionSettings {
  const window = Math.max(1, Math.floor(contextWindow))
  const slack = slackFor(window)
  const reserveTokens = Math.min(DEFAULT_RESERVE, Math.max(1, Math.floor(window / 4)))
  const keepCap = Math.min(DEFAULT_KEEP, Math.max(1, Math.floor(window / 3)))
  const keepRecentTokens = Math.max(1, Math.min(keepCap, window - reserveTokens - slack))
  return { enabled: true, reserveTokens, keepRecentTokens }
}

/**
 * Completion budget for one agent step, which is not the same thing as a chat
 * answer: a step is usually a tool call, and the arguments of a `write` carry a
 * whole file. Pi refuses a tool call whose arguments were cut off, so a 4096-token
 * ceiling made a game of any size unbuildable. Half the context window is the
 * hard bound; the local target is only reached from the 64k window up. The
 * post-compact tail plus this budget must still fit in n_ctx.
 */
export function outputTokenBudget(contextWindow: number, source: 'local' | 'cloud'): number {
  const window = Math.max(1, Math.floor(contextWindow))
  const { keepRecentTokens } = compactionSettingsForWindow(window)
  const roomAfterCompact = Math.max(1, window - keepRecentTokens - slackFor(window))
  return Math.min(OUTPUT_TOKEN_TARGET[source], Math.floor(window / 2), roomAfterCompact)
}
