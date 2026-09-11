import { z } from 'zod'
import { useConversations } from '../store/conversations'

// The conversation a tool call belongs to is provided per tool via the
// `toolsContext` option of streamText (set in openAiCompatibleChat), typed on
// each tool through `contextSchema`. Used to scope activities/status and inline
// confirmation cards to the right chat turn (desktop or Home Agent side-channel).
export const ToolConversationContextSchema = z.object({
  conversationKey: z.string().optional(),
})

export type ToolConversationContext = z.infer<typeof ToolConversationContextSchema>

export function conversationKeyFor(context: ToolConversationContext | undefined): string {
  return context?.conversationKey ?? useConversations().activeKey
}
