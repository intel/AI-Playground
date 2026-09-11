import { Document } from '@langchain/classic/document'

/**
 * Phison KM (Knowledge Manager) RAG types.
 *
 * These are intentionally kept out of textInference.ts / langchain.ts — they are
 * only meaningful when the Phison aiDAPTIV+ (ssd-offload) build is active, and
 * living in a dedicated module keeps the KM feature encapsulated the same way
 * llamaCppPhison.ts / PhisonAidaptivOptions.vue already are for the backend and
 * settings-UI layers. See aidaptiv-km-rag-review-scope.md §W1 for the full
 * rationale.
 */

// Boundary-only: no `content` field. A group's text is always derivable as
// splitDB[startChunkIdx..endChunkIdx].pageContent joined — deriving it on demand
// (see deriveGroupContent below) keeps mergedGroups tiny (~50 bytes/group) so it can
// be persisted directly instead of duplicating the full document text a second time.
// This module holds no Vue/Pinia dependency, so electron/subprocesses/langchainPhisonKm.ts
// imports deriveGroupContent from here at runtime rather than duplicating it — there is
// exactly one implementation of the join, on both sides of the utility-process boundary.
export type MergedGroup = {
  groupId: string
  startChunkIdx: number
  endChunkIdx: number
}

// Fingerprint recorded alongside mergedGroups so a stale/incompatible grouping
// (e.g. chunkSize changed, or splitDB was rebuilt with a different chunk count)
// is detected instead of silently mis-indexing into splitDB. chunkCount vs
// splitDB.length is the cheapest and most direct signal that indices are stale.
export type MergedGroupsMeta = {
  chunkSize: number
  chunkOverlap: number
  maxTokensPerGroup: number
  chunkCount: number
}

// Warmup needs actual group text for the prefill request body. Unlike MergedGroup,
// this is a transient IPC payload (never persisted), so carrying content here is fine.
export type WarmupGroup = {
  groupId: string
  content: string
}

export type WarmupRequest = {
  llmBackendUrl: string
  mergedGroups: WarmupGroup[]
  modelName: string
  /** The shared RAG prefix string — must match exactly what prepareRagContext uses. */
  ragSystemPrefix: string
}

export type PhisonKmIngestConfig = {
  embeddingServerUrl: string
}

/**
 * Separator used to join a merged group's chunks. Grouping-time token accounting
 * in electron/subprocesses/langchainPhisonKm.ts must charge this same string.
 */
export const GROUP_SEPARATOR = '\n\n'

/**
 * Derives a merged group's text on demand from the document's splitDB, using the
 * persisted chunk-index boundaries. Must stay a pure join with no other transform —
 * electron/subprocesses/langchainPhisonKm.ts's ingest-time buildMergedGroups relies
 * on the same chunks[start..end] slice producing identical text at query/warmup time.
 */
export function deriveGroupContent(splitDB: Document[], group: MergedGroup): string {
  return splitDB
    .slice(group.startChunkIdx, group.endChunkIdx + 1)
    .map((c) => c.pageContent)
    .join(GROUP_SEPARATOR)
}
