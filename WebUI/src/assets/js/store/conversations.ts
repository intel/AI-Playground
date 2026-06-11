import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch, watchEffect } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { AipgUiMessage } from './openAiCompatibleChat'
import { completeOrphanedToolParts } from './toolMessageSanitize'

/**
 * Legacy fixed key for the original singleton Telegram thread. Kept only as a
 * migration token: at hydrate time we backfill `conversationThreadMeta` for it
 * so it shows up as a normal Home Agent thread alongside any newly created
 * remote conversations. Do NOT use this in new code — addressing happens via
 * `homeAgent.activeRemoteConversationKey` and `conversationThreadMeta`.
 */
export const HOME_AGENT_CONVERSATION_KEY = '__aipg_home_agent__'

export const HOME_AGENT_CONVERSATION_TITLE = 'Home Agent'

/**
 * Logical chat preset id for Home Agent inference. Lives in
 * `modes/base/presets/home-agent-chat.json`. Surfaces in the standard chat
 * preset picker: selecting it from `SettingsChat` jumps to the most recent
 * Home Agent conversation; selecting another preset off a Home Agent thread
 * spawns a fresh main conversation.
 */
export const HOME_AGENT_CHAT_PRESET_NAME = 'Home Agent'

export type ThreadKind = 'main' | 'homeAgent'

/**
 * Per-conversation inference profile snapshot. Stamped on every outbound
 * generate/regenerate so the thread is reproducible and "revisit = reactivate"
 * works in the Chat UI.
 */
export type ConversationThreadMeta = {
  presetName: string
  variant?: string | null
  kind?: ThreadKind
}

export type CreateConversationOptions = {
  kind?: ThreadKind
  presetName?: string
  variant?: string | null
}

export const useConversations = defineStore(
  'conversations',
  () => {
    const conversationList = ref<Record<string, AipgUiMessage[]>>({})
    const conversationThreadMeta = ref<Record<string, ConversationThreadMeta>>({})
    /**
     * Per-conversation RAG document selection: conversationKey -> enabled doc
     * hashes. The indexed-document library itself stays shared/global (in
     * `textInference.ragList`); only which documents are *enabled* is scoped to
     * the conversation. A conversation with no entry has nothing enabled, so a
     * brand-new conversation starts without active RAG documents.
     */
    const conversationRagSelection = ref<Record<string, string[]>>({})
    const activeKey = ref('')
    const activeConversation = computed(() => conversationList.value[activeKey.value])

    /**
     * Most-recent main-kind thread the user was on. Mirrors
     * `homeAgent.activeRemoteConversationKey` for the Home Agent side so the
     * Local/Home Agent history switch can restore the user's "last active"
     * conversation per category instead of always snapping to the newest
     * thread by insertion order.
     */
    const lastMainKey = ref<string | null>(null)

    function updateConversation(messages: AipgUiMessage[], conversationKey: string) {
      // Never persist an orphaned tool call (interrupted/stopped turn): it would
      // brick the thread on the next generation. See toolMessageSanitize.ts.
      conversationList.value[conversationKey] = completeOrphanedToolParts(messages)
    }

    function deleteConversation(conversationKey: string) {
      delete conversationList.value[conversationKey]
      delete conversationThreadMeta.value[conversationKey]
      delete conversationRagSelection.value[conversationKey]
    }

    function clearConversation(conversationKey: string) {
      conversationList.value[conversationKey] = []
    }

    function renameConversationTitle(conversationKey: string, newTitle: string) {
      const conversation = conversationList.value[conversationKey]
      if (!conversation || conversation.length === 0) return
      const firstMessage = conversation[0]
      firstMessage.metadata = {
        ...firstMessage.metadata,
        conversationTitle: newTitle,
      }
    }

    function ensureConversationBucket(conversationKey: string) {
      if (!(conversationKey in conversationList.value)) {
        conversationList.value[conversationKey] = []
      }
    }

    function setThreadMeta(conversationKey: string, meta: ConversationThreadMeta) {
      conversationThreadMeta.value[conversationKey] = {
        ...conversationThreadMeta.value[conversationKey],
        ...meta,
      }
    }

    function getThreadMeta(conversationKey: string): ConversationThreadMeta | undefined {
      return conversationThreadMeta.value[conversationKey]
    }

    function getThreadKind(conversationKey: string): ThreadKind {
      return conversationThreadMeta.value[conversationKey]?.kind ?? 'main'
    }

    function getThreadRagHashes(conversationKey: string): string[] {
      return conversationRagSelection.value[conversationKey] ?? []
    }

    function setThreadRagHashes(conversationKey: string, hashes: string[]) {
      conversationRagSelection.value[conversationKey] = [...new Set(hashes)]
    }

    // Keep `lastMainKey` synced with the most recently selected main thread so
    // toggling the history filter back to Local lands on what the user was
    // working in (not just the newest bucket by timestamp).
    watch(
      () => activeKey.value,
      (k) => {
        if (k && conversationList.value[k] && getThreadKind(k) === 'main') {
          lastMainKey.value = k
        }
      },
      { immediate: true },
    )

    /**
     * Allocate a new conversation bucket and (optionally) seed thread metadata.
     * Returns the new conversation key. Used by both the main Chat "+" flow
     * and the Home Agent /new command.
     */
    function createConversation(options: CreateConversationOptions = {}): string {
      const newKey = new Date().getTime().toString()
      conversationList.value[newKey] = []
      if (options.presetName || options.kind) {
        conversationThreadMeta.value[newKey] = {
          presetName: options.presetName ?? '',
          variant: options.variant ?? null,
          kind: options.kind ?? 'main',
        }
      }
      return newKey
    }

    function addNewConversation() {
      const list = conversationList.value
      const newKey = addNewConversationIfLatestIsNotEmpty(
        list,
        undefined,
        conversationThreadMeta.value,
      )
      activeKey.value = newKey
      return newKey
    }

    const isNewConversation = (key: string) => conversationList.value[key].length === 0

    watchEffect(() => {
      if (Object.keys(conversationList.value).includes(activeKey.value)) return
      // Prefer the latest MAIN thread so app launch doesn't drop the user into
      // a Home Agent thread (which would also flip the desktop preset to
      // Home Agent via the activeKey watcher in textInference).
      const keys = Object.keys(conversationList.value)
      const meta = conversationThreadMeta.value
      let fallback: string | undefined
      for (let i = keys.length - 1; i >= 0; i--) {
        if (meta[keys[i]]?.kind === 'homeAgent') continue
        fallback = keys[i]
        break
      }
      if (!fallback) fallback = keys.at(-1)
      if (!fallback) return
      activeKey.value = fallback
    })

    return {
      conversationList,
      conversationThreadMeta,
      conversationRagSelection,
      activeKey,
      activeConversation,
      lastMainKey,
      deleteConversation,
      clearConversation,
      isNewConversation,
      updateConversation,
      renameConversationTitle,
      ensureConversationBucket,
      setThreadMeta,
      getThreadMeta,
      getThreadKind,
      getThreadRagHashes,
      setThreadRagHashes,
      createConversation,
      addNewConversation,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: [
        'conversationList',
        'conversationThreadMeta',
        'conversationRagSelection',
        'lastMainKey',
      ],
      afterHydrate: (ctx) => {
        // Backfill legacy meta first so the helper below can correctly skip
        // Home Agent threads when looking for the "latest empty MAIN" tail.
        backfillLegacyHomeAgentThreadMeta(
          ctx.store.$state.conversationList,
          ctx.store.$state.conversationThreadMeta,
        )
        addNewConversationIfLatestIsNotEmpty(
          ctx.store.$state.conversationList,
          undefined,
          ctx.store.$state.conversationThreadMeta,
        )
      },
    },
  },
)

/**
 * Find or allocate the "current empty main bucket" — i.e. the most recently
 * inserted MAIN-kind conversation, reused when empty so we don't accumulate
 * a long tail of empty drafts.
 *
 * Home Agent threads are intentionally skipped: they form a separate logical
 * list (driven by Telegram /new and the bundled Home Agent preset). Reusing
 * an empty Home Agent thread as "the new main thread" would silently retitle
 * a remote chat AND, via the activeKey watcher in `textInference`, snap the
 * desktop preset back to Home Agent — observable as "first click on another
 * preset bounces back, second click sticks".
 */
function addNewConversationIfLatestIsNotEmpty(
  list: Record<string, AipgUiMessage[]>,
  conversationKey?: string,
  meta?: Record<string, ConversationThreadMeta>,
): string {
  console.log('Checking if new conversation is needed', {
    threadCount: Object.keys(list).length,
    conversationKey,
  })

  const isHomeAgent = (key: string) => meta?.[key]?.kind === 'homeAgent'

  const keys = Object.keys(list)
  let latestMainKey: string | undefined
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = keys[i]
    if (isHomeAgent(k)) continue
    latestMainKey = k
    break
  }

  if (latestMainKey && list[latestMainKey].length === 0) {
    return latestMainKey
  }

  const newKey = new Date().getTime().toString()
  list[newKey] = []
  return newKey
}

/**
 * Migrate the legacy singleton Home Agent thread to the new metadata model so
 * it shows up via `/history` and the desktop history list as a normal Home
 * Agent conversation.
 */
function backfillLegacyHomeAgentThreadMeta(
  list: Record<string, AipgUiMessage[]>,
  meta: Record<string, ConversationThreadMeta>,
) {
  if (!list[HOME_AGENT_CONVERSATION_KEY]) return
  if (meta[HOME_AGENT_CONVERSATION_KEY]?.kind === 'homeAgent') return
  meta[HOME_AGENT_CONVERSATION_KEY] = {
    ...meta[HOME_AGENT_CONVERSATION_KEY],
    presetName: HOME_AGENT_CHAT_PRESET_NAME,
    variant: null,
    kind: 'homeAgent',
  }
}

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useConversations, import.meta.hot))
}
