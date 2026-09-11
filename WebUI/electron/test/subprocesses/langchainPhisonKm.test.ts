import { Document } from '@langchain/classic/document'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  buildMergedGroups,
  ensureMergedGroups,
  groupsAreValid,
  selectGroupContext,
  stampGroupIds,
  warmupKVCache,
  WARMUP_MAX_CONSECUTIVE_FAILURES,
  type SplitterParams,
} from '../../subprocesses/langchainPhisonKm'
import { deriveGroupContent, GROUP_SEPARATOR } from '@/types/phisonKmRag'
import type { IndexedDocument, WarmupRequest } from '@/assets/js/store/textInference'

/**
 * The value MAX_TOKENS_PER_GROUP is expected to have. It isn't exported, so the group
 * boundaries asserted below are derived from this literal — and every buildMergedGroups
 * assertion also checks meta.maxTokensPerGroup, so changing the real constant fails
 * loudly here instead of silently invalidating the expected boundaries.
 */
const MAX_TOKENS_PER_GROUP = 13000

const SPLITTER_PARAMS: SplitterParams = { chunkSize: 512, chunkOverlap: 64 }

/**
 * Stubs the embedding server's /tokenize endpoint with one token per character, so a
 * chunk's token count is exactly its length and group boundaries are predictable.
 * Returns the mock so tests can assert on call counts (the W3-3 regression: groups must
 * not be re-tokenized on every query).
 */
function stubTokenize() {
  const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
    const content = JSON.parse(init?.body ?? '{}').content as string
    return {
      ok: true,
      json: async () => ({ tokens: new Array(content.length).fill(0) }),
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function chunk(text: string, source = 'doc.txt'): Document {
  return new Document({ pageContent: text, metadata: { source } })
}

/** n chunks of `size` characters each, distinguishable by their leading index. */
function chunks(n: number, size: number): Document[] {
  return Array.from({ length: n }, (_, i) => chunk(`${i}`.padEnd(size, 'x')))
}

function indexedDoc(overrides: Partial<IndexedDocument> & { splitDB: Document[] }) {
  return {
    filename: 'doc.txt',
    filepath: '/tmp/doc.txt',
    type: 'txt',
    hash: 'hash-a',
    isChecked: true,
    ...overrides,
  } as IndexedDocument
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildMergedGroups', () => {
  it('caps each group at MAX_TOKENS_PER_GROUP, charging the join separator', async () => {
    stubTokenize()
    // 4000 tokens per chunk, 2 tokens per '\n\n' separator:
    //   group 0: 4000 + 4002 + 4002 = 12004  (adding a 4th chunk would be 16006 > 13000)
    //   group 1: 4000 + 4002       =  8002
    const { groups, meta } = await buildMergedGroups(
      chunks(5, 4000),
      'http://localhost:1234',
      SPLITTER_PARAMS,
      'hash-a',
    )

    expect(meta.maxTokensPerGroup).toBe(MAX_TOKENS_PER_GROUP)
    expect(groups.map((g) => [g.startChunkIdx, g.endChunkIdx])).toEqual([
      [0, 2],
      [3, 4],
    ])
  })

  it('records the splitter fingerprint and chunk count', async () => {
    stubTokenize()
    const { meta } = await buildMergedGroups(
      chunks(3, 100),
      'http://localhost:1234',
      SPLITTER_PARAMS,
      'hash-a',
    )

    expect(meta).toEqual({
      chunkSize: SPLITTER_PARAMS.chunkSize,
      chunkOverlap: SPLITTER_PARAMS.chunkOverlap,
      maxTokensPerGroup: MAX_TOKENS_PER_GROUP,
      chunkCount: 3,
    })
  })

  it('keys groupId on the document content hash, not the source path', async () => {
    stubTokenize()
    const url = 'http://localhost:1234'

    const sameHash = await buildMergedGroups(chunks(3, 100), url, SPLITTER_PARAMS, 'hash-a')
    // Same content hash, different source path — the same document re-added from another
    // folder must produce the same groupIds, since ragList treats it as one document.
    const movedFile = await buildMergedGroups(
      chunks(3, 100).map((c) => chunk(c.pageContent, '/elsewhere/doc.txt')),
      url,
      SPLITTER_PARAMS,
      'hash-a',
    )
    const otherHash = await buildMergedGroups(chunks(3, 100), url, SPLITTER_PARAMS, 'hash-b')

    expect(movedFile.groups.map((g) => g.groupId)).toEqual(sameHash.groups.map((g) => g.groupId))
    expect(otherHash.groups[0].groupId).not.toBe(sameHash.groups[0].groupId)
  })
})

describe('groupsAreValid', () => {
  const splitDB = chunks(3, 100)
  const validMeta = {
    ...SPLITTER_PARAMS,
    maxTokensPerGroup: MAX_TOKENS_PER_GROUP,
    chunkCount: 3,
  }
  const groups = [{ groupId: 'g0', startChunkIdx: 0, endChunkIdx: 2 }]

  it('accepts groups whose fingerprint matches the current splitDB and splitter', () => {
    const doc = indexedDoc({ splitDB, mergedGroups: groups, mergedGroupsMeta: validMeta })
    expect(groupsAreValid(doc, SPLITTER_PARAMS)).toBe(true)
  })

  it.each([
    ['groups are absent', { mergedGroupsMeta: validMeta }],
    ['groups are empty', { mergedGroups: [], mergedGroupsMeta: validMeta }],
    ['meta is absent', { mergedGroups: groups }],
    [
      'chunk count drifted from splitDB',
      { mergedGroups: groups, mergedGroupsMeta: { ...validMeta, chunkCount: 5 } },
    ],
    [
      'chunkSize changed',
      { mergedGroups: groups, mergedGroupsMeta: { ...validMeta, chunkSize: 1024 } },
    ],
    [
      'maxTokensPerGroup changed',
      { mergedGroups: groups, mergedGroupsMeta: { ...validMeta, maxTokensPerGroup: 8000 } },
    ],
  ])('rejects when %s', (_case, overrides) => {
    const doc = indexedDoc({ splitDB, ...(overrides as Partial<IndexedDocument>) })
    expect(groupsAreValid(doc, SPLITTER_PARAMS)).toBe(false)
  })
})

describe('ensureMergedGroups', () => {
  it('does not re-tokenize when persisted groups are still valid', async () => {
    const fetchMock = stubTokenize()
    const splitDB = chunks(3, 100)
    const doc = indexedDoc({
      splitDB,
      mergedGroups: [{ groupId: 'g0', startChunkIdx: 0, endChunkIdx: 2 }],
      mergedGroupsMeta: {
        ...SPLITTER_PARAMS,
        maxTokensPerGroup: MAX_TOKENS_PER_GROUP,
        chunkCount: 3,
      },
    })

    await ensureMergedGroups([doc], 'http://localhost:1234', SPLITTER_PARAMS)

    expect(fetchMock).not.toHaveBeenCalled()
    // groupId is still (re)stamped onto chunk metadata, which needs no HTTP.
    expect(splitDB.map((c) => c.metadata.groupId)).toEqual(['g0', 'g0', 'g0'])
  })

  it('rebuilds when the fingerprint is stale', async () => {
    const fetchMock = stubTokenize()
    const doc = indexedDoc({
      splitDB: chunks(3, 100),
      mergedGroups: [{ groupId: 'stale', startChunkIdx: 0, endChunkIdx: 0 }],
      mergedGroupsMeta: {
        ...SPLITTER_PARAMS,
        maxTokensPerGroup: MAX_TOKENS_PER_GROUP,
        chunkCount: 1, // splitDB actually has 3
      },
    })

    await ensureMergedGroups([doc], 'http://localhost:1234', SPLITTER_PARAMS)

    expect(fetchMock).toHaveBeenCalled()
    expect(doc.mergedGroupsMeta?.chunkCount).toBe(3)
    expect(doc.mergedGroups).toEqual([
      { groupId: expect.any(String), startChunkIdx: 0, endChunkIdx: 2 },
    ])
  })
})

describe('selectGroupContext', () => {
  it('returns the whole group of the best-scoring chunk, derived from splitDB', () => {
    const splitDB = chunks(3, 10)
    splitDB[1].metadata.loc = { pageNumber: 4, lines: { from: 10, to: 20 } }
    const groups = [{ groupId: 'g0', startChunkIdx: 0, endChunkIdx: 2 }]
    stampGroupIds(splitDB, groups)
    const doc = indexedDoc({ splitDB, mergedGroups: groups })

    const selected = selectGroupContext([[splitDB[1], 0.9]], [doc])

    expect(selected).toHaveLength(1)
    expect(selected[0].pageContent).toBe(deriveGroupContent(splitDB, groups[0]))
    expect(selected[0].metadata).toMatchObject({
      groupId: 'g0',
      startChunkIdx: 0,
      endChunkIdx: 2,
      source: 'doc.txt',
    })
    // Intentionally omit loc — group spans many chunks, so a single page/line cite
    // would be misleading; Source Docs shows the filename only.
    expect(selected[0].metadata.loc).toBeUndefined()
  })

  it('falls back to the individual chunks when no group info is available', () => {
    const splitDB = chunks(2, 10)
    const doc = indexedDoc({ splitDB })

    const selected = selectGroupContext(
      [
        [splitDB[1], 0.9],
        [splitDB[0], 0.8],
      ],
      [doc],
    )

    expect(selected).toHaveLength(2)
  })

  it('returns nothing when there are no retrieval hits', () => {
    expect(selectGroupContext([], [])).toEqual([])
  })
})

describe('deriveGroupContent', () => {
  it('reproduces the ingest-time slice exactly', () => {
    const splitDB = chunks(4, 10)
    const group = { groupId: 'g0', startChunkIdx: 1, endChunkIdx: 2 }

    expect(deriveGroupContent(splitDB, group)).toBe(
      [splitDB[1].pageContent, splitDB[2].pageContent].join(GROUP_SEPARATOR),
    )
  })
})

describe('warmupKVCache', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function warmupRequest(groupCount: number): WarmupRequest {
    return {
      llmBackendUrl: 'http://llm.local',
      modelName: 'test-model',
      ragSystemPrefix: 'shared-prefix',
      mergedGroups: Array.from({ length: groupCount }, (_, i) => ({
        groupId: `g${i}`,
        content: `group-${i}-content`,
      })),
    }
  }

  it('stops after WARMUP_MAX_CONSECUTIVE_FAILURES non-OK responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    vi.stubGlobal('fetch', fetchMock)

    await warmupKVCache(warmupRequest(WARMUP_MAX_CONSECUTIVE_FAILURES + 2))

    expect(fetchMock).toHaveBeenCalledTimes(WARMUP_MAX_CONSECUTIVE_FAILURES)
  })

  it('resets the consecutive-failure count after a success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValue({ ok: false, status: 503 })
    vi.stubGlobal('fetch', fetchMock)

    await warmupKVCache(warmupRequest(WARMUP_MAX_CONSECUTIVE_FAILURES + 2))

    // 1 fail + 1 success + 3 consecutive fails = 5 calls (not aborted early at 3)
    expect(fetchMock).toHaveBeenCalledTimes(WARMUP_MAX_CONSECUTIVE_FAILURES + 2)
  })
})
