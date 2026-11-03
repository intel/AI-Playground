import { tool } from 'ai'
import { z } from 'zod'

// Schema + description only. The bodies run in main
// (`electron/chat/chatSessionHistoryTool.ts`) against the turn's Session.

export const sessionHistory = tool({
  description:
    'Read the Session History: every turn any preset took in this Session (image ' +
    'generation, edits, chat, agents), with its prompt, response and the files it ' +
    'produced. Use it when the Session Update in a message is not enough.',
  inputSchema: z.object({
    action: z
      .enum(['list', 'get'])
      .describe('`list` entries newest first, or `get` one entry in full by id.'),
    preset: z.string().optional().describe('list: only entries of this preset.'),
    limit: z.number().int().min(1).optional().describe('list: how many entries (default 20).'),
    offset: z.number().int().min(0).optional().describe('list: how many newest entries to skip.'),
    id: z.string().optional().describe('get: the entry id from `list`.'),
  }),
})
