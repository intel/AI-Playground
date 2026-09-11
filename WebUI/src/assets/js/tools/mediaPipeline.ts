// ── Serializing media work ───────────────────────────────────────────────────
//
// There is one ComfyUI server and one global generation store behind every media
// tool, but both callers happily dispatch tool calls in parallel: Pi in Agent
// Mode and the AI SDK in Chat will each emit four calls in one step when the
// model asks for four sprites. Running them at once bought nothing — ComfyUI
// executes prompts strictly one after another anyway — and broke the
// bookkeeping around them: a queued run saw no progress and its watcher failed
// it as "stalled (no progress for 5 minutes)", while the runs overwrote each
// other's active preset and adopted each other's items (mediaAgentRuns mirrors
// generation state onto "the running run", of which it assumes there is one).
//
// Two lanes, because media work nests. A delegated `media` call is a nested LLM
// run plus one or more generations: holding the request lane keeps such a run
// whole, and keeps four media specialists from prompting the model at once. Each
// generation inside it takes the ComfyUI lane, as does a direct (undelegated)
// generation tool call. Only the request lane is ever held while waiting for the
// ComfyUI lane — never the other way round — so the two cannot deadlock.

type Lane = { tail: Promise<unknown>; waiting: number }

const requestLane: Lane = { tail: Promise.resolve(), waiting: 0 }
const comfyLane: Lane = { tail: Promise.resolve(), waiting: 0 }

function serialize<T>(lane: Lane, run: () => Promise<T>, abortSignal?: AbortSignal): Promise<T> {
  lane.waiting += 1
  const started = lane.tail.then(() => {
    lane.waiting -= 1
    // Cancelled while queued: never start the work in the first place.
    if (abortSignal?.aborted) throw new Error('Cancelled while waiting for the media pipeline.')
    return run()
  })
  // A failing call must not break the lane, and the lane must not pin its result.
  lane.tail = started.then(
    () => undefined,
    () => undefined,
  )
  return started
}

/** Runs a whole media request (delegated `media` tool call) on its own. */
export function queueMediaRequest<T>(run: () => Promise<T>, abortSignal?: AbortSignal): Promise<T> {
  return serialize(requestLane, run, abortSignal)
}

/** Runs one ComfyUI generation or edit on its own. */
export function queueComfyRun<T>(run: () => Promise<T>, abortSignal?: AbortSignal): Promise<T> {
  return serialize(comfyLane, run, abortSignal)
}

/**
 * Whether more generations are already queued behind the running one. With "keep
 * models loaded" off, each generation unloads the LLM on the way in and frees
 * ComfyUI plus reloads the LLM on the way out; asked for a spritesheet, that is
 * one full swap per sprite for models the very next run wants back. A run that
 * sees work waiting therefore leaves both where they are and lets the last one
 * out do the cleanup. Should that last run be cancelled at the gate above, the
 * LLM simply comes back with the next turn (`ensureReadyForInference`).
 */
export function comfyRunsWaiting(): boolean {
  return comfyLane.waiting > 0
}
