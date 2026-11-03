import { getSessionHistoryEntry, listSessionHistory } from '../session/sessionUpdate'

export const CHAT_SESSION_HISTORY_TOOL = 'session_history'

type SessionHistoryInput = {
  action?: string
  preset?: string
  limit?: number
  offset?: number
  id?: string
}

/** A tool-enabled chat preset's `session_history`: the same bodies the agent presets get. */
export async function executeChatSessionHistoryTool(
  sessionRef: string,
  input: unknown,
): Promise<unknown> {
  const { action, preset, limit, offset, id } = (input ?? {}) as SessionHistoryInput
  if (action === 'list') {
    return { entries: await listSessionHistory(sessionRef, { preset, limit, offset }) }
  }
  if (action === 'get') {
    if (!id) return { success: false, message: 'Provide the id of the entry to get.' }
    const entry = await getSessionHistoryEntry(sessionRef, id)
    return entry ?? { success: false, message: `No History Entry with id ${id}.` }
  }
  return { success: false, message: 'Unknown action: use `list` or `get`.' }
}
