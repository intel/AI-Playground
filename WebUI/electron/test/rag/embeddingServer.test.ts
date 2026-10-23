import { describe, expect, it } from 'vitest'
import {
  dedicatedEmbeddingServerUrl,
  EMBEDDING_SERVICE_BY_BACKEND,
  embeddingServerUrl,
  hostsEmbeddingServer,
  readsDedicatedEmbeddingUrl,
  startEmbeddingServer,
} from '../../rag/embeddingServer'

describe('embeddingServer', () => {
  it('uses the dedicated URL when the service exposes one, including while it is down', () => {
    const service = {
      baseUrl: 'http://llm',
      getEmbeddingServerUrl: () => null as string | null,
      ensureEmbeddingServerReady: async () => {},
    }
    expect(hostsEmbeddingServer(service)).toBe(true)
    expect(readsDedicatedEmbeddingUrl(service)).toBe(true)
    expect(embeddingServerUrl(service)).toBeNull()
    expect(dedicatedEmbeddingServerUrl(service)).toBeNull()
  })

  it('falls back to baseUrl only when there is no dedicated getter', () => {
    const service = { baseUrl: 'http://llm' }
    expect(embeddingServerUrl(service)).toBe('http://llm')
    expect(dedicatedEmbeddingServerUrl(service)).toBeNull()
    expect(readsDedicatedEmbeddingUrl(service)).toBe(false)
    expect(hostsEmbeddingServer(service)).toBe(false)
  })

  it('starts the embedding server on a host', async () => {
    const calls: string[] = []
    const service = {
      ensureEmbeddingServerReady: async (model: string) => {
        calls.push(model)
      },
      getEmbeddingServerUrl: () => 'http://127.0.0.1:39200',
    }
    await startEmbeddingServer(service, 'bge')
    expect(calls).toEqual(['bge'])
    expect(dedicatedEmbeddingServerUrl(service)).toBe('http://127.0.0.1:39200')
    expect(EMBEDDING_SERVICE_BY_BACKEND.llamaCPP).toBe('llamacpp-backend')
    expect(EMBEDDING_SERVICE_BY_BACKEND.openVINO).toBe('openvino-backend')
  })
})
