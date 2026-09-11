import { describe, expect, it } from 'vitest'
import { npuPromptLen, OPENVINO_NPU_MAX_PROMPT_LEN } from '@/types/shared'

// OVMS on NPU is started with `--max_prompt_len <contextSize>` and compiles a
// static graph for it, so raising a preset's context size (agent presets ask for
// 128k) would otherwise land on the NPU as a far more expensive compile.
describe('npuPromptLen', () => {
  it('caps a window larger than the NPU can be started with', () => {
    expect(npuPromptLen(131072)).toBe(OPENVINO_NPU_MAX_PROMPT_LEN)
    expect(npuPromptLen(32768)).toBe(OPENVINO_NPU_MAX_PROMPT_LEN)
  })

  it('leaves a smaller window alone', () => {
    expect(npuPromptLen(4096)).toBe(4096)
  })

  it('falls back to the cap when no context size is configured', () => {
    expect(npuPromptLen(undefined)).toBe(OPENVINO_NPU_MAX_PROMPT_LEN)
  })
})
