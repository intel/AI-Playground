import { describe, expect, it } from 'vitest'
import { isOnDemandBackend, ON_DEMAND_BACKENDS } from './onDemandBackends'

describe('isOnDemandBackend', () => {
  it('marks the dedicated TTS and STT sidecars as on-demand', () => {
    expect(isOnDemandBackend('qwen3-tts-backend')).toBe(true)
    expect(isOnDemandBackend('whisper-backend')).toBe(true)
  })

  it('does not mark inference or core backends as on-demand', () => {
    expect(isOnDemandBackend('ai-backend')).toBe(false)
    expect(isOnDemandBackend('llamacpp-backend')).toBe(false)
    expect(isOnDemandBackend('openvino-backend')).toBe(false)
    expect(isOnDemandBackend('comfyui-backend')).toBe(false)
    expect(isOnDemandBackend('home-agent-backend')).toBe(false)
  })

  it('lists only the two dedicated audio sidecars', () => {
    expect([...ON_DEMAND_BACKENDS]).toEqual(['qwen3-tts-backend', 'whisper-backend'])
  })
})
