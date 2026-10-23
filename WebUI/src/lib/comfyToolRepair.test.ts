import { describe, expect, it } from 'vitest'
import { repairWorkflowToolInput } from './comfyToolRepair'

describe('repairWorkflowToolInput', () => {
  const data = { names: ['Draft Image', 'Photo Real', 'Animate'], defaultWorkflow: 'Draft Image' }

  it('returns null for an already-valid workflow', () => {
    expect(repairWorkflowToolInput('{"prompt":"a cat","workflow":"Photo Real"}', data)).toBeNull()
  })

  it('coerces an unknown workflow to the default', () => {
    const repaired = repairWorkflowToolInput('{"prompt":"a cat","workflow":"nope"}', data)
    expect(repaired).not.toBeNull()
    expect(JSON.parse(repaired!)).toEqual({ prompt: 'a cat', workflow: 'Draft Image' })
  })

  it('adds the default when workflow is omitted', () => {
    const repaired = repairWorkflowToolInput('{"prompt":"a cat"}', data)
    expect(JSON.parse(repaired!)).toEqual({ prompt: 'a cat', workflow: 'Draft Image' })
  })

  it('repairs unparseable input into a bare default call', () => {
    const repaired = repairWorkflowToolInput('not json{', data)
    expect(JSON.parse(repaired!)).toEqual({ workflow: 'Draft Image' })
  })

  it('returns null when no workflows exist', () => {
    expect(repairWorkflowToolInput('{}', { names: [], defaultWorkflow: 'Draft Image' })).toBeNull()
  })
})
