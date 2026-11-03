import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { loadPi } from './piRuntime.ts'
import { jsonResult, jsonSchemaParameters, textResult } from './piCustomTools.ts'
import { getSessionHistoryEntry, listSessionHistory } from '../session/sessionUpdate.ts'

export const SESSION_HISTORY_TOOL = 'session_history'

const SESSION_HISTORY_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'get'],
      description: '`list` entries newest first, or `get` one entry in full by id.',
    },
    preset: { type: 'string', description: 'list: only entries of this preset.' },
    limit: { type: 'integer', minimum: 1, description: 'list: how many entries (default 20).' },
    offset: { type: 'integer', minimum: 0, description: 'list: how many newest entries to skip.' },
    id: { type: 'string', description: 'get: the entry id from `list`.' },
  },
  required: ['action'],
}

type SessionHistoryParams = {
  action?: string
  preset?: string
  limit?: number
  offset?: number
  id?: string
}

/** Every agent preset's Harness Session in a Session gets this; it is not a capability. */
export async function buildSessionHistoryTool(
  sessionRef: string,
  workspaceDir: string,
): Promise<ToolDefinition> {
  const pi = await loadPi()
  return pi.defineTool({
    name: SESSION_HISTORY_TOOL,
    label: SESSION_HISTORY_TOOL,
    description:
      'Read the Session History: every turn any preset took in this Session (image ' +
      'generation, edits, chat, other agents), with its prompt, response and the files it ' +
      'produced. Use it when the Session Update in a message is not enough.',
    parameters: jsonSchemaParameters(SESSION_HISTORY_SCHEMA),
    execute: async (_toolCallId, params) => {
      const { action, preset, limit, offset, id } = params as SessionHistoryParams
      if (action === 'list') {
        return jsonResult(await listSessionHistory(sessionRef, { preset, limit, offset }))
      }
      if (action === 'get') {
        if (!id) return textResult('Provide the id of the entry to get.')
        const entry = await getSessionHistoryEntry(sessionRef, id, workspaceDir)
        return entry ? jsonResult(entry) : textResult(`No History Entry with id ${id}.`)
      }
      return textResult('Unknown action: use `list` or `get`.')
    },
  })
}
