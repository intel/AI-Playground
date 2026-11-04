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

function sections(sessions: SessionSummary[], query = '', groups: SessionGroup[] = []) {
  return sessionSections({ sessions, groups, query, untitled: UNTITLED })
}

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

  it('renders every Group expanded', () => {
    const result = sections([session('a1', { groupId: 'a' })], '', [
      group('a', { expanded: false }),
    ])
    const groupsSection = result.find((section) => section.id === 'groups')
    expect(groupsSection?.id === 'groups' && groupsSection.groups[0].expanded).toBe(true)
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
})
