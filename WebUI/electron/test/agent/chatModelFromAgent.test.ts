import { describe, expect, it } from 'vitest'
import { chatModelFromAgentConfig } from '../../agent/chatModelFromAgent'

describe('chatModelFromAgentConfig', () => {
  it('maps a local agent model onto ChatModelConfig', () => {
    expect(
      chatModelFromAgentConfig({
        source: 'local',
        model: 'qwen---9b',
        backend: 'llamaCPP',
        baseUrl: 'http://127.0.0.1:39101/v1',
        supportsVision: true,
        samplingParams: { temperature: 0.7 },
      }),
    ).toEqual({
      backend: 'llamaCPP',
      modelId: 'qwen---9b',
      baseUrl: 'http://127.0.0.1:39101/v1',
      samplingRequestBody: { temperature: 0.7 },
      supportsVision: true,
    })
  })

  it('maps a cloud agent model onto the provider ChatModelConfig', () => {
    expect(
      chatModelFromAgentConfig({
        source: 'cloud',
        model: 'gpt-4o',
        upstreamBaseUrl: 'https://api.example.com/v1',
        providerId: 'openai',
        authStyle: 'bearer',
        supportsVision: true,
      }),
    ).toEqual({
      backend: 'cloud',
      modelId: 'gpt-4o',
      baseUrl: 'https://api.example.com/v1',
      cloud: {
        providerId: 'openai',
        upstreamBaseUrl: 'https://api.example.com/v1',
        authStyle: 'bearer',
      },
      supportsVision: true,
    })
  })
})
