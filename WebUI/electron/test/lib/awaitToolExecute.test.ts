import { describe, expect, it } from 'vitest'
import { awaitToolExecute, isAsyncIterable } from '@/lib/awaitToolExecute'

describe('awaitToolExecute', () => {
  it('awaits a Promise result', async () => {
    await expect(awaitToolExecute(Promise.resolve({ images: [1] }))).resolves.toEqual({
      images: [1],
    })
  })

  it('drains an async iterable to the last yield', async () => {
    async function* stream() {
      yield { images: [] }
      yield { images: [{ id: 'done' }] }
    }
    expect(isAsyncIterable(stream())).toBe(true)
    await expect(awaitToolExecute(stream())).resolves.toEqual({ images: [{ id: 'done' }] })
  })
})
