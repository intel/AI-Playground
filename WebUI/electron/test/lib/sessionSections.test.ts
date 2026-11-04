import { describe, expect, it } from 'vitest'
import { sessionSections } from '@/lib/sessionSections'
import type { SessionSummary } from '@/types/sessionIpc'

const UNTITLED = 'Untitled Session'

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return { id, title: id, renamed: false, createdAt: 0, updatedAt: 0, presetsUsed: [], ...over }
}

function ids(sections: ReturnType<typeof sessionSections>) {
  return sections.map((section) => [section.id, section.sessions.map((s) => s.id)])
}

describe('sessionSections', () => {
  it('lists every Session under Recent, newest turn first', () => {
    const sessions = [
      session('old', { updatedAt: 1 }),
      session('new', { updatedAt: 3 }),
      session('mid', { updatedAt: 2 }),
    ]
    expect(ids(sessionSections(sessions, '', UNTITLED))).toEqual([
      ['recent', ['new', 'mid', 'old']],
    ])
  })

  it('breaks a tie in last turn by the newer Session', () => {
    const sessions = [
      session('first', { createdAt: 1, updatedAt: 5 }),
      session('second', { createdAt: 2, updatedAt: 5 }),
    ]
    expect(ids(sessionSections(sessions, '', UNTITLED))).toEqual([['recent', ['second', 'first']]])
  })

  it('shows no sections when there are no Sessions', () => {
    expect(sessionSections([], '', UNTITLED)).toEqual([])
  })

  it('narrows to Titles containing the query, ignoring case and surrounding spaces', () => {
    const sessions = [
      session('a', { title: 'Sunset over Lisbon', updatedAt: 2 }),
      session('b', { title: 'Grocery list', updatedAt: 3 }),
      session('c', { title: 'LISBON trip plan', updatedAt: 1 }),
    ]
    expect(ids(sessionSections(sessions, '  lisbon ', UNTITLED))).toEqual([['recent', ['a', 'c']]])
  })

  it('matches an untitled Session by the Title the panel shows for it', () => {
    const sessions = [session('blank', { title: '' }), session('named', { title: 'Logo ideas' })]
    expect(ids(sessionSections(sessions, 'untitled', UNTITLED))).toEqual([['recent', ['blank']]])
  })

  it('shows no sections when nothing matches', () => {
    expect(sessionSections([session('a', { title: 'Logo' })], 'xyz', UNTITLED)).toEqual([])
  })

  it('lists everything for a blank query', () => {
    expect(ids(sessionSections([session('a', { title: 'Logo' })], '   ', UNTITLED))).toEqual([
      ['recent', ['a']],
    ])
  })

  it('lists Named Sessions above Recent, each newest turn first', () => {
    const sessions = [
      session('recent-old', { updatedAt: 1 }),
      session('named-old', { renamed: true, updatedAt: 2 }),
      session('recent-new', { updatedAt: 5 }),
      session('named-new', { renamed: true, updatedAt: 4 }),
    ]
    expect(ids(sessionSections(sessions, '', UNTITLED))).toEqual([
      ['named', ['named-new', 'named-old']],
      ['recent', ['recent-new', 'recent-old']],
    ])
  })

  it('omits Recent when every Session is Named', () => {
    expect(ids(sessionSections([session('a', { renamed: true })], '', UNTITLED))).toEqual([
      ['named', ['a']],
    ])
  })

  it('searches within each section and drops sections left empty', () => {
    const sessions = [
      session('named-hit', { title: 'Lisbon trip', renamed: true, updatedAt: 1 }),
      session('named-miss', { title: 'Groceries', renamed: true, updatedAt: 2 }),
      session('recent-hit', { title: 'lisbon photos', updatedAt: 3 }),
      session('recent-miss', { title: 'Logo', updatedAt: 4 }),
    ]
    expect(ids(sessionSections(sessions, 'LISBON', UNTITLED))).toEqual([
      ['named', ['named-hit']],
      ['recent', ['recent-hit']],
    ])
    expect(ids(sessionSections(sessions, 'groc', UNTITLED))).toEqual([['named', ['named-miss']]])
  })

  it('keeps an unreadable Session in Recent', () => {
    const sessions = [
      session('broken', { title: 'Unavailable session', unreadable: true, updatedAt: 2 }),
      session('named', { renamed: true, updatedAt: 1 }),
    ]
    expect(ids(sessionSections(sessions, '', UNTITLED))).toEqual([
      ['named', ['named']],
      ['recent', ['broken']],
    ])
  })
})
