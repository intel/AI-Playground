import { extractMessage, isCancellation } from '@/assets/js/errors/appError'

export type RagEmbeddingPrepResult =
  { status: 'ready' } | { status: 'declined' } | { status: 'failed'; error: string }

export function ragEmbeddingPrepFailure(
  error: unknown,
): Exclude<RagEmbeddingPrepResult, { status: 'ready' }> {
  if (isCancellation(error)) return { status: 'declined' }
  return { status: 'failed', error: extractMessage(error) }
}
