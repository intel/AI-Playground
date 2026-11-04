import type { HistoryEntry, SessionFile } from '@/types/sessionIpc'

const TITLE_LIMIT = 60

export type TitleSource = Pick<HistoryEntry, 'kind' | 'preset' | 'prompt' | 'response'>

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= TITLE_LIMIT ? flat : `${flat.slice(0, TITLE_LIMIT - 1).trimEnd()}…`
}

/** The Title a Session gets from its first History Entry; Speech-to-Text is named by what was said. */
export function autoTitle(first: TitleSource): string {
  const text = (first.kind === 'stt' && first.response) || first.prompt
  return shorten(text) || first.preset
}

/** A settled turn adds its preset, and titles only a Session with neither a Name nor a Title. */
export function afterTurn(
  current: SessionFile,
  turn: TitleSource,
): Pick<SessionFile, 'title' | 'presetsUsed'> {
  return {
    title: current.renamed || current.title ? current.title : autoTitle(turn),
    presetsUsed: current.presetsUsed.includes(turn.preset)
      ? current.presetsUsed
      : [...current.presetsUsed, turn.preset],
  }
}
