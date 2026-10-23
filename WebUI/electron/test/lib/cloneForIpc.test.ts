import { describe, expect, it } from 'vitest'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { reactive } from 'vue'

describe('cloneForIpc', () => {
  it('produces a structured-cloneable plain object from a Vue proxy', () => {
    const value = reactive({ a: 1, nested: { b: 'hi' } })
    const cloned = cloneForIpc(value)
    expect(cloned).toEqual({ a: 1, nested: { b: 'hi' } })
    expect(cloned).not.toBe(value)
    expect(structuredClone(cloned)).toEqual(cloned)
  })

  it('clones a chat tool-result payload that wraps a Vue proxy output', () => {
    const payload = reactive({
      requestId: 'req-1',
      output: { images: [{ id: 'i1', type: 'image' }], summary: 'ok', steps: [] },
    })
    const cloned = cloneForIpc(payload)
    expect(cloned.output).toEqual({
      images: [{ id: 'i1', type: 'image' }],
      summary: 'ok',
      steps: [],
    })
    expect(structuredClone(cloned)).toEqual(cloned)
  })
})
