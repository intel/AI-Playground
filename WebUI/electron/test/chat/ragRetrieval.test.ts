import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRagRequest } from '@/types/chatIpc'
import { PHISON_KM_RAG_PREFIX } from '@/types/phisonKmRag'

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { retrieveRagForTurn, setRagRetrievalDeps, resetRagRetrievalDepsForTest } =
  await import('../../chat/ragRetrieval')

const rag: ChatRagRequest = {
  query: 'what is the warranty',
  documentHashes: ['hash-a'],
  useGroupRetrieval: false,
  embeddingServiceName: 'llamacpp-backend',
  embeddingModel: 'bge',
  maxResults: 8,
  perDocResults: 5,
}

const matchedDoc = {
  hash: 'hash-a',
  filename: 'warranty.pdf',
  filepath: '/docs/warranty.pdf',
  type: 'pdf',
  isChecked: true,
  splitDB: [],
}

function wire(overrides: Record<string, unknown> = {}) {
  const ensureEmbeddingServerReady = vi.fn(async () => {})
  const getEmbeddingServerUrl = vi.fn(async () => 'http://127.0.0.1:39200')
  const embed = vi.fn(async () => [
    {
      pageContent: 'two years parts',
      metadata: { source: '/docs/warranty.pdf', loc: { lines: { from: 3, to: 5 } } },
    },
  ])
  const loadDocuments = vi.fn(async () => [matchedDoc, { hash: 'other', splitDB: [] }])
  setRagRetrievalDeps({
    ensureEmbeddingServerReady,
    getEmbeddingServerUrl,
    embed,
    loadDocuments,
    ...overrides,
  })
  return { ensureEmbeddingServerReady, getEmbeddingServerUrl, embed, loadDocuments }
}

describe('retrieveRagForTurn', () => {
  beforeEach(() => {
    resetRagRetrievalDepsForTest()
  })

  afterEach(() => {
    resetRagRetrievalDepsForTest()
  })

  it('matches hashes, embeds, and formats sources', async () => {
    const d = wire()
    const prepared = await retrieveRagForTurn(rag, 'Be brief.')

    expect(d.ensureEmbeddingServerReady).toHaveBeenCalledWith('llamacpp-backend', 'bge')
    expect(d.embed).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'what is the warranty',
        backendBaseUrl: 'http://127.0.0.1:39200',
        embeddingModel: 'bge',
        ragList: [matchedDoc],
      }),
    )
    expect(prepared.sourceText).toBe('warranty.pdf (Lines 3-5)')
    expect(prepared.systemPrompt).toContain('two years parts')
    expect(prepared.systemPrompt.startsWith('Be brief.')).toBe(true)
  })

  it('uses the KM prefix when group retrieval is on', async () => {
    wire()
    const prepared = await retrieveRagForTurn({ ...rag, useGroupRetrieval: true }, 'Be brief.')
    expect(prepared.systemPrompt.startsWith(PHISON_KM_RAG_PREFIX)).toBe(true)
  })

  it('skips RAG when the embedding URL is missing', async () => {
    const d = wire({ getEmbeddingServerUrl: vi.fn(async () => null) })
    const prepared = await retrieveRagForTurn(rag, 'Be brief.')
    expect(d.embed).not.toHaveBeenCalled()
    expect(prepared).toEqual({ systemPrompt: 'Be brief.', sourceText: null })
  })

  it('skips RAG when no document hashes match', async () => {
    const d = wire({ loadDocuments: vi.fn(async () => [{ hash: 'nope' }]) })
    const prepared = await retrieveRagForTurn(rag, 'Be brief.')
    expect(d.embed).not.toHaveBeenCalled()
    expect(prepared.sourceText).toBeNull()
  })

  it('skips RAG when embed throws, so the turn still answers', async () => {
    wire({
      embed: vi.fn(async () => {
        throw new Error('langchain down')
      }),
    })
    await expect(retrieveRagForTurn(rag, 'Be brief.')).resolves.toEqual({
      systemPrompt: 'Be brief.',
      sourceText: null,
    })
  })

  it('skips RAG when the turn was already aborted', async () => {
    const d = wire()
    const prepared = await retrieveRagForTurn(rag, 'Be brief.', AbortSignal.abort())
    expect(d.ensureEmbeddingServerReady).not.toHaveBeenCalled()
    expect(prepared.sourceText).toBeNull()
  })
})
