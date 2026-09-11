import { describe, expect, it } from 'vitest'
import { parseModelCapabilities } from '@/assets/js/store/cloudMode'

// What a provider's /v1/models entry advertises decides which presets may use a
// model and how big the context gauge thinks its window is. Providers disagree
// on where they put that information, so these cases pin the shapes we accept.

describe('parseModelCapabilities', () => {
  it('reads an OpenRouter-style entry', () => {
    const caps = parseModelCapabilities({
      id: 'Qwen/Qwen3.6-35B-A3B-FP8',
      architecture: {
        modality: 'text+image->text',
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
      },
      top_provider: { is_moderated: false, context_length: 262144 },
      supported_parameters: ['temperature', 'reasoning_effort', 'tools', 'tool_choice'],
      context_length: 262144,
    })

    expect(caps).toEqual({
      supportsVision: true,
      supportsToolCalling: true,
      supportsReasoning: true,
      reasoningAdvertised: true,
      contextLength: 262144,
    })
  })

  it('falls back to top_provider.context_length, then max_model_len', () => {
    expect(
      parseModelCapabilities({ id: 'm', top_provider: { context_length: 131072 } }).contextLength,
    ).toBe(131072)
    expect(parseModelCapabilities({ id: 'm', max_model_len: 40960 }).contextLength).toBe(40960)
  })

  it('accepts a numeric string but rejects nonsense', () => {
    expect(parseModelCapabilities({ id: 'm', context_length: '131072' }).contextLength).toBe(131072)
    for (const context_length of [0, -1, 'unlimited', null, {}]) {
      expect(parseModelCapabilities({ id: 'm', context_length }).contextLength).toBeUndefined()
    }
  })

  // A bare `{ id }` (vanilla OpenAI) says nothing, so the model stays fully
  // capable — but an unknown window must not masquerade as a real one.
  it('leaves the window unknown when the provider is silent', () => {
    expect(parseModelCapabilities({ id: 'gpt-4o' })).toEqual({
      supportsVision: true,
      supportsToolCalling: true,
      supportsReasoning: true,
      reasoningAdvertised: false,
      contextLength: undefined,
    })
  })

  it('reports the window even when capabilities are unadvertised', () => {
    const caps = parseModelCapabilities({ id: 'local-model', max_model_len: 8192 })
    expect(caps.supportsToolCalling).toBe(true)
    expect(caps.contextLength).toBe(8192)
  })

  it('recognizes reasoning from an effort knob or a reasoning object', () => {
    expect(
      parseModelCapabilities({ id: 'm', supported_parameters: ['reasoning_effort'] })
        .supportsReasoning,
    ).toBe(true)
    expect(
      parseModelCapabilities({
        id: 'm',
        supported_parameters: ['temperature'],
        reasoning: { mandatory: true, default_enabled: true },
      }).supportsReasoning,
    ).toBe(true)
  })

  it('keeps a text-only, tool-less model narrow', () => {
    expect(
      parseModelCapabilities({
        id: 'deepseek-ai/DeepSeek-V4-Flash',
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['temperature', 'max_tokens'],
        context_length: 400000,
      }),
    ).toEqual({
      supportsVision: false,
      supportsToolCalling: false,
      supportsReasoning: false,
      reasoningAdvertised: false,
      contextLength: 400000,
    })
  })

  // Asking a model to think is a request parameter, so it takes the provider's
  // own word for it — while the preset gate errs towards offering the model.
  // The two only differ for a provider that advertises nothing at all.
  it('separates advertised reasoning from assumed capability', () => {
    expect(parseModelCapabilities({ id: 'gpt-4o' })).toMatchObject({
      supportsReasoning: true,
      reasoningAdvertised: false,
    })
    expect(
      parseModelCapabilities({ id: 'o4-mini', supported_parameters: ['reasoning_effort'] }),
    ).toMatchObject({ supportsReasoning: true, reasoningAdvertised: true })
    expect(
      parseModelCapabilities({ id: 'm', supported_parameters: ['temperature'] }),
    ).toMatchObject({ supportsReasoning: false, reasoningAdvertised: false })
  })
})
