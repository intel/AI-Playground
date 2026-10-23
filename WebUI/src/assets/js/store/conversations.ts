import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch, watchEffect } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { AipgUiMessage } from './openAiCompatibleChat'
import { completeOrphanedToolParts, sanitizeBulkyToolOutputs } from '@/lib/toolMessageSanitize'
import { currentPresetName } from '@/lib/presetRenames'
import { makeForwardPersist } from '@/lib/ipcPersist'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { useErrors } from './errors'
import type { ConversationBootstrap, ConversationLegacyState } from '@/types/conversationIpc'

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

// The old Pinia-persist key (store id). Read exactly once — the one-shot
// localStorage migration (architecture-target §6.1, step 8) — and removed
// after the kernel has written the files.
const LEGACY_STORAGE_KEY = 'conversations'

export const useConversations = defineStore('conversations', () => {
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

  /** Set once `init()` has hydrated (or migrated) — gates every write-through. */
  const hydrated = ref(false)
  let initPromise: Promise<void> | null = null

  // The kernel owns the files; failures surface through the error sink but
  // never break the live copy — a failed write must not take the thread down.
  const persistMutation = makeForwardPersist({
    code: 'conversations/persist-failed',
    technicalMessage: 'saving a conversation file failed',
  })

  function forwardPersist(call: () => Promise<unknown>): void {
    if (!hydrated.value) return
    persistMutation(call)
  }

  function saveThread(conversationKey: string): void {
    forwardPersist(() =>
      window.electronAPI.conversations.save(
        cloneForIpc({
          id: conversationKey,
          meta: conversationThreadMeta.value[conversationKey] ?? null,
          ragHashes: conversationRagSelection.value[conversationKey] ?? [],
          messages: conversationList.value[conversationKey] ?? [],
          lastMainKey: lastMainKey.value,
        }),
      ),
    )
  }

  function applyConversationMessages(messages: AipgUiMessage[], conversationKey: string) {
    // Never persist an orphaned tool call (interrupted/stopped turn): it would
    // brick the thread on the next generation. See src/lib/toolMessageSanitize.ts.
    conversationList.value[conversationKey] = sanitizeBulkyToolOutputs(
      completeOrphanedToolParts(messages),
    )
  }

  function updateConversation(messages: AipgUiMessage[], conversationKey: string) {
    applyConversationMessages(messages, conversationKey)
    saveThread(conversationKey)
  }

  function deleteConversation(conversationKey: string) {
    delete conversationList.value[conversationKey]
    delete conversationThreadMeta.value[conversationKey]
    delete conversationRagSelection.value[conversationKey]
    forwardPersist(() => window.electronAPI.conversations.delete(conversationKey))
  }

  function clearConversation(conversationKey: string) {
    conversationList.value[conversationKey] = []
    saveThread(conversationKey)
  }

  function renameConversationTitle(conversationKey: string, newTitle: string) {
    const conversation = conversationList.value[conversationKey]
    if (!conversation || conversation.length === 0) return
    const firstMessage = conversation[0]
    firstMessage.metadata = {
      ...firstMessage.metadata,
      conversationTitle: newTitle,
    }
    // The index entry carries the title, so a rename must reach the writer.
    saveThread(conversationKey)
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
    saveThread(conversationKey)
  }

  // Keep `lastMainKey` synced with the most recently selected main thread so
  // toggling the history filter back to Local lands on what the user was
  // working in (not just the newest bucket by timestamp).
  watch(
    () => activeKey.value,
    (k) => {
      if (k && conversationList.value[k] && getThreadKind(k) === 'main') {
        lastMainKey.value = k
        forwardPersist(() => window.electronAPI.conversations.saveLastMainKey(k))
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
    // Home Agent threads are addressable from the channel before their first
    // message (`/history` lists them), so they persist immediately. A main
    // draft stays in memory until it has content to write.
    if (options.kind === 'homeAgent') saveThread(newKey)
    return newKey
  }

  function addNewConversation() {
    const list = conversationList.value
    const newKey = addNewConversationIfLatestIsNotEmpty(list, conversationThreadMeta.value)
    activeKey.value = newKey
    return newKey
  }

  const isNewConversation = (key: string) => conversationList.value[key].length === 0

  // ── Hydration (step 8, architecture-target §6.1) ──────────────────────────────
  //
  // The kernel owns the durable copy (`AI-Playground/conversations/`); this
  // store is the live projection. `init()` runs once before the app mounts,
  // so a resumed stream or the history panel never sees a half-hydrated map.

  function hydrateFrom(bootstrap: ConversationBootstrap): void {
    if (bootstrap.status !== 'ok') return
    const list: Record<string, AipgUiMessage[]> = {}
    const meta: Record<string, ConversationThreadMeta> = {}
    const rag: Record<string, string[]> = {}
    for (const thread of bootstrap.threads) {
      list[thread.id] = thread.messages as AipgUiMessage[]
      if (thread.meta) meta[thread.id] = thread.meta
      if (thread.ragHashes.length > 0) rag[thread.id] = thread.ragHashes
    }
    conversationList.value = list
    conversationThreadMeta.value = meta
    conversationRagSelection.value = rag
    if (bootstrap.lastMainKey) lastMainKey.value = bootstrap.lastMainKey
  }

  /** Read the legacy Pinia-persisted state, if any, for the one-shot upload. */
  function readLegacyState(): ConversationLegacyState | null {
    const raw = demoAwareStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Partial<ConversationLegacyState>
      if (!parsed || typeof parsed !== 'object' || !parsed.conversationList) return null
      return {
        conversationList: parsed.conversationList,
        conversationThreadMeta: parsed.conversationThreadMeta ?? {},
        conversationRagSelection: parsed.conversationRagSelection ?? {},
        lastMainKey: parsed.lastMainKey ?? null,
      }
    } catch {
      return null
    }
  }

  async function init(): Promise<void> {
    if (initPromise) return initPromise
    initPromise = (async () => {
      const errors = useErrors()
      let bootstrap: ConversationBootstrap | { status: 'error'; error: string } | null = null
      let bootstrapError: unknown = null
      try {
        bootstrap = await window.electronAPI.conversations.bootstrap()
        // One-shot legacy migration (§6.1: "localStorage migrates once"): a
        // first boot with no index uploads whatever the old persisted state
        // held, then drops the key so it never runs or dual-writes again.
        if (
          bootstrap.status === 'empty' ||
          (bootstrap.status === 'ok' && bootstrap.threads.length === 0)
        ) {
          const legacy = readLegacyState()
          if (legacy && Object.keys(legacy.conversationList).length > 0) {
            bootstrap = await window.electronAPI.conversations.migrate(legacy)
          }
        }
        // Files own the threads: drop the Pinia key. Keep it when migrate
        // failed so the next boot can retry.
        if (
          bootstrap.status === 'ok' ||
          (bootstrap.status === 'empty' && demoAwareStorage.getItem(LEGACY_STORAGE_KEY))
        ) {
          demoAwareStorage.removeItem(LEGACY_STORAGE_KEY)
        }
      } catch (error) {
        bootstrap = null
        bootstrapError = error
      }
      if (!bootstrap) {
        errors.report(bootstrapError ?? new Error('conversation bootstrap IPC failed'), {
          code: 'conversations/bootstrap-failed',
          category: 'backend',
          severity: 'warning',
          surface: 'silent',
          technicalMessage: 'the file store did not answer; history may be empty this session',
        })
      } else if (bootstrap.status === 'error') {
        errors.report(new Error(bootstrap.error), {
          code: 'conversations/bootstrap-failed',
          category: 'backend',
          severity: 'warning',
          surface: 'silent',
          technicalMessage: 'the file store rejected the boot hydration',
        })
        bootstrap = null
      }
      if (bootstrap) hydrateFrom(bootstrap)

      // Backfill legacy meta first so the helper below can correctly skip
      // Home Agent threads when looking for the "latest empty MAIN" tail.
      backfillLegacyHomeAgentThreadMeta(conversationList.value, conversationThreadMeta.value)
      // A thread names the preset it was held with; a renamed preset no longer
      // answers to that name, which would leave the thread's preset unresolved.
      followRenamedPresets(conversationThreadMeta.value)
      // A session always opens on an empty main draft; it materializes on
      // disk with its first content.
      addNewConversationIfLatestIsNotEmpty(conversationList.value, conversationThreadMeta.value)
      hydrated.value = true
    })()
    return initPromise
  }

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
    hydrated,
    init,
    deleteConversation,
    clearConversation,
    isNewConversation,
    updateConversation,
    applyConversationMessages,
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
})

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
  meta?: Record<string, ConversationThreadMeta>,
): string {
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

/**
 * Point threads stamped with a preset's former name at the name it ships with
 * now. Reopening such a thread applies its preset (see the `activeKey` watcher
 * in `textInference`), which does nothing when the stored name matches no preset.
 */
function followRenamedPresets(meta: Record<string, ConversationThreadMeta>) {
  for (const entry of Object.values(meta)) {
    if (entry.presetName) entry.presetName = currentPresetName(entry.presetName)
  }
}

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useConversations, import.meta.hot))
}
