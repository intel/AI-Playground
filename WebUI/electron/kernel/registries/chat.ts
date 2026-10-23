import type { ChatInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import { ipcFail } from '../typedIpc'
import type { handleChatAnswer } from '../../chat/chatAsk'
import type { summarizeConversationText } from '../../chat/chatSummarize'
import type { cancelChatTurn, resumeChatTurn, submitChatTurn } from '../../chat/turnEngine'

/** The turn-engine and ask seams the five chat handlers close over. */
export type ChatDeps = {
  submitChatTurn: typeof submitChatTurn
  resumeChatTurn: typeof resumeChatTurn
  cancelChatTurn: typeof cancelChatTurn
  handleChatAnswer: typeof handleChatAnswer
  summarizeConversationText: typeof summarizeConversationText
}

export function buildChatRegistry(deps: ChatDeps) {
  // Chat turns run in main (architecture-target §8 step 6); the renderer
  // submits/resumes/cancels over IPC and receives the stream as kernel
  // chat-chunk events, answering `chat:ask` when a tool needs the window.
  return {
    'chat:submitTurn': (_event, request) => {
      try {
        return { success: true as const, turnId: deps.submitChatTurn(request).turnId }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'chat:resumeTurn': (_event, conversationKey) => {
      const resumed = deps.resumeChatTurn(conversationKey)
      return resumed
        ? { success: true as const, active: true, ...resumed }
        : { success: true as const, active: false as const }
    },
    'chat:cancelTurn': (_event, conversationKey, turnId) => {
      deps.cancelChatTurn(conversationKey, turnId)
      return { success: true as const }
    },
    'chat:answer': (_event, payload) => {
      deps.handleChatAnswer(payload)
    },
    // One-shot title summarization, model call included (step 6).
    'chat:summarize': async (_event, request) => {
      try {
        return { success: true as const, data: await deps.summarizeConversationText(request) }
      } catch (e) {
        return ipcFail(e)
      }
    },
  } satisfies InvokeHandlerMap<ChatInvokeName>
}
