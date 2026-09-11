/**
 * Phison KM (Knowledge Manager) RAG — everything specific to the aiDAPTIV+ merged-
 * group retrieval + KV-cache-warmup feature lives here, isolated from the shared
 * langchain.ts RAG worker the same way llamaCppPhison.ts is isolated from the
 * general llama.cpp backend service. langchain.ts should only ever need to call
 * the handful of functions exported below; it must not reach in and depend on
 * anything internal (groupChunks, countTokens, buildMergedGroup, stableChunkKey).
 *
 * See aidaptiv-km-rag-review-scope.md §W1 for the encapsulation rationale, and
 * §W3-3 for why MergedGroup only stores chunk-index boundaries instead of the
 * group's text (deriveGroupContent, imported from the shared types module,
 * derives it on demand from splitDB instead).
 */
import { Document } from '@langchain/classic/document'
import { createHash } from 'crypto'

import type {
  IndexedDocument,
  MergedGroup,
  MergedGroupsMeta,
  WarmupRequest,
} from '@/assets/js/store/textInference.ts'
import { deriveGroupContent, GROUP_SEPARATOR } from '@/types/phisonKmRag'

/**
 * Maximum tokens per merged group — mirrors Phison KM service MAX_TOKENS_PER_GROUP.
 * Sized so that one group fits within the Phison-recommended 16 K context window
 * (group ~13 000 tokens + shared prefix + query + output ~16 384 tokens).
 */
const MAX_TOKENS_PER_GROUP = 13000

/**
 * HTTP timeouts for the embedding/LLM backend calls Phison KM makes outside the
 * normal embedding path. Without these, a hung backend stalls document ingestion
 * (/tokenize, called once per chunk) or the warmup IPC round-trip (/v1/chat/completions,
 * called once per merged group) indefinitely. Overridable via env for environments
 * where the backend is known to be slower than these defaults assume.
 */
const TOKENIZE_TIMEOUT_MS = Number(process.env.AIPG_PHISON_TOKENIZE_TIMEOUT_MS) || 5_000
const WARMUP_TIMEOUT_MS = Number(process.env.AIPG_PHISON_WARMUP_TIMEOUT_MS) || 60_000

/**
 * Abort the rest of a warmup batch once this many groups in a row have failed
 * (timed out, network error, or non-OK response) — a backend that's down or wedged
 * will fail every remaining group the same way, so continuing to wait out the full
 * per-group timeout for each one only delays finishing the (best-effort) batch
 * without producing any more useful warmup work.
 */
export const WARMUP_MAX_CONSECUTIVE_FAILURES = 3

/** The splitter config used to produce the chunks a set of groups was built from. */
export type SplitterParams = {
  chunkSize: number
  chunkOverlap: number
}

// ---------------------------------------------------------------------------
// Ingestion-time grouping
// ---------------------------------------------------------------------------

/**
 * Groups consecutive chunks into merged groups, each capped at MAX_TOKENS_PER_GROUP
 * tokens, plus the fingerprint (mergedGroupsMeta) that later calls use to tell
 * whether those groups are still valid for a given splitDB (see groupsAreValid).
 * Token counts are obtained via the embedding server /tokenize endpoint for
 * accuracy. Groups have zero overlap (matching KM behaviour).
 */
export async function buildMergedGroups(
  chunks: Document[],
  embeddingServerUrl: string,
  splitterParams: SplitterParams,
  docHash: string,
): Promise<{ groups: MergedGroup[]; meta: MergedGroupsMeta }> {
  const groups = await groupChunks(chunks, embeddingServerUrl, docHash)
  const meta: MergedGroupsMeta = {
    chunkSize: splitterParams.chunkSize,
    chunkOverlap: splitterParams.chunkOverlap,
    maxTokensPerGroup: MAX_TOKENS_PER_GROUP,
    chunkCount: chunks.length,
  }
  return { groups, meta }
}

async function groupChunks(
  chunks: Document[],
  embeddingServerUrl: string,
  docHash: string,
): Promise<MergedGroup[]> {
  const tokenizeUrl = `${embeddingServerUrl}/tokenize`
  // Charged once per chunk boundary within a group, because deriveGroupContent joins
  // with GROUP_SEPARATOR — without this the group's real token count overshoots
  // MAX_TOKENS_PER_GROUP by roughly (chunkCount - 1) separators' worth.
  const separatorTokens = await countTokens(GROUP_SEPARATOR, tokenizeUrl)

  const groups: MergedGroup[] = []
  let groupStartIdx = 0
  let groupChunkCount = 0
  let groupTokens = 0

  for (let i = 0; i < chunks.length; i++) {
    const chunkTokens = await countTokens(chunks[i].pageContent, tokenizeUrl)
    // Only chunks that follow another chunk in the same group pay the separator.
    const costInCurrentGroup = groupChunkCount > 0 ? chunkTokens + separatorTokens : chunkTokens

    if (groupChunkCount > 0 && groupTokens + costInCurrentGroup > MAX_TOKENS_PER_GROUP) {
      groups.push(buildMergedGroup(docHash, groupStartIdx, i - 1))
      groupStartIdx = i
      groupChunkCount = 1
      groupTokens = chunkTokens
    } else {
      groupChunkCount++
      groupTokens += costInCurrentGroup
    }
  }

  if (groupChunkCount > 0) {
    groups.push(buildMergedGroup(docHash, groupStartIdx, chunks.length - 1))
  }

  return groups
}

async function countTokens(text: string, tokenizeUrl: string): Promise<number> {
  try {
    const response = await fetch(tokenizeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
      // A hung embedding server would otherwise block ingestion (and the utility-
      // process IPC round-trip) indefinitely, one chunk at a time. The existing
      // catch below already falls back to a length-based estimate, so a timeout
      // here just turns "hang forever" into "degrade to the estimate quickly".
      signal: AbortSignal.timeout(TOKENIZE_TIMEOUT_MS),
    })
    if (!response.ok) return Math.ceil(text.length / 4)
    const data = (await response.json()) as { tokens: number[] }
    return data.tokens.length
  } catch {
    return Math.ceil(text.length / 4)
  }
}

// Boundary-only group: no `content` field. The group's text is always derived on
// demand via deriveGroupContent(splitDB, group) — see MergedGroup in
// @/types/phisonKmRag. Keeping content out of this object is what makes
// mergedGroups small enough (~50 bytes/group) to persist directly.
//
// groupId is keyed on the document's CONTENT hash, not its source path: the content
// hash is already how IndexedDocument identity works (ragList dedupes on it), whereas
// a path changes when the same file is added from a different folder — which would
// mint different groupIds for content that is deliberately treated as the same
// document. sha256 rather than md5 both for collision margin and because md5 is
// unavailable in FIPS-mode / hardened Node builds. Truncated to 32 hex chars: still
// 128 bits, and this value is persisted once per group.
function buildMergedGroup(docHash: string, startIdx: number, endIdx: number): MergedGroup {
  const groupId = createHash('sha256')
    .update(`${docHash}|${startIdx}|${endIdx}`)
    .digest('hex')
    .slice(0, 32)
  return {
    groupId,
    startChunkIdx: startIdx,
    endChunkIdx: endIdx,
  }
}

/** (Re)stamps groupId onto each chunk's metadata for the given groups. */
export function stampGroupIds(splitDB: Document[], groups: MergedGroup[]): void {
  for (const group of groups) {
    for (let i = group.startChunkIdx; i <= group.endChunkIdx && i < splitDB.length; i++) {
      splitDB[i].metadata.groupId = group.groupId
    }
  }
}

/**
 * True when doc.mergedGroups / mergedGroupsMeta are present AND still consistent
 * with doc.splitDB — i.e. safe to index into without rebuilding. chunkCount vs
 * splitDB.length is the cheapest direct signal that the persisted chunk-index
 * boundaries no longer line up with the current splitDB (e.g. chunkSize changed
 * between app versions, or splitDB was regenerated some other way). Without this
 * check, a mismatch would silently mis-slice into the wrong chunk range instead
 * of failing loudly.
 */
export function groupsAreValid(doc: IndexedDocument, splitterParams: SplitterParams): boolean {
  if (!doc.mergedGroups || doc.mergedGroups.length === 0) return false
  const meta = doc.mergedGroupsMeta
  if (!meta) return false
  return (
    meta.chunkCount === doc.splitDB.length &&
    meta.chunkSize === splitterParams.chunkSize &&
    meta.chunkOverlap === splitterParams.chunkOverlap &&
    meta.maxTokensPerGroup === MAX_TOKENS_PER_GROUP
  )
}

// ---------------------------------------------------------------------------
// Query-time retrieval
// ---------------------------------------------------------------------------

/**
 * Ensures each document in the rag list has merged groups, (re)building them only
 * when missing or stale (see groupsAreValid) rather than on every query. Since
 * mergedGroups is now persisted (boundary-only, no content), a document loaded
 * from storage already carries valid groups on every call after the first, so no
 * /tokenize round-trips happen here at all in the common case. Also (re)stamps
 * groupId onto every chunk's metadata, which is cheap enough to always redo.
 */
export async function ensureMergedGroups(
  ragList: IndexedDocument[],
  embeddingServerUrl: string,
  splitterParams: SplitterParams,
): Promise<void> {
  for (const doc of ragList) {
    if (!doc.splitDB || doc.splitDB.length === 0) continue

    if (!groupsAreValid(doc, splitterParams)) {
      console.log(
        `[ensureMergedGroups] (re)building groups for ${doc.filename} ` +
          `(${doc.splitDB.length} chunk(s)) — missing or stale`,
      )
      const built = await buildMergedGroups(
        doc.splitDB,
        embeddingServerUrl,
        splitterParams,
        doc.hash,
      )
      doc.mergedGroups = built.groups
      doc.mergedGroupsMeta = built.meta
      console.log(
        `[ensureMergedGroups] created ${doc.mergedGroups.length} group(s) for ${doc.filename}`,
      )
    }

    // Always (re)stamp groupId onto chunk metadata — persisted chunks may have lost it.
    stampGroupIds(doc.splitDB, doc.mergedGroups ?? [])
  }
}

/**
 * Phison KM retrieval: find the best-scoring chunk, look up its merged group,
 * and return the full group content (derived on demand from splitDB) as a
 * single Document.
 * Falls back to individual chunks (stable-sorted) when no group info is available.
 */
export function selectGroupContext(
  filtered: [Document, number][],
  ragList: IndexedDocument[],
): Document[] {
  if (filtered.length === 0) return []

  // Walk results from highest to lowest score; use the first one that has a groupId
  for (const [topChunk] of filtered) {
    const groupId = topChunk.metadata?.groupId as string | undefined
    if (!groupId) continue

    for (const ragDoc of ragList) {
      if (!ragDoc.mergedGroups) continue
      const group = ragDoc.mergedGroups.find((g) => g.groupId === groupId)
      if (group) {
        console.log(
          `Phison KM: serving merged group ${group.groupId} ` +
            `(chunks ${group.startChunkIdx}-${group.endChunkIdx})`,
        )
        // Do not forward the best-scoring chunk's `loc`: a merged group spans many
        // chunks, so citing one page/line range would be misleading. formatRagSources
        // still shows the filename from `source` even without location metadata.
        return [
          new Document({
            pageContent: deriveGroupContent(ragDoc.splitDB, group),
            metadata: {
              source: topChunk.metadata?.source ?? 'unknown',
              groupId: group.groupId,
              startChunkIdx: group.startChunkIdx,
              endChunkIdx: group.endChunkIdx,
            },
          }),
        ]
      }
    }
  }

  // Fallback: mergedGroups absent — stable-sorted chunks
  console.warn(
    'Phison KM: no merged group found for retrieved chunks — falling back to stable-sorted chunks',
  )
  return filtered
    .map(([doc]) => doc)
    .sort((a, b) => stableChunkKey(a).localeCompare(stableChunkKey(b)))
}

/**
 * Build a deterministic ordering key for a retrieved RAG chunk.
 * Uses file source + page (PDF) + line range.
 */
function stableChunkKey(doc: Document): string {
  const source = String(doc.metadata?.source ?? '')
  const loc = (doc.metadata?.loc ?? {}) as {
    pageNumber?: number
    lines?: { from?: number; to?: number }
  }
  const page = loc.pageNumber ?? 0
  const from = loc.lines?.from ?? 0
  const to = loc.lines?.to ?? 0
  return `${source}|${String(page).padStart(8, '0')}|${String(from).padStart(8, '0')}|${String(to).padStart(8, '0')}`
}

// ---------------------------------------------------------------------------
// KV cache pre-warming (Approach A)
// ---------------------------------------------------------------------------

/**
 * Pre-warm the LLM's KV cache for each merged group.
 *
 * Approach A: the warmup system message is built as:
 *   {request.ragSystemPrefix}\n\nDocument context:\n\n{group.content}
 *
 * This is the SAME prefix that prepareRagContext in textInference.ts uses for the
 * actual query (PHISON_KM_RAG_PREFIX + "Document context:" + ragContext). Because
 * the prefix is identical, the LLM's KV states for these tokens can be reused on
 * the real request, dramatically reducing TTFT.
 *
 * The preset's systemPrompt is appended AFTER in the real query (not in warmup),
 * so it falls outside the cached prefix — but it is short and cheap to prefill.
 *
 * Failures are logged but never propagated — warmup is best-effort.
 */
export async function warmupKVCache(request: WarmupRequest): Promise<void> {
  console.log(
    `Phison KM: warming KV cache for ${request.mergedGroups.length} group(s) ` +
      `via ${request.llmBackendUrl}`,
  )
  let consecutiveFailures = 0
  for (const group of request.mergedGroups) {
    try {
      const systemContent = `${request.ragSystemPrefix}\n\nDocument context:\n\n${group.content}`
      const resp = await fetch(`${request.llmBackendUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.modelName || 'local-model',
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: '.' },
          ],
          max_tokens: 1,
          stream: false,
        }),
        // Prefilling a ~13k-token group is legitimately slow, hence the long timeout —
        // but a hung LLM backend must not stall this best-effort, fire-and-forget IPC
        // call forever.
        signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS),
      })
      if (!resp.ok) {
        console.warn(`Phison KM: warmup HTTP ${resp.status} for group ${group.groupId}`)
        consecutiveFailures++
      } else {
        console.log(`Phison KM: warmed group ${group.groupId}`)
        consecutiveFailures = 0
      }
    } catch (err) {
      console.warn(`Phison KM: warmup failed for group ${group.groupId}:`, err)
      consecutiveFailures++
    }

    // A backend that's down or wedged will keep failing the same way for every
    // remaining group — stop paying the full timeout per group once that's clear,
    // rather than blocking ingestion's completion on N more doomed round-trips.
    if (consecutiveFailures >= WARMUP_MAX_CONSECUTIVE_FAILURES) {
      console.warn(
        `Phison KM: aborting warmup batch after ${consecutiveFailures} consecutive ` +
          `failures (${request.mergedGroups.length - request.mergedGroups.indexOf(group) - 1} group(s) skipped)`,
      )
      break
    }
  }
}
