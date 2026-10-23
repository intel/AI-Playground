import { z } from 'zod'

/**
 * Wire shapes for the kernel-owned RAG document list
 * (architecture-target §6.1, step 8): `AI-Playground/rag/documents.json`
 * holds the indexed document set — full split text included, which is why
 * it is a file of its own rather than a section of the (small)
 * preferences file. One writer chain; items stay opaque here.
 * `IndexedDocument` in `rag.ts` is the domain shape.
 */

export const RagDocumentsFileSchema = z.object({
  schemaVersion: z.literal(1),
  documents: z.array(z.unknown()),
})
export type RagDocumentsFile = z.infer<typeof RagDocumentsFileSchema>

/** The section-shaped payload the renderer store reads and writes. */
export const RagDocumentSectionSchema = z.object({
  ragList: z.array(z.unknown()),
})
export type RagDocumentSection = z.infer<typeof RagDocumentSectionSchema>
