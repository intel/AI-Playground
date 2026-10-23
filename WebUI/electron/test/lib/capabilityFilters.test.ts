import { describe, expect, it } from 'vitest'
import { ModelSchema } from '@/types/shared'
import { CAPABILITIES, modelPassesCapabilityFilters } from '@/assets/js/capabilities'

describe('agentic capability filter', () => {
  it('phrases the missing-capability tip as a sentence', () => {
    const agentic = CAPABILITIES.find((cap) => cap.key === 'agentic')
    expect(agentic?.lacksTooltip).toBe('This model is not reliable at multi-step tool use.')
  })

  it('keeps a model that has the flag and drops one that does not', () => {
    expect(modelPassesCapabilityFilters({ supportsAgentic: true }, ['agentic'])).toBe(true)
    expect(modelPassesCapabilityFilters({ supportsAgentic: false }, ['agentic'])).toBe(false)
    expect(modelPassesCapabilityFilters({}, ['agentic'])).toBe(false)
    expect(modelPassesCapabilityFilters({ supportsAgentic: true }, [])).toBe(true)
    expect(
      modelPassesCapabilityFilters({ supportsAgentic: true, supportsVision: true }, [
        'agentic',
        'vision',
      ]),
    ).toBe(true)
    expect(modelPassesCapabilityFilters({ supportsAgentic: true }, ['agentic', 'vision'])).toBe(
      false,
    )
  })

  it('keeps supportsAgentic through ModelSchema', () => {
    const parsed = ModelSchema.parse({
      name: 'org/Model',
      type: 'llamaCPP',
      supportsAgentic: true,
      supportsCoding: false,
      notARealField: true,
    })
    expect(parsed.supportsAgentic).toBe(true)
    expect(parsed.supportsCoding).toBe(false)
    expect(parsed).not.toHaveProperty('notARealField')
  })
})
