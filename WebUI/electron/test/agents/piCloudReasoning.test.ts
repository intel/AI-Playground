import { describe, expect, it } from 'vitest'
import { cloudReasoningRegistration } from '../../agentMode/piCloudReasoning.ts'

// Whether a cloud agent turn asks its provider to split thinking off, and in
// whose dialect. Both used to be decided by Pi from the model's `baseUrl` —
// which is the loopback proxy for every provider — so a GLM's chain of thought
// arrived inline as `<think>` text instead of as reasoning.

const zai = 'https://api.z.ai/api/paas/v4'

describe('cloudReasoningRegistration', () => {
  it('asks a GLM served by an unknown gateway in z.ai dialect', () => {
    expect(
      cloudReasoningRegistration({
        model: 'zai-org/GLM-5.3-Flash',
        upstreamBaseUrl: 'https://gateway.example.com/v1',
      }),
    ).toEqual({
      reasoning: true,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: 'zai',
        supportsReasoningEffort: false,
      },
    })
  })

  // The gateway is not z.ai, so only the thinking parameter is borrowed: its
  // request shape (max_tokens, no `store`) is z.ai's own and stays there.
  it('leaves an unknown gateway to the OpenAI request shape', () => {
    const compat = cloudReasoningRegistration({
      model: 'glm-5.2',
      upstreamBaseUrl: 'https://gateway.example.com/v1',
    }).compat
    expect(compat).not.toHaveProperty('maxTokensField')
    expect(compat).not.toHaveProperty('supportsStore')
  })

  it('gives z.ai itself the whole z.ai dialect', () => {
    expect(cloudReasoningRegistration({ model: 'glm-5.2', upstreamBaseUrl: zai })).toEqual({
      reasoning: true,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: 'zai',
        supportsReasoningEffort: false,
        supportsStore: false,
        maxTokensField: 'max_tokens',
      },
    })
  })

  it('reads reasoning per upstream for the providers with their own dialect', () => {
    const dialect = (model: string, upstreamBaseUrl: string) =>
      cloudReasoningRegistration({ model, upstreamBaseUrl, reasoningAdvertised: true }).compat
        ?.thinkingFormat

    expect(dialect('anthropic/claude-opus-4-5', 'https://openrouter.ai/api/v1')).toBe('openrouter')
    expect(dialect('deepseek-reasoner', 'https://api.deepseek.com/v1')).toBe('deepseek')
    expect(dialect('Qwen/Qwen3-235B', 'https://api.together.xyz/v1')).toBe('together')
    expect(dialect('o4-mini', 'https://api.openai.com/v1')).toBe('openai')
  })

  // Pi infers this from a DeepSeek URL; behind the proxy it has to be stated or
  // replayed assistant messages are rejected.
  it('keeps DeepSeek reasoning_content on replayed assistant messages', () => {
    const compat = cloudReasoningRegistration({
      model: 'deepseek-reasoner',
      upstreamBaseUrl: 'https://api.deepseek.com/v1',
      reasoningAdvertised: true,
    }).compat
    expect(compat?.requiresReasoningContentOnAssistantMessages).toBe(true)
  })

  // A silent provider is assumed fully capable elsewhere, which is too loose a
  // signal to hang request parameters on: every model would ask for thinking and
  // providers reject parameters they do not model.
  it('asks nothing of a model whose provider never claimed reasoning', () => {
    for (const model of ['gpt-4o', 'default', 'mistral-small-latest']) {
      expect(
        cloudReasoningRegistration({ model, upstreamBaseUrl: 'https://api.example.com/v1' }),
      ).toEqual({ reasoning: false })
    }
  })

  it('recognizes the GLM family however it is spelled', () => {
    for (const model of [
      'glm-5.2',
      'GLM-4.6',
      'zai-org/GLM-5.3-Flash',
      'thudm/chatglm3-6b',
      'zhipu/glm-z1',
    ]) {
      expect(
        cloudReasoningRegistration({ model, upstreamBaseUrl: 'https://gateway.example.com/v1' })
          .reasoning,
      ).toBe(true)
    }
  })

  // "glm" inside an unrelated word is not a GLM.
  it('does not read a GLM into an unrelated model id', () => {
    expect(
      cloudReasoningRegistration({
        model: 'algminer-7b',
        upstreamBaseUrl: 'https://api.example.com/v1',
      }).reasoning,
    ).toBe(false)
  })

  // Pi sends the system prompt as a `developer` message once a model reasons,
  // and an arbitrary gateway has never had to accept that role from us.
  it('never promotes the system prompt to a developer message', () => {
    expect(
      cloudReasoningRegistration({ model: 'glm-5.2', upstreamBaseUrl: zai }).compat
        ?.supportsDeveloperRole,
    ).toBe(false)
  })
})
