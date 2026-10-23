import { appLoggerInstance } from '../observability/logger'
import { extractMessage } from '@/assets/js/errors/appError'
import type { EmbedInquiry, IndexedDocument } from '@/types/rag'
import { augmentSystemPrompt, formatRagSources, type RagSourceDocument } from '@/lib/ragSources'
import type { ChatRagRequest } from '@/types/chatIpc'

const appLogger = appLoggerInstance

export type PreparedRagContext = {
  systemPrompt: string
  sourceText: string | null
}

export type RagRetrievalDeps = {
  ensureEmbeddingServerReady: (serviceName: string, embeddingModel: string) => Promise<void>
  getEmbeddingServerUrl: (serviceName: string) => Promise<string | null>
  embed: (inquiry: EmbedInquiry) => Promise<RagSourceDocument[]>
  loadDocuments: () => Promise<unknown[] | null>
}

let deps: RagRetrievalDeps | null = null

export function setRagRetrievalDeps(next: RagRetrievalDeps): void {
  deps = next
}

export function resetRagRetrievalDepsForTest(): void {
  deps = null
}

function requireDeps(): RagRetrievalDeps {
  if (!deps) throw new Error('RAG retrieval deps not wired')
  return deps
}

function documentsByHash(documents: unknown[], hashes: string[]): IndexedDocument[] {
  const wanted = new Set(hashes)
  const matched: IndexedDocument[] = []
  for (const item of documents) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Partial<IndexedDocument>
    if (typeof rec.hash !== 'string' || !wanted.has(rec.hash)) continue
    matched.push(item as IndexedDocument)
  }
  return matched
}

/**
 * Retrieve RAG context in main after the turn's GPU admit / backend load.
 * Failures skip RAG (same as the old renderer prepareRagContext catch) so the
 * turn still answers from the base prompt.
 */
export async function retrieveRagForTurn(
  rag: ChatRagRequest,
  baseSystemPrompt: string,
  abortSignal?: AbortSignal,
): Promise<PreparedRagContext> {
  const skip = { systemPrompt: baseSystemPrompt, sourceText: null as string | null }
  if (abortSignal?.aborted) return skip
  try {
    const d = requireDeps()
    await d.ensureEmbeddingServerReady(rag.embeddingServiceName, rag.embeddingModel)
    if (abortSignal?.aborted) return skip

    const embeddingUrl = await d.getEmbeddingServerUrl(rag.embeddingServiceName)
    if (!embeddingUrl) {
      appLogger.warn(
        `Embedding server not ready for ${rag.embeddingServiceName}; skipping RAG`,
        'electron-backend',
      )
      return skip
    }

    const section = await d.loadDocuments()
    if (!section || section.length === 0) return skip
    const ragList = documentsByHash(section, rag.documentHashes)
    if (ragList.length === 0) {
      appLogger.warn('No RAG documents matched the turn hashes; skipping RAG', 'electron-backend')
      return skip
    }

    const results = await d.embed({
      prompt: rag.query,
      ragList,
      backendBaseUrl: embeddingUrl,
      embeddingModel: rag.embeddingModel,
      maxResults: rag.maxResults,
      useGroupRetrieval: rag.useGroupRetrieval,
      perDocResults: rag.perDocResults,
    })
    if (abortSignal?.aborted) return skip
    if (!results || results.length === 0) return skip

    const pageContents = results
      .map((doc) => doc.pageContent)
      .filter((text): text is string => typeof text === 'string' && text.length > 0)
    if (pageContents.length === 0) return skip

    return {
      systemPrompt: augmentSystemPrompt(baseSystemPrompt, pageContents, rag.useGroupRetrieval),
      sourceText: formatRagSources(results) || null,
    }
  } catch (error) {
    appLogger.warn(
      `RAG retrieval failed; continuing without it: ${extractMessage(error)}`,
      'electron-backend',
    )
    return skip
  }
}
