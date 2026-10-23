import { describe, expect, it } from 'vitest'
import { restoreMissingHistory } from '@/lib/threadHistoryMerge'

// A mid-turn renderer reload resumes the running turn alone, so the live list
// can start in the middle of the thread. Only that shape is repaired — a
// regenerate truncates from the end and must pass through untouched.

const message = (id: string) => ({ id })

describe('restoreMissingHistory', () => {
  it('puts back the prefix a truncated view dropped', () => {
    const stored = [message('u1'), message('a1'), message('u2')]
    const live = [message('u2'), message('a2'), message('u3')]

    expect(restoreMissingHistory(stored, live).map((m) => m.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
      'u3',
    ])
  })

  it('leaves a list that already starts the thread alone', () => {
    const stored = [message('u1'), message('a1'), message('u2')]
    const live = [message('u1')]

    expect(restoreMissingHistory(stored, live)).toBe(live)
  })

  it('leaves a list whose first message the thread never had alone', () => {
    const stored = [message('u1'), message('a1')]
    const live = [message('u9'), message('a9')]

    expect(restoreMissingHistory(stored, live)).toBe(live)
  })

  it('does not resurrect a cleared thread', () => {
    expect(restoreMissingHistory([message('u1')], [])).toEqual([])
  })
})
