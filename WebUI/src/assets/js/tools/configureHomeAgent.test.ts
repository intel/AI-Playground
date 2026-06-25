import { describe, it, expect } from 'vitest'
import {
  computeConfigChanges,
  summarizeChanges,
  type ConfigContext,
  type HomeAgentConfigRequest,
} from './configureHomeAgentLogic'
import { parseConfirmationReply } from '../store/confirmationReply'

function baseContext(overrides: Partial<ConfigContext> = {}): ConfigContext {
  return {
    currentBackend: 'llamaCPP',
    current: {
      model: 'model-a',
      embeddingModel: 'embed-a',
      deviceId: 'GPU.0',
      temperature: 0.7,
      maxTokens: 2048,
      contextSize: 8192,
      systemPrompt: 'You are helpful.',
      aipgToolsEnabled: true,
      mcpToolsEnabled: true,
      metricsEnabled: false,
      ragDocumentCount: 2,
    },
    modelsByBackend: {
      llamaCPP: [
        { name: 'model-a', maxContextSize: 32768 },
        { name: 'model-b', maxContextSize: 4096 },
      ],
      openVINO: [{ name: 'ov-model', maxContextSize: 16384 }],
    },
    embeddingModelNames: ['embed-a', 'embed-b'],
    deviceIds: ['GPU.0', 'GPU.1', 'NPU'],
    ...overrides,
  }
}

describe('computeConfigChanges', () => {
  it('returns no changes when the request matches the current config', () => {
    const req: HomeAgentConfigRequest = { temperature: 0.7, maxTokens: 2048 }
    const result = computeConfigChanges(req, baseContext())
    expect(result.changes).toHaveLength(0)
    expect(result.errors).toHaveLength(0)
  })

  it('detects a simple temperature change', () => {
    const result = computeConfigChanges({ temperature: 1.1 }, baseContext())
    expect(result.errors).toHaveLength(0)
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({
      field: 'temperature',
      from: '0.7',
      to: '1.1',
      value: 1.1,
    })
  })

  it('rejects an unknown model and lists available models', () => {
    const result = computeConfigChanges({ model: 'does-not-exist' }, baseContext())
    expect(result.changes).toHaveLength(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('model-a')
    expect(result.errors[0]).toContain('model-b')
  })

  it('validates a model against the target (requested) backend', () => {
    // Switching to openVINO and selecting an openVINO model is valid.
    const result = computeConfigChanges({ backend: 'openVINO', model: 'ov-model' }, baseContext())
    expect(result.errors).toHaveLength(0)
    const fields = result.changes.map((c) => c.field)
    expect(fields).toContain('backend')
    expect(fields).toContain('model')
  })

  it('rejects a model that belongs to the other backend', () => {
    const result = computeConfigChanges({ backend: 'openVINO', model: 'model-a' }, baseContext())
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('openVINO')
  })

  it('clamps context size to the model maximum and records a note', () => {
    const result = computeConfigChanges({ model: 'model-b', contextSize: 999999 }, baseContext())
    expect(result.errors).toHaveLength(0)
    expect(result.notes.some((n) => n.includes('4096'))).toBe(true)
    const ctxChange = result.changes.find((c) => c.field === 'contextSize')
    expect(ctxChange?.value).toBe(4096)
  })

  it('rejects an unknown embedding model and device', () => {
    const result = computeConfigChanges(
      { embeddingModel: 'nope', deviceId: 'GPU.9' },
      baseContext(),
    )
    expect(result.errors).toHaveLength(2)
  })

  it('only clears RAG documents when some exist', () => {
    expect(computeConfigChanges({ clearRagDocuments: true }, baseContext()).changes).toHaveLength(1)
    const empty = baseContext({
      current: { ...baseContext().current, ragDocumentCount: 0 },
    })
    expect(computeConfigChanges({ clearRagDocuments: true }, empty).changes).toHaveLength(0)
  })

  it('detects boolean toggle changes', () => {
    const result = computeConfigChanges(
      { aipgToolsEnabled: false, metricsEnabled: true },
      baseContext(),
    )
    const fields = result.changes.map((c) => c.field)
    expect(fields).toEqual(expect.arrayContaining(['aipgToolsEnabled', 'metricsEnabled']))
    expect(fields).not.toContain('mcpToolsEnabled')
  })

  it('ignores a system prompt that only differs in surrounding whitespace', () => {
    const result = computeConfigChanges({ systemPrompt: '  You are helpful.  ' }, baseContext())
    expect(result.changes).toHaveLength(0)
  })
})

describe('summarizeChanges', () => {
  it('renders a markdown bullet list with clamp notes', () => {
    const md = summarizeChanges(
      [{ field: 'temperature', label: 'Temperature', from: '0.7', to: '1.1', value: 1.1 }],
      ['Context size clamped from 999999 to the model maximum of 4096.'],
    )
    expect(md).toContain('- **Temperature**: 0.7 → 1.1')
    expect(md).toContain('_Context size clamped')
  })
})

describe('parseConfirmationReply', () => {
  it('recognizes affirmative replies', () => {
    for (const yes of ['yes', 'Yes', 'y', 'sure', 'OK', 'confirm', 'apply', '👍', 'yes.']) {
      expect(parseConfirmationReply(yes)).toBe(true)
    }
  })

  it('recognizes negative replies', () => {
    for (const no of ['no', 'N', 'cancel', 'stop', "don't", 'abort', '👎']) {
      expect(parseConfirmationReply(no)).toBe(false)
    }
  })

  it('returns null for anything that is not a yes/no answer', () => {
    for (const other of ['', 'maybe', 'set temperature to 1', 'what does that change?']) {
      expect(parseConfirmationReply(other)).toBeNull()
    }
  })
})
