import { describe, expect, it } from 'vitest'
import { sameAgentSetup, type AgentSetup } from '@/lib/agentSetup'

const setup: AgentSetup = {
  settings: { model: 'Qwen', capabilities: ['files', 'web'], thinkingEnabled: true },
  steps: [
    { id: 'a', prompt: 'search' },
    { id: 'b', prompt: 'summarise' },
  ],
}

describe('sameAgentSetup', () => {
  it('ignores key order, unset values, Step ids and blank Steps', () => {
    expect(
      sameAgentSetup(setup, {
        settings: {
          thinkingEnabled: true,
          embeddingModel: undefined,
          model: 'Qwen',
          capabilities: ['files', 'web'],
        },
        steps: [
          { id: 'x', prompt: ' search ' },
          { id: 'y', prompt: '' },
          { id: 'z', prompt: 'summarise' },
        ],
      }),
    ).toBe(true)
  })

  it.each([
    ['a setting', { ...setup, settings: { ...setup.settings, thinkingEnabled: false } }],
    ['a tool', { ...setup, settings: { ...setup.settings, capabilities: ['files'] } }],
    ['the Step order', { ...setup, steps: [...setup.steps].reverse() }],
    ['an added Step', { ...setup, steps: [...setup.steps, { id: 'c', prompt: 'read aloud' }] }],
  ])('tells a changed %s apart', (_case, other) => {
    expect(sameAgentSetup(setup, other)).toBe(false)
  })
})
