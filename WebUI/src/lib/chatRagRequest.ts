import { backendToService, useTextInference } from '@/assets/js/store/textInference'
import type { ChatRagRequest } from '@/types/chatIpc'

/** Document ids + query for a turn; the kernel retrieves after GPU admit. */
export function buildChatRagRequest(query: string): ChatRagRequest | undefined {
  const textInference = useTextInference()
  if (!textInference.willUseRag) return undefined
  const documentHashes = textInference.ragList.filter((doc) => doc.isChecked).map((doc) => doc.hash)
  const embeddingModel = textInference.activeEmbeddingModel
  const embeddingServiceName = backendToService[textInference.embeddingBackend]
  if (documentHashes.length === 0 || !embeddingModel || !embeddingServiceName) return undefined
  const npu = textInference.runningOnOpenvinoNpu
  return {
    query,
    documentHashes,
    useGroupRetrieval: textInference.isPhisonKmRag,
    embeddingServiceName,
    embeddingModel,
    maxResults: npu ? 2 : 8,
    perDocResults: npu ? 1 : 5,
  }
}
