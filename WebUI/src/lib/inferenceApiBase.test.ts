import { describe, expect, it } from 'vitest'
import { openAiApiBase } from '@/lib/inferenceApiBase'

describe('openAiApiBase', () => {
  it('appends /v1 when the URL has no version segment', () => {
    expect(openAiApiBase('http://127.0.0.1:39000')).toBe('http://127.0.0.1:39000/v1')
  })

  it('keeps an existing /v1 or /v3', () => {
    expect(openAiApiBase('http://127.0.0.1:39000/v1')).toBe('http://127.0.0.1:39000/v1')
    expect(openAiApiBase('http://127.0.0.1:29000/v3')).toBe('http://127.0.0.1:29000/v3')
  })

  it('strips a trailing slash', () => {
    expect(openAiApiBase('http://127.0.0.1:39000/')).toBe('http://127.0.0.1:39000/v1')
    expect(openAiApiBase('http://127.0.0.1:29000/v3/')).toBe('http://127.0.0.1:29000/v3')
  })
})
