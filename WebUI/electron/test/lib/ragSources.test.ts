import { describe, expect, it } from 'vitest'
import { PHISON_KM_RAG_PREFIX } from '@/types/phisonKmRag'
import { augmentSystemPrompt, formatRagSources } from '@/lib/ragSources'

describe('formatRagSources', () => {
  it('uses the filename when KM retrieval returns a source with no loc', () => {
    expect(formatRagSources([{ metadata: { source: '/home/user/docs/handbook.pdf' } }])).toBe(
      'handbook.pdf',
    )
  })

  it('merges overlapping line ranges on the same page', () => {
    expect(
      formatRagSources([
        {
          metadata: {
            source: 'notes.txt',
            loc: { pageNumber: 1, lines: { from: 1, to: 4 } },
          },
        },
        {
          metadata: {
            source: 'notes.txt',
            loc: { pageNumber: 1, lines: { from: 5, to: 8 } },
          },
        },
      ]),
    ).toBe('notes.txt (Page 1, Lines 1-8)')
  })

  it('keeps disjoint ranges and unknown sources', () => {
    expect(
      formatRagSources([
        {
          metadata: {
            source: 'a.txt',
            loc: { lines: { from: 1, to: 2 } },
          },
        },
        {
          metadata: {
            source: 'a.txt',
            loc: { lines: { from: 10, to: 12 } },
          },
        },
        { metadata: {} },
      ]),
    ).toBe('a.txt (Lines 1-2)\na.txt (Lines 10-12)\nUnknown Source')
  })
})

describe('augmentSystemPrompt', () => {
  it('appends standard RAG context after the base prompt', () => {
    expect(augmentSystemPrompt('Be brief.', ['chunk-a', 'chunk-b'], false)).toBe(
      'Be brief.\n\nUse the following context from your knowledge base to answer the question:\n\nchunk-a\n\nchunk-b',
    )
  })

  it('puts the KM prefix in front of the document context', () => {
    const prompt = augmentSystemPrompt('Be brief.', ['group-text'], true)
    expect(prompt.startsWith(PHISON_KM_RAG_PREFIX)).toBe(true)
    expect(prompt).toContain('Document context:\n\ngroup-text')
    expect(prompt.endsWith('Be brief.')).toBe(true)
  })

  it('leaves the base prompt alone when retrieval returned nothing', () => {
    expect(augmentSystemPrompt('Be brief.', [], true)).toBe('Be brief.')
  })
})
