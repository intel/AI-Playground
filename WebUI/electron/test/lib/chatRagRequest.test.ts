import { beforeEach, describe, expect, it, vi } from 'vitest'

const { store } = vi.hoisted(() => ({
  store: {
    willUseRag: true,
    ragList: [
      { isChecked: true, hash: 'doc-a' },
      { isChecked: false, hash: 'doc-b' },
    ],
    activeEmbeddingModel: 'bge',
    embeddingBackend: 'llamaCPP' as 'llamaCPP' | 'openVINO',
    isPhisonKmRag: false,
    runningOnOpenvinoNpu: false,
  },
}))

vi.mock('@/assets/js/store/textInference', () => ({
  backendToService: {
    llamaCPP: 'llamacpp-backend',
    openVINO: 'openvino-backend',
    cloud: null,
  },
  useTextInference: () => store,
}))

const { buildChatRagRequest } = await import('@/lib/chatRagRequest')

describe('buildChatRagRequest', () => {
  beforeEach(() => {
    store.willUseRag = true
    store.ragList = [
      { isChecked: true, hash: 'doc-a' },
      { isChecked: false, hash: 'doc-b' },
    ]
    store.activeEmbeddingModel = 'bge'
    store.embeddingBackend = 'llamaCPP'
    store.isPhisonKmRag = false
    store.runningOnOpenvinoNpu = false
  })

  it('ships checked hashes and embedding facts for a RAG turn', () => {
    store.willUseRag = true
    store.isPhisonKmRag = false
    store.runningOnOpenvinoNpu = false
    store.embeddingBackend = 'llamaCPP'
    expect(buildChatRagRequest('what is this')).toEqual({
      query: 'what is this',
      documentHashes: ['doc-a'],
      useGroupRetrieval: false,
      embeddingServiceName: 'llamacpp-backend',
      embeddingModel: 'bge',
      maxResults: 8,
      perDocResults: 5,
    })
  })

  it('uses the NPU retrieval counts and KM flag', () => {
    store.runningOnOpenvinoNpu = true
    store.isPhisonKmRag = true
    store.embeddingBackend = 'openVINO'
    expect(buildChatRagRequest('q')).toMatchObject({
      useGroupRetrieval: true,
      embeddingServiceName: 'openvino-backend',
      maxResults: 2,
      perDocResults: 1,
    })
  })

  it('is absent when the preset will not use RAG', () => {
    store.willUseRag = false
    expect(buildChatRagRequest('q')).toBeUndefined()
  })
})
