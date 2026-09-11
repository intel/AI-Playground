// Reasoning durations are measured where the stream is produced — Chat mode in
// `openAiCompatibleChat`, Agent Mode in the Pi stream translator — and travel as
// `aipg` provider metadata on the reasoning part. Reading them from the part
// keeps every surface (chat view, agent transcript, Home Agent channels) on one
// set of timings that survives persistence and reload.

export type ReasoningTiming = { startedAt?: number; finishedAt?: number }

type TimedPartShape = {
  type?: unknown
  providerMetadata?: { aipg?: { reasoningStarted?: unknown; reasoningFinished?: unknown } }
}

function shapeOf(part: unknown): TimedPartShape {
  return typeof part === 'object' && part !== null ? (part as TimedPartShape) : {}
}

function stamp(value: unknown): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined
}

/** Timing of one reasoning part; both stamps are absent for older transcripts. */
export function reasoningTimingOf(part: unknown): ReasoningTiming {
  const timing = shapeOf(part).providerMetadata?.aipg
  return {
    startedAt: stamp(timing?.reasoningStarted),
    finishedAt: stamp(timing?.reasoningFinished),
  }
}

/**
 * Total time spent reasoning across the given parts. A turn interleaves thinking
 * with tool calls, so per-block durations are summed rather than spanning
 * earliest start → latest finish, which would count tool execution as thinking.
 */
export function reasoningElapsedMsFromParts(parts: readonly unknown[]): number {
  let total = 0
  for (const part of parts) {
    if (shapeOf(part).type !== 'reasoning') continue
    const { startedAt, finishedAt } = reasoningTimingOf(part)
    if (startedAt !== undefined && finishedAt !== undefined) {
      total += Math.max(0, finishedAt - startedAt)
    }
  }
  return total
}
