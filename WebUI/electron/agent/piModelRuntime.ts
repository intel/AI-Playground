import path from 'node:path'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { loadPi } from './piRuntime.ts'
import { piAgentDir } from './piSessionStore.ts'
import { localBaseUrl } from './piLocalEndpoint.ts'
import { observeAgentModelCalls, trackAgentModelCalls } from './piCallTiming.ts'
import { cloudReasoningRegistration } from './piCloudReasoning.ts'
import { laminarConfig } from '../observability/laminar.ts'
import { type InferenceTraceContext } from '../observability/laminarAttributes.ts'
import type { AgentModeModelConfig } from '@/types/agentIpc'
import { outputTokenBudget } from './piCompaction.ts'
import { cloudProviderKey } from '../adapters/cloudUpstream.ts'
import { openAiApiBase } from '@/lib/inferenceApiBase'

export const LOCAL_PROVIDER = 'aipg-local'
export const CLOUD_PROVIDER = 'aipg-cloud'
export const CLOUD_DEFAULT_CONTEXT_WINDOW = 128000

export function modelContextWindow(config: AgentModeModelConfig): number {
  return config.contextWindow ?? (config.source === 'cloud' ? CLOUD_DEFAULT_CONTEXT_WINDOW : 8192)
}

let modelRuntime: ModelRuntime | null = null

/**
 * The model runtime every session shares. No `models.json` behind it (`modelsPath:
 * null`): every model the app offers is registered at runtime, and models are
 * always looked up by our own provider id, so Pi's builtin catalog can never
 * capture a request (a cloud model id like 'gpt-4o' would otherwise resolve to
 * Pi's own `openai` provider and fail on missing credentials). Credentials stay
 * in memory — `setRuntimeApiKey` is an in-memory overlay and the auth file we
 * point at is only ever read, since agent mode never logs a provider in.
 */
export async function ensureModelRuntime(): Promise<ModelRuntime> {
  if (modelRuntime) return modelRuntime
  const pi = await loadPi()
  modelRuntime = await pi.ModelRuntime.create({
    authPath: path.join(piAgentDir(), 'auth.json'),
    modelsPath: null,
  })
  return modelRuntime
}

function modelInput(config: AgentModeModelConfig): ('text' | 'image')[] {
  return config.supportsVision ? ['text', 'image'] : ['text']
}

export async function registerModel(
  config: AgentModeModelConfig,
): Promise<{ provider: string; modelId: string }> {
  const runtime = await ensureModelRuntime()
  if (config.source === 'local') {
    const contextWindow = modelContextWindow(config)
    runtime.registerProvider(LOCAL_PROVIDER, {
      name: 'AI Playground local backend',
      baseUrl: localBaseUrl(config),
      api: 'openai-completions',
      apiKey: 'unused',
      models: [
        {
          id: config.model,
          name: config.model,
          reasoning: false,
          input: modelInput(config),
          contextWindow,
          maxTokens: outputTokenBudget(contextWindow, 'local'),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        },
      ],
    })
    await runtime.setRuntimeApiKey(LOCAL_PROVIDER, 'unused')
    observeModelCallsWhenTracing(() => localBaseUrl(config))
    trackAgentModelCalls(() => localBaseUrl(config))
    return { provider: LOCAL_PROVIDER, modelId: config.model }
  }

  const contextWindow = modelContextWindow(config)
  const apiBase = openAiApiBase(config.upstreamBaseUrl)
  const key = cloudProviderKey(config.providerId)
  const authStyle = config.authStyle.trim() || 'bearer'
  const apiKey = authStyle === 'bearer' && key ? key : 'unused'
  const headers: Record<string, string> = {}
  if (key && authStyle === 'x-api-key') headers['x-api-key'] = key
  if (key && authStyle === 'api-key') headers['api-key'] = key
  runtime.registerProvider(CLOUD_PROVIDER, {
    name: 'AI Playground cloud',
    baseUrl: apiBase,
    api: 'openai-completions',
    apiKey,
    authHeader: apiKey !== 'unused',
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    models: [
      {
        id: config.model,
        name: config.model,
        input: modelInput(config),
        contextWindow,
        maxTokens: outputTokenBudget(contextWindow, 'cloud'),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // Thinking dialect, from the provider base. Pi's detectCompat only
        // recognizes a few hosts, and a resold GLM is not one of them.
        ...cloudReasoningRegistration({
          model: config.model,
          upstreamBaseUrl: config.upstreamBaseUrl,
          reasoningAdvertised: config.reasoningAdvertised,
        }),
      },
    ],
  })
  await runtime.setRuntimeApiKey(CLOUD_PROVIDER, apiKey)
  observeModelCallsWhenTracing(() => apiBase)
  return { provider: CLOUD_PROVIDER, modelId: config.model }
}

function observeModelCallsWhenTracing(endpoint: () => string): void {
  if (laminarConfig()) observeAgentModelCalls(endpoint)
}

export function traceContext(
  config: AgentModeModelConfig,
  getSampling: () => Record<string, unknown> | undefined,
): () => InferenceTraceContext {
  const contextWindow = modelContextWindow(config)
  return () => {
    const sampling = getSampling() ?? {}
    const kwargs = (sampling.chat_template_kwargs ?? {}) as Record<string, unknown>
    return {
      backend: config.source === 'cloud' ? 'cloud' : config.backend,
      ...(config.source === 'local' && config.device ? { device: config.device } : {}),
      ...(config.source === 'local' && config.deviceName ? { deviceName: config.deviceName } : {}),
      ...(config.source === 'cloud' ? { cloudProvider: config.providerId } : {}),
      ...(typeof kwargs.enable_thinking === 'boolean' ? { thinking: kwargs.enable_thinking } : {}),
      ...(typeof kwargs.reasoning_effort === 'string'
        ? { reasoningEffort: kwargs.reasoning_effort }
        : {}),
      sampling: {
        ...(typeof sampling.temperature === 'number' ? { temperature: sampling.temperature } : {}),
        ...(typeof sampling.top_p === 'number' ? { topP: sampling.top_p } : {}),
        maxTokens: outputTokenBudget(contextWindow, config.source),
      },
    }
  }
}

/**
 * A private copy of the turn's sampling, deep enough that switching thinking off
 * cannot reach back into the caller's config object. A traced llama.cpp turn also
 * asks the server to report its own timings, the way chat always does.
 */
export function copySamplingParams(
  params: Record<string, unknown> | undefined,
  backend: 'llamaCPP' | 'openVINO' | undefined,
): Record<string, unknown> | undefined {
  const timings = backend === 'llamaCPP' && laminarConfig() ? { timings_per_token: true } : {}
  if (!params) return Object.keys(timings).length > 0 ? timings : undefined
  const kwargs = params.chat_template_kwargs
  return {
    ...params,
    ...timings,
    ...(kwargs && typeof kwargs === 'object'
      ? { chat_template_kwargs: { ...(kwargs as Record<string, unknown>) } }
      : {}),
  }
}
