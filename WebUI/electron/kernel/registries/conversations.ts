import {
  ConversationLegacyStateSchema,
  ConversationSaveRequestSchema,
} from '@/types/conversationIpc'
import type { ConversationsInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import { ipcErrorText, ipcFail } from '../typedIpc'
import type {
  bootstrapConversations,
  deleteConversation,
  migrateLegacyConversations,
  saveConversation,
  saveConversationLastMainKey,
} from '../../persist/conversationFiles'

/** The one-writer thread operations the five conversations handlers close over. */
export type ConversationsDeps = {
  bootstrapConversations: typeof bootstrapConversations
  migrateLegacyConversations: typeof migrateLegacyConversations
  saveConversation: typeof saveConversation
  deleteConversation: typeof deleteConversation
  saveConversationLastMainKey: typeof saveConversationLastMainKey
}

export function buildConversationsRegistry(deps: ConversationsDeps) {
  // Conversation persistence (step 8, architecture-target §6.1): the kernel
  // is the one writer of the user's threads. Hydration and the one-shot
  // legacy upload return data; the mutations follow the {success} convention.
  return {
    'conversations:bootstrap': async () => {
      try {
        return await deps.bootstrapConversations()
      } catch (e) {
        return { status: 'error' as const, error: ipcErrorText(e) }
      }
    },
    'conversations:migrate': async (_event, payload) => {
      try {
        return await deps.migrateLegacyConversations(ConversationLegacyStateSchema.parse(payload))
      } catch (e) {
        return { status: 'error' as const, error: ipcErrorText(e) }
      }
    },
    'conversations:save': async (_event, payload) => {
      try {
        await deps.saveConversation(ConversationSaveRequestSchema.parse(payload))
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'conversations:delete': async (_event, id) => {
      try {
        if (typeof id !== 'string') throw new Error('conversation id must be a string')
        await deps.deleteConversation(id)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'conversations:saveLastMainKey': async (_event, key) => {
      try {
        if (typeof key !== 'string' && key !== null) {
          throw new Error('lastMainKey must be a string or null')
        }
        await deps.saveConversationLastMainKey(key)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
  } satisfies InvokeHandlerMap<ConversationsInvokeName>
}
