import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
  BrowserWindow: class {},
  dialog: {},
  net: {},
}))

import {
  resolveOvmsReasoningParser,
  resolveOvmsToolParser,
} from '../../subprocesses/openVINOBackendService'

describe('resolveOvmsToolParser', () => {
  const models = [
    { name: 'OpenVINO/gpt-oss-20b-int4-ov', toolParser: 'gptoss' },
    { name: 'OpenVINO/Mistral-7B-Instruct-v0.3-int4-cw-ov', toolParser: 'mistral' },
    { name: 'OpenVINO/Qwen3-4B-int4-ov' },
  ]

  it('uses the model toolParser override when specified', () => {
    expect(resolveOvmsToolParser('OpenVINO/gpt-oss-20b-int4-ov', models)).toBe('gptoss')
    expect(resolveOvmsToolParser('OpenVINO/Mistral-7B-Instruct-v0.3-int4-cw-ov', models)).toBe(
      'mistral',
    )
  })

  it('falls back to hermes3 when toolParser is omitted', () => {
    expect(resolveOvmsToolParser('OpenVINO/Qwen3-4B-int4-ov', models)).toBe('hermes3')
  })

  it('falls back to hermes3 for unknown models or empty models list', () => {
    expect(resolveOvmsToolParser('unknown/model', models)).toBe('hermes3')
    expect(resolveOvmsToolParser('OpenVINO/gpt-oss-20b-int4-ov', [])).toBe('hermes3')
    expect(resolveOvmsToolParser('OpenVINO/gpt-oss-20b-int4-ov', undefined)).toBe('hermes3')
  })
})

describe('resolveOvmsReasoningParser', () => {
  const models = [
    {
      name: 'OpenVINO/gpt-oss-20b-int4-ov',
      supportsReasoning: true,
      reasoningParser: 'gptoss',
    },
    {
      name: 'OpenVINO/Qwen3-4B-int4-ov',
      supportsReasoning: true,
    },
    {
      name: 'OpenVINO/Mistral-7B-Instruct-v0.3-int4-cw-ov',
      supportsReasoning: false,
    },
    {
      name: 'OpenVINO/DeepSeek-R1-Distill-Qwen-1.5B-int4-ov',
      supportsReasoning: true,
    },
  ]

  it('uses the explicit reasoningParser override (e.g. gptoss)', () => {
    expect(resolveOvmsReasoningParser('OpenVINO/gpt-oss-20b-int4-ov', models)).toBe('gptoss')
  })

  it('defaults to qwen3 for models supporting reasoning without explicit parser', () => {
    expect(resolveOvmsReasoningParser('OpenVINO/Qwen3-4B-int4-ov', models)).toBe('qwen3')
    expect(
      resolveOvmsReasoningParser('OpenVINO/DeepSeek-R1-Distill-Qwen-1.5B-int4-ov', models),
    ).toBe('qwen3')
  })

  it('returns undefined for models where reasoning is unsupported', () => {
    expect(
      resolveOvmsReasoningParser('OpenVINO/Mistral-7B-Instruct-v0.3-int4-cw-ov', models),
    ).toBeUndefined()
  })

  it('falls back to qwen3 when model is unknown or list is empty', () => {
    expect(resolveOvmsReasoningParser('unknown/model', models)).toBe('qwen3')
    expect(resolveOvmsReasoningParser('OpenVINO/gpt-oss-20b-int4-ov', [])).toBe('qwen3')
    expect(resolveOvmsReasoningParser('OpenVINO/gpt-oss-20b-int4-ov', undefined)).toBe('qwen3')
  })
})
