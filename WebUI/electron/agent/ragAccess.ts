import type { Document } from '@langchain/classic/document'
import type { EmbedInquiry, IndexedDocument } from '@/types/rag'

// ── Main-process RAG plumbing for the agent's `rag` tool ─────────────────────
//
// Splitting, embedding and retrieval all live outside the agentMode module
// graph: the langchain utility process is owned by main.ts and the embedding
// server by the backend services. Handing them over as registered thunks keeps
// that graph clean of Electron service imports (same pattern as
// setLlmServiceLookup / setToolBridgeWindow), so capability tests can install a
// fake instead of dragging in the registry or a live utility process.

export type RagAccess = {
  /** Split a document into chunks; the langchain worker fills in splitDB + hash. */
  ingest(document: IndexedDocument): Promise<IndexedDocument>
  /** Embed the prompt and return the best-matching chunks of the checked docs. */
  retrieve(inquiry: EmbedInquiry): Promise<Document[]>
  /**
   * Start the embedding sub-server of the given backend if needed and return
   * its base URL (no `/v1` suffix). Throws when the model or backend is not up.
   */
  ensureEmbeddingServer(backend: 'llamaCPP' | 'openVINO', model: string): Promise<string>
}

let access: RagAccess | null = null

/** Called once by main.ts during startup. */
export function setRagAccess(next: RagAccess): void {
  access = next
}

export function ragAccess(): RagAccess {
  if (!access) throw new Error('rag access is not registered (main did not call setRagAccess)')
  return access
}

/** Tests only: drop the installed access so cases cannot see each other's fakes. */
export function resetRagAccess(): void {
  access = null
}
