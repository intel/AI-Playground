import { llmServerBaseUrl } from '../llmServerSnapshot.ts'
import type { AgentModeModelConfig } from '@/types/agentIpc'
import { openAiApiBase } from '@/lib/inferenceApiBase'

// ── Where the local backend is, per request ──────────────────────────────────
//
// A local LLM server's port is picked when it launches, and it launches again
// far more often than a session lives: every media generation frees the GPU for
// ComfyUI and takes it back afterwards, which restarts the server in the middle
// of an agent turn, on another port.
//
// pi-ai stamps the provider's base URL onto every model it builds and the
// request path reads it off the model object, so a session built with a URL kept
// calling the port it was born with. After one image generation that port was
// gone: the agent's remaining steps failed the instant they were made — no
// tokens, four retries two, four and eight seconds apart, then the turn was
// over. Nothing in the app said why, because nothing had gone wrong except the
// address. (The renderer's chat model never had the problem; it re-roots every
// request the same way this does.)

export type LocalModelConfig = Extract<AgentModeModelConfig, { source: 'local' }>

/**
 * The local backend's OpenAI-compatible endpoint as it stands at this moment,
 * falling back to the URL the renderer sent with the turn — which is all there
 * is for a config from before `backend` was recorded.
 */
export function localBaseUrl(config: LocalModelConfig): string {
  const live = config.backend ? llmServerBaseUrl(config.backend) : undefined
  return openAiApiBase(live ?? config.baseUrl)
}

/**
 * The same model, with its endpoint read fresh on every request. An accessor is
 * what makes a moved port reach a call already in flight; re-registering the
 * provider would only help the next session.
 */
export function withLiveEndpoint<T extends object>(model: T, config: LocalModelConfig): T {
  const live = { ...model }
  Object.defineProperty(live, 'baseUrl', {
    enumerable: true,
    configurable: true,
    get: () => localBaseUrl(config),
  })
  return live
}
