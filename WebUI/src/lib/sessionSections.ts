import type { SessionGroup, SessionSummary } from '@/types/sessionIpc'

export type SessionGroupListing = {
  group: SessionGroup
  sessions: SessionSummary[]
  expanded: boolean
}

/** The button row under the pinned rows: "Show N more" or "Show less". */
export type PinnedToggle = { action: 'more'; count: number } | { action: 'less' } | null

export type SessionSection =
  | { id: 'pinned'; sessions: SessionSummary[]; toggle: PinnedToggle }
  | { id: 'groups'; groups: SessionGroupListing[] }
  | { id: 'recent'; sessions: SessionSummary[] }

export type SessionSectionId = SessionSection['id']

export type SessionSectionsInput = {
  sessions: SessionSummary[]
  groups: SessionGroup[]
  query: string
  /** The Title the panel shows for a Session that has none yet. */
  untitled: string
  openSessionId: string | null
  pinnedShowMore: boolean
}

const PINNED_SHOWN = 3

function pinnedSection(
  pinned: SessionSummary[],
  searching: boolean,
  openSessionId: string | null,
  showMore: boolean,
): SessionSection {
  if (searching || pinned.length <= PINNED_SHOWN) {
    return { id: 'pinned', sessions: pinned, toggle: null }
  }
  if (showMore) return { id: 'pinned', sessions: pinned, toggle: { action: 'less' } }
  const shown = pinned.filter((s, index) => index < PINNED_SHOWN || s.id === openSessionId)
  const count = pinned.length - shown.length
  return { id: 'pinned', sessions: shown, toggle: count > 0 ? { action: 'more', count } : null }
}

function newestFirst(a: SessionSummary, b: SessionSummary): number {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt
}

export function sessionSections({
  sessions,
  groups,
  query,
  untitled,
  openSessionId,
  pinnedShowMore,
}: SessionSectionsInput): SessionSection[] {
  const needle = query.trim().toLocaleLowerCase()
  const matches = (s: SessionSummary) =>
    !needle || (s.title || untitled).toLocaleLowerCase().includes(needle)
  const ordered = [...sessions].sort(newestFirst)
  const known = new Set(groups.map((group) => group.id))
  const groupOf = (s: SessionSummary) =>
    !s.unreadable && s.groupId !== undefined && known.has(s.groupId) ? s.groupId : null

  const pinned = ordered.filter((s) => !s.unreadable && s.pinned && matches(s))
  const recent = ordered.filter(
    (s) => (s.unreadable || (!s.pinned && groupOf(s) === null)) && matches(s),
  )
  const openOutsidePinned = pinned.every((s) => s.id !== openSessionId)
  const expanded = (group: SessionGroup, members: SessionSummary[]) =>
    group.expanded || !!needle || (openOutsidePinned && members.some((s) => s.id === openSessionId))
  const listings = groups
    .map((group) => {
      const members = ordered.filter((s) => groupOf(s) === group.id)
      return {
        listing: { group, sessions: members.filter(matches), expanded: expanded(group, members) },
        newest: members[0],
      }
    })
    .filter(({ listing }) => !needle || listing.sessions.length > 0)
    .sort((a, b) => {
      if (a.newest && b.newest) return newestFirst(a.newest, b.newest)
      if (a.newest || b.newest) return a.newest ? -1 : 1
      return b.listing.group.createdAt - a.listing.group.createdAt
    })
    .map(({ listing }) => listing)

  const result: SessionSection[] = []
  if (pinned.length > 0) {
    result.push(pinnedSection(pinned, needle !== '', openSessionId, pinnedShowMore))
  }
  if (listings.length > 0) result.push({ id: 'groups', groups: listings })
  if (recent.length > 0) result.push({ id: 'recent', sessions: recent })
  return result
}
