import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'

// ── Reasoning on a cloud agent turn ──────────────────────────────────────────
//
// Pi asks a provider to split its chain of thought off into `reasoning_content`,
// and its own stream reader is the only thing that turns that field into
// `thinking_*` events. A model registered with `reasoning: false` is never asked,
// so a gateway that would have split the trace instead leaves it inline as
// `<think>…</think>` in the text — which is what Agent Mode used to show, while
// the same model read correctly in Chat (the AI SDK extracts the tags there).
//
// Two things stood between us and the CLI's behaviour. We registered every cloud
// model as `reasoning: false`, and Pi picks the request dialect from the model's
// `baseUrl` — ours is always the loopback proxy, so `detectCompat` saw neither
// z.ai nor OpenRouter and settled on plain `reasoning_effort`. Both are decided
// here instead, from the upstream the proxy forwards to.
//
// Only a model believed to reason gets any of this: the cloud catalog assumes a
// silent provider is fully capable (`ASSUME_ALL_CAPABILITIES`), so keying off
// `supportsReasoning` would have every model asking for thinking, and providers
// reject parameters they do not model.

/**
 * The `openai-completions` compat fields that decide how thinking is requested.
 * Pi types `compat` as a union across every API it speaks and every member is
 * all-optional, so reading a field off it neither narrows nor catches a typo;
 * the cloud provider is always registered as `openai-completions`, so the fields
 * of that dialect are spelled out here instead. Names to check against pi-ai's
 * `OpenAICompletionsCompat` when Pi is upgraded.
 */
type CloudReasoningCompat = {
  thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'together' | 'zai'
  supportsReasoningEffort?: boolean
  supportsDeveloperRole?: boolean
  supportsStore?: boolean
  maxTokensField?: 'max_tokens'
  requiresReasoningContentOnAssistantMessages?: boolean
}

/** What a cloud model contributes to its Pi registration on the reasoning front. */
export type CloudReasoningRegistration = Pick<ProviderModelConfig, 'reasoning'> & {
  compat?: CloudReasoningCompat
}

export type CloudReasoningInput = {
  /** Model id as the provider serves it. */
  model: string
  /** The provider's own base URL — never the loopback proxy standing in for it. */
  upstreamBaseUrl: string
  /** Whether the provider's `/v1/models` entry actually declared reasoning. */
  reasoningAdvertised?: boolean
}

// GLM publishes its thinking through z.ai's `thinking` parameter whoever serves
// it, and a gateway reselling it rarely advertises reasoning at all — so the id
// is the only signal there is.
const GLM_MODEL = /(?:^|[/:._-])(?:glm|chatglm)[-_.\d]|zai-org\/|zhipu/i

function upstreamMatches(upstreamBaseUrl: string, ...needles: string[]): boolean {
  const url = upstreamBaseUrl.toLowerCase()
  return needles.some((needle) => url.includes(needle))
}

function isReasoningModel(input: CloudReasoningInput): boolean {
  return input.reasoningAdvertised === true || GLM_MODEL.test(input.model)
}

/**
 * The dialect the upstream expects, mirroring what Pi's own `detectCompat` would
 * have concluded from the provider's URL. The companion fields travel with each
 * dialect on purpose: half of one (z.ai's `thinking` without its `max_tokens`)
 * is how a thinking fix turns into a rejected request.
 */
function reasoningCompat(input: CloudReasoningInput): CloudReasoningCompat {
  if (upstreamMatches(input.upstreamBaseUrl, 'api.z.ai', 'open.bigmodel.cn')) {
    return {
      thinkingFormat: 'zai',
      supportsReasoningEffort: false,
      supportsStore: false,
      maxTokensField: 'max_tokens',
    }
  }
  if (upstreamMatches(input.upstreamBaseUrl, 'openrouter.ai')) {
    return { thinkingFormat: 'openrouter' }
  }
  if (upstreamMatches(input.upstreamBaseUrl, 'deepseek.com')) {
    return {
      thinkingFormat: 'deepseek',
      supportsStore: false,
      // Pi infers this from a DeepSeek URL; behind the proxy it has to be stated,
      // or replayed assistant messages come back rejected.
      requiresReasoningContentOnAssistantMessages: true,
    }
  }
  if (upstreamMatches(input.upstreamBaseUrl, 'api.together.ai', 'api.together.xyz')) {
    return {
      thinkingFormat: 'together',
      supportsReasoningEffort: false,
      supportsStore: false,
      maxTokensField: 'max_tokens',
    }
  }
  // A GLM served by someone else's gateway: ask in z.ai's dialect, since that is
  // the parameter the model's own server reads, but leave the request shape alone
  // — the gateway is not z.ai.
  if (GLM_MODEL.test(input.model)) {
    return { thinkingFormat: 'zai', supportsReasoningEffort: false }
  }
  return { thinkingFormat: 'openai' }
}

/**
 * How to register a cloud model with Pi so its thinking arrives as thinking.
 *
 * `supportsDeveloperRole: false` rides along with every reasoning registration:
 * Pi sends the system prompt as a `developer` message once a model reasons, and
 * an arbitrary OpenAI-compatible gateway has never had to accept that role from
 * us before.
 */
export function cloudReasoningRegistration(input: CloudReasoningInput): CloudReasoningRegistration {
  if (!isReasoningModel(input)) return { reasoning: false }
  return { reasoning: true, compat: { supportsDeveloperRole: false, ...reasoningCompat(input) } }
}
