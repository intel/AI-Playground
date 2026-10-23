/** True when `execute` returned a stream of outputs rather than one Promise. */
export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
  )
}

/**
 * The AI SDK treats an AsyncIterable `execute` return as a streaming tool:
 * each yield is preliminary, and `fullStream` can close before the last value.
 * Always resolve to one final output so Comfy (minutes) is actually awaited.
 */
export async function awaitToolExecute(result: unknown): Promise<unknown> {
  if (isAsyncIterable(result)) {
    let last: unknown
    for await (const part of result) last = part
    return last
  }
  return await result
}
