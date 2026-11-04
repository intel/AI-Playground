import { describe, expect, it } from 'vitest'
import { sessionSections, type SessionSection } from '@/lib/sessionSections'
import type { SessionGroup, SessionSummary } from '@/types/sessionIpc'

const UNTITLED = 'Untitled Session'

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: id,
    renamed: false,
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
    presetsUsed: [],
    ...over,
  }
}

function group(id: string, over: Partial<SessionGroup> = {}): SessionGroup {
  return { id, name: id, createdAt: 0, expanded: true, ...over }
}

function sections(
  sessions: SessionSummary[],
  query = '',
  groups: SessionGroup[] = [],
  view: { openSessionId?: string | null; pinnedShowMore?: boolean } = {},
) {
  return sessionSections({
    sessions,
    groups,
    query,
    untitled: UNTITLED,
    openSessionId: view.openSessionId ?? null,
    pinnedShowMore: view.pinnedShowMore ?? false,
  })
}

function pinnedOf(result: SessionSection[]) {
  const pinned = result.find((section) => section.id === 'pinned')
  if (pinned?.id !== 'pinned') throw new Error('no Pinned section')
  return { ids: pinned.sessions.map((s) => s.id), toggle: pinned.toggle }
}

/** Five pinned Sessions, p1 the most recently used. */
const fivePins = [5, 4, 3, 2, 1].map((n) => session(`p${6 - n}`, { pinned: true, updatedAt: n }))

function ids(result: SessionSection[]) {
  return result.map((section) =>
    section.id === 'groups'
      ? [section.id, section.groups.map((g) => [g.group.id, g.sessions.map((s) => s.id)])]
      : [section.id, section.sessions.map((s) => s.id)],
  )
}

describe('sessionSections', () => {
  it('lists every Session under Recent, newest turn first', () => {
    const sessions = [
      session('old', { updatedAt: 1 }),
      session('new', { updatedAt: 3 }),
      session('mid', { updatedAt: 2 }),
    ]
    expect(ids(sections(sessions))).toEqual([['recent', ['new', 'mid', 'old']]])
  })

  it('breaks a tie in last turn by the newer Session', () => {
    const sessions = [
      session('first', { createdAt: 1, updatedAt: 5 }),
      session('second', { createdAt: 2, updatedAt: 5 }),
    ]
    expect(ids(sections(sessions))).toEqual([['recent', ['second', 'first']]])
  })

  it('shows no sections when there are no Sessions', () => {
    expect(sections([])).toEqual([])
  })

  it('narrows to Titles containing the query, ignoring case and surrounding spaces', () => {
    const sessions = [
      session('a', { title: 'Sunset over Lisbon', updatedAt: 2 }),
      session('b', { title: 'Grocery list', updatedAt: 3 }),
      session('c', { title: 'LISBON trip plan', updatedAt: 1 }),
    ]
    expect(ids(sections(sessions, '  lisbon '))).toEqual([['recent', ['a', 'c']]])
  })

  it('matches an untitled Session by the Title the panel shows for it', () => {
    const sessions = [session('blank', { title: '' }), session('named', { title: 'Logo ideas' })]
    expect(ids(sections(sessions, 'untitled'))).toEqual([['recent', ['blank']]])
  })

  it('shows no sections when nothing matches', () => {
    expect(sections([session('a', { title: 'Logo' })], 'xyz')).toEqual([])
  })

  it('lists everything for a blank query', () => {
    expect(ids(sections([session('a', { title: 'Logo' })], '   '))).toEqual([['recent', ['a']]])
  })

  it('lists a Session the user named in Recent, where it was before its Name', () => {
    const sessions = [
      session('plain', { updatedAt: 1 }),
      session('named', { title: 'Foxes', renamed: true, updatedAt: 2 }),
    ]
    expect(ids(sections(sessions))).toEqual([['recent', ['named', 'plain']]])
  })

  it('keeps an unreadable Session in Recent', () => {
    const sessions = [
      session('broken', { title: 'Unavailable session', unreadable: true, updatedAt: 2 }),
      session('pinned', { pinned: true, updatedAt: 1 }),
    ]
    expect(ids(sections(sessions))).toEqual([
      ['pinned', ['pinned']],
      ['recent', ['broken']],
    ])
  })

  it('lists Pinned above Recent, newest turn first', () => {
    const sessions = [
      session('recent', { updatedAt: 6 }),
      session('pinned-old', { pinned: true, updatedAt: 1 }),
      session('pinned-new', { pinned: true, updatedAt: 3 }),
    ]
    expect(ids(sections(sessions))).toEqual([
      ['pinned', ['pinned-new', 'pinned-old']],
      ['recent', ['recent']],
    ])
  })

  it('pins an untitled Session too', () => {
    expect(ids(sections([session('blank', { title: '', pinned: true })]))).toEqual([
      ['pinned', ['blank']],
    ])
  })

  it('lists Groups between Pinned and Recent, each with its Sessions newest first', () => {
    const sessions = [
      session('recent', { updatedAt: 9 }),
      session('pinned', { pinned: true, updatedAt: 1 }),
      session('in-old', { groupId: 'trip', updatedAt: 2 }),
      session('in-new', { groupId: 'trip', updatedAt: 4 }),
    ]
    expect(ids(sections(sessions, '', [group('trip')]))).toEqual([
      ['pinned', ['pinned']],
      ['groups', [['trip', ['in-new', 'in-old']]]],
      ['recent', ['recent']],
    ])
  })

  it('lists a pinned, grouped Session under Pinned and in its Group', () => {
    const sessions = [session('both', { pinned: true, groupId: 'trip', updatedAt: 1 })]
    expect(ids(sections(sessions, '', [group('trip')]))).toEqual([
      ['pinned', ['both']],
      ['groups', [['trip', ['both']]]],
    ])
  })

  it('orders Groups by their newest member, pinned members included', () => {
    const sessions = [
      session('a1', { groupId: 'a', updatedAt: 3 }),
      session('b-pinned', { groupId: 'b', pinned: true, updatedAt: 5 }),
      session('b1', { groupId: 'b', updatedAt: 1 }),
      session('c1', { groupId: 'c', updatedAt: 4 }),
    ]
    const groups = [group('a'), group('b'), group('c')]
    expect(ids(sections(sessions, '', groups))).toEqual([
      ['pinned', ['b-pinned']],
      [
        'groups',
        [
          ['b', ['b-pinned', 'b1']],
          ['c', ['c1']],
          ['a', ['a1']],
        ],
      ],
    ])
  })

  it('lists empty Groups after the others, newest Group first', () => {
    const sessions = [session('a1', { groupId: 'a', updatedAt: 1 })]
    const groups = [
      group('empty-old', { createdAt: 5 }),
      group('a', { createdAt: 1 }),
      group('empty-new', { createdAt: 9 }),
    ]
    expect(ids(sections(sessions, '', groups))).toEqual([
      [
        'groups',
        [
          ['a', ['a1']],
          ['empty-new', []],
          ['empty-old', []],
        ],
      ],
    ])
  })

  function expandedOf(result: SessionSection[]) {
    const groupsSection = result.find((section) => section.id === 'groups')
    return groupsSection?.id === 'groups'
      ? Object.fromEntries(groupsSection.groups.map((g) => [g.group.id, g.expanded]))
      : {}
  }

  it('renders each Group as expanded or collapsed as it was stored', () => {
    const sessions = [session('a1', { groupId: 'a' }), session('b1', { groupId: 'b' })]
    const groups = [group('a', { expanded: false }), group('b', { expanded: true })]
    expect(expandedOf(sections(sessions, '', groups))).toEqual({ a: false, b: true })
  })

  it('renders a collapsed Group expanded while the open Session is in it', () => {
    const sessions = [session('a1', { groupId: 'a' }), session('b1', { groupId: 'b' })]
    const groups = [group('a', { expanded: false }), group('b', { expanded: false })]
    const result = sections(sessions, '', groups, { openSessionId: 'a1' })
    expect(expandedOf(result)).toEqual({ a: true, b: false })
  })

  it('keeps a Group collapsed when its open Session is already shown under Pinned', () => {
    const sessions = [session('a1', { groupId: 'a', pinned: true })]
    const groups = [group('a', { expanded: false })]
    const result = sections(sessions, '', groups, { openSessionId: 'a1' })
    expect(expandedOf(result)).toEqual({ a: false })
  })

  it('renders matching Groups expanded while searching', () => {
    const sessions = [session('a1', { title: 'Lisbon', groupId: 'a' })]
    const groups = [group('a', { expanded: false })]
    expect(expandedOf(sections(sessions, 'lisbon', groups))).toEqual({ a: true })
  })

  it('lists a Session whose Group cannot be found in Recent', () => {
    const sessions = [
      session('lost', { groupId: 'gone' }),
      session('pinned-lost', { pinned: true, groupId: 'gone' }),
    ]
    expect(ids(sections(sessions, '', [group('other')]))).toEqual([
      ['pinned', ['pinned-lost']],
      ['groups', [['other', []]]],
      ['recent', ['lost']],
    ])
  })

  it('lists an unreadable Session in Recent even if it claims a Group', () => {
    const sessions = [session('broken', { unreadable: true, groupId: 'trip' })]
    expect(ids(sections(sessions, '', [group('trip')]))).toEqual([
      ['groups', [['trip', []]]],
      ['recent', ['broken']],
    ])
  })

  it('shows no Groups section without Groups', () => {
    expect(ids(sections([session('a')], '', []))).toEqual([['recent', ['a']]])
  })

  it('narrows Group members by Title while searching and hides Groups left empty', () => {
    const sessions = [
      session('hit', { title: 'Lisbon photos', groupId: 'trip' }),
      session('miss', { title: 'Packing', groupId: 'trip' }),
    ]
    const groups = [group('trip'), group('empty')]
    expect(ids(sections(sessions, 'lisbon', groups))).toEqual([['groups', [['trip', ['hit']]]]])
  })

  describe('Pinned "show more"', () => {
    it('shows the three most recent pins and counts the rest', () => {
      expect(pinnedOf(sections(fivePins))).toEqual({
        ids: ['p1', 'p2', 'p3'],
        toggle: { action: 'more', count: 2 },
      })
    })

    it('shows every pin with a way back once shown', () => {
      expect(pinnedOf(sections(fivePins, '', [], { pinnedShowMore: true }))).toEqual({
        ids: ['p1', 'p2', 'p3', 'p4', 'p5'],
        toggle: { action: 'less' },
      })
    })

    it('offers no toggle with three pins or fewer, whatever was chosen', () => {
      const three = fivePins.slice(0, 3)
      expect(pinnedOf(sections(three)).toggle).toBeNull()
      expect(pinnedOf(sections(three, '', [], { pinnedShowMore: true })).toggle).toBeNull()
    })

    it('adds the open Session as an extra row when it ranks lower', () => {
      expect(pinnedOf(sections(fivePins, '', [], { openSessionId: 'p5' }))).toEqual({
        ids: ['p1', 'p2', 'p3', 'p5'],
        toggle: { action: 'more', count: 1 },
      })
    })

    it('does not list the open Session twice when it is among the three', () => {
      expect(pinnedOf(sections(fivePins, '', [], { openSessionId: 'p2' }))).toEqual({
        ids: ['p1', 'p2', 'p3'],
        toggle: { action: 'more', count: 2 },
      })
    })

    it('adds no extra row for an open Session that is not pinned', () => {
      const sessions = [...fivePins, session('loose', { updatedAt: 0 })]
      expect(pinnedOf(sections(sessions, '', [], { openSessionId: 'loose' })).ids).toEqual([
        'p1',
        'p2',
        'p3',
      ])
    })

    it('offers no toggle when the open Session is the only pin left out', () => {
      const four = fivePins.slice(0, 4)
      expect(pinnedOf(sections(four, '', [], { openSessionId: 'p4' }))).toEqual({
        ids: ['p1', 'p2', 'p3', 'p4'],
        toggle: null,
      })
    })

    it('shows every matching pin while searching, without a toggle', () => {
      const sessions = fivePins.map((s) => ({ ...s, title: `Trip ${s.id}` }))
      expect(pinnedOf(sections(sessions, 'trip'))).toEqual({
        ids: ['p1', 'p2', 'p3', 'p4', 'p5'],
        toggle: null,
      })
    })
  })
})
