import type { SessionSummary } from '@/types/sessionIpc'

export type SessionSectionId = 'pinned' | 'named' | 'recent'

export type SessionSection = { id: SessionSectionId; sessions: SessionSummary[] }

const SECTION_ORDER: { id: SessionSectionId; holds: (session: SessionSummary) => boolean }[] = [
  { id: 'pinned', holds: (session) => session.pinned && !session.unreadable },
  { id: 'named', holds: (session) => session.renamed && !session.unreadable },
  { id: 'recent', holds: () => true },
]

export function sessionSections(
  summaries: SessionSummary[],
  query: string,
  untitled: string,
): SessionSection[] {
  const needle = query.trim().toLocaleLowerCase()
  const matching = needle
    ? summaries.filter((s) => (s.title || untitled).toLocaleLowerCase().includes(needle))
    : summaries
  const ordered = [...matching].sort(
    (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
  )
  const sections = SECTION_ORDER.map(({ id }) => ({ id, sessions: [] as SessionSummary[] }))
  for (const session of ordered) {
    const index = SECTION_ORDER.findIndex((section) => section.holds(session))
    sections[index].sessions.push(session)
  }
  return sections.filter((section) => section.sessions.length > 0)
}
