import type { Document } from '@langchain/classic/document'
import type { EmbedInquiry, IndexedDocument } from '@/types/rag'
import type { PhisonKmIngestConfig } from '@/types/phisonKmRag'

export function ingestDocument<Child>(
  post: <T, R>(eventType: string, child: Child, args: T) => Promise<R>,
  child: Child,
  document: IndexedDocument,
  phisonKmConfig?: PhisonKmIngestConfig,
): Promise<IndexedDocument> {
  const args = phisonKmConfig === undefined ? { document } : { document, phisonKmConfig }
  return post<
    { document: IndexedDocument; phisonKmConfig?: PhisonKmIngestConfig },
    IndexedDocument
  >('addDocumentToRAGList', child, args)
}

export function retrieveChunks<Child>(
  post: <T, R>(eventType: string, child: Child, args: T) => Promise<R>,
  child: Child,
  inquiry: EmbedInquiry,
): Promise<Document[]> {
  return post<EmbedInquiry, Document[]>('embedInputUsingRag', child, inquiry)
}
