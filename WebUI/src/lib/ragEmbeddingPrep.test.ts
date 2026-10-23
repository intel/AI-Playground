import { describe, expect, it } from 'vitest'
import { createCancellation } from '@/assets/js/errors/appError'
import { ragEmbeddingPrepFailure } from '@/lib/ragEmbeddingPrep'

describe('ragEmbeddingPrepFailure', () => {
  it('maps a cancellation to declined', () => {
    expect(ragEmbeddingPrepFailure(createCancellation())).toEqual({ status: 'declined' })
  })

  it('maps any other error to failed', () => {
    expect(ragEmbeddingPrepFailure(new Error('disk full'))).toEqual({
      status: 'failed',
      error: 'disk full',
    })
  })
})
