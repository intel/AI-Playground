export const EMBEDDING_SERVICE_BY_BACKEND = {
  llamaCPP: 'llamacpp-backend',
  openVINO: 'openvino-backend',
} as const

export type EmbeddingBackendName = keyof typeof EMBEDDING_SERVICE_BY_BACKEND

export type EmbeddingHost = {
  baseUrl?: string | null
  ensureEmbeddingServerReady?: (modelName: string) => Promise<void>
  getEmbeddingServerUrl?: () => string | null
}

export function hostsEmbeddingServer(service: unknown): service is EmbeddingHost & {
  ensureEmbeddingServerReady: (modelName: string) => Promise<void>
} {
  if (!service || typeof service !== 'object') return false
  return typeof (service as EmbeddingHost).ensureEmbeddingServerReady === 'function'
}

export function readsDedicatedEmbeddingUrl(
  service: unknown,
): service is EmbeddingHost & { getEmbeddingServerUrl: () => string | null } {
  if (!service || typeof service !== 'object') return false
  return typeof (service as EmbeddingHost).getEmbeddingServerUrl === 'function'
}

export async function startEmbeddingServer(service: EmbeddingHost, model: string): Promise<void> {
  if (typeof service.ensureEmbeddingServerReady !== 'function') {
    throw new Error('does not support a standalone embedding server')
  }
  await service.ensureEmbeddingServerReady(model)
}

/** Dedicated URL when the service exposes one (null while it is down); otherwise its own base URL. */
export function embeddingServerUrl(service: unknown): string | null {
  if (!service || typeof service !== 'object') return null
  const host = service as EmbeddingHost
  if (typeof host.getEmbeddingServerUrl === 'function') return host.getEmbeddingServerUrl() ?? null
  return host.baseUrl ?? null
}

/** URL from getEmbeddingServerUrl only. The agent's rag tool must not fall back to the LLM port. */
export function dedicatedEmbeddingServerUrl(service: EmbeddingHost): string | null {
  if (typeof service.getEmbeddingServerUrl !== 'function') return null
  return service.getEmbeddingServerUrl() ?? null
}
