import type { RagDocumentsInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import { ipcFail } from '../typedIpc'
import type {
  migrateRagDocumentSection,
  readRagDocumentSection,
  writeRagDocumentSection,
} from '../../persist/ragDocumentFiles'

/** The kernel-owned rag/documents.json seams the three ragDocuments handlers close over. */
export type RagDocumentsDeps = {
  readRagDocumentSection: typeof readRagDocumentSection
  migrateRagDocumentSection: typeof migrateRagDocumentSection
  writeRagDocumentSection: typeof writeRagDocumentSection
}

export function buildRagDocumentsRegistry(deps: RagDocumentsDeps) {
  // RAG documents (step 8, §6.1): the textInference store's indexed document
  // set, one kernel-owned file — same section-shaped contract as the
  // preferences channels, over rag/documents.json. read keeps "absent"
  // (section null) apart from "failed" (success false): only the former may
  // trigger the one-shot legacy upload.
  return {
    'ragDocuments:read': async () => {
      try {
        return { success: true as const, section: await deps.readRagDocumentSection() }
      } catch (e) {
        return ipcFail(e)
      }
    },

    'ragDocuments:migrate': async (_event, payload) => {
      try {
        await deps.migrateRagDocumentSection(payload)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },

    'ragDocuments:write': async (_event, value) => {
      try {
        await deps.writeRagDocumentSection(value)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
  } satisfies InvokeHandlerMap<RagDocumentsInvokeName>
}
