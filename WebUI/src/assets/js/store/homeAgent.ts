import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, reactive, computed, watch } from 'vue'
import type { FileUIPart } from 'ai'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices } from './backendServices'
import { useOpenAiCompatibleChat, type AipgUiMessage } from './openAiCompatibleChat'
import { useImageGenerationPresets, isImage, isVideo, is3D } from './imageGenerationPresets'
import { usePromptStore } from './promptArea'
import { usePresetSwitching } from './presetSwitching'
import { usePresets } from './presets'
// Lazy-instantiated inside helpers to avoid a setup-time cycle with textInference,
// which already instantiates useHomeAgent() at the top of its own setup.
import { useTextInference } from './textInference'
import { useSpeechToText } from './speechToText'
import { useTextToSpeech } from './textToSpeech'
import { base64ToBlob, transcribeAudioBlob } from '@/lib/transcribe'
import { synthesizeSpeech, bytesToBase64 } from '@/lib/synthesizeSpeech'
import {
  useConversations,
  HOME_AGENT_CONVERSATION_KEY,
  HOME_AGENT_CONVERSATION_TITLE,
  HOME_AGENT_CHAT_PRESET_NAME,
} from './conversations'
import { saveImageToMediaInput } from '@/lib/utils'
import { render3dThumbnail } from '@/lib/render3dThumbnail'
import * as toast from '../toast'
import {
  CHANNEL_FIELD_SPEC,
  type ChannelConfig,
  type ChannelKind,
  type ChannelPrefs,
  type ChannelRuntimeState,
  type InboundMeta,
  type RemoteImage,
  type RemoteAudio,
  type KeyboardButton,
  type ChannelQueueItem,
} from './channels/types'
import type { ChannelAdapter, RawPart } from './channels/adapter'
import { escapeHtml } from './channels/adapterHelpers'
import { createTelegramAdapter } from './channels/telegramAdapter'
import { createSlackAdapter } from './channels/slackAdapter'

// ── Channel registry ────────────────────────────────────────────────────────
// Kinds we manage in this store. Adding a third one means appending to this
// list and dropping in a new adapter — no other edits to this file.
const KINDS = ['telegram', 'slack'] as const satisfies readonly ChannelKind[]

/**
 * Pending state for the interactive `/imgGen` preset picker.
 * `awaitingPresetTap` is set after the user runs `/imgGen` until they tap
 * a preset (or Cancel). `awaitingPrompt` is set after a preset is chosen
 * until the user sends the next plain-text message as the prompt.
 */
type ImgGenPending =
  | { phase: 'awaitingPresetTap'; cachedPrompt: string; deadline: number }
  | { phase: 'awaitingPrompt'; presetName: string; deadline: number }

const POLL_INTERVAL_MS = 2000
const MAX_QUEUE_SIZE = 20
const IMGGEN_PENDING_TIMEOUT_MS = 5 * 60_000
const IMG_GEN_TIMEOUT_MS = 120_000

/** Module-level so Vite HMR does not orphan intervals across Pinia setup
 *  closures. Indexed by ChannelKind so adding a kind = one map entry. */
const pollIntervalIds: Partial<Record<ChannelKind, ReturnType<typeof setInterval>>> = {}
const drainBusyByKind: Partial<Record<ChannelKind, boolean>> = {}

function disposePoll(kind: ChannelKind) {
  const id = pollIntervalIds[kind]
  if (id !== undefined) {
    clearInterval(id)
    delete pollIntervalIds[kind]
  }
}

function disposeAllPollHandlers() {
  for (const kind of KINDS) disposePoll(kind)
}

function emptyRuntimeState(kind: ChannelKind): ChannelRuntimeState {
  return {
    kind,
    config: {},
    active: false,
  }
}

function emptyPrefs(): ChannelPrefs {
  return { verified: false, identity: null, enabled: false }
}

function extractAssistantReply(messages: AipgUiMessage[] | undefined): string | null {
  if (!messages || messages.length === 0) return null
  const last = messages[messages.length - 1]
  if (last.role !== 'assistant') return null
  const text = (last.parts as { type: string; text?: string }[])
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
  return text || null
}

export const useHomeAgent = defineStore(
  'homeAgent',
  () => {
    const backendServices = useBackendServices()
    const chatStore = useOpenAiCompatibleChat()
    const imageGenStore = useImageGenerationPresets()
    const promptStore = usePromptStore()
    const presetSwitching = usePresetSwitching()
    const conversations = useConversations()
    const presetsStore = usePresets()

    /**
     * Mirrors `isHomeAgentEnabled` from settings.json. Hydrated once on store
     * setup. When false, every Home Agent surface (UI, polling, auto-activate)
     * is held inert — defense in depth on top of the main process refusing to
     * register the backend / IPC handlers / preset.
     */
    const isFeatureEnabled = ref(false)

    /**
     * Master Home Agent on/off — the single title-bar toggle. Persisted so the
     * agent resumes (or stays off) across restarts. A channel only runs when
     * the master is on AND the channel itself is enabled + verified.
     */
    const masterEnabled = ref(true)

    /**
     * Persisted, non-secret per-channel preferences (verified / identity /
     * enabled). Kept separate from `channels` so Pinia can persist it wholesale
     * without ever serializing the in-memory secret `config`. This is the
     * source of truth for "is this channel set up and wanted"; `channels[kind]`
     * holds only runtime state (secrets + derived `active`).
     */
    const channelPrefs = reactive<Record<ChannelKind, ChannelPrefs>>({
      telegram: emptyPrefs(),
      slack: emptyPrefs(),
      discord: emptyPrefs(),
    })

    // Runtime-only per-channel state (secret config + derived `active`). Never
    // persisted; rebuilt on launch from safeStorage + channelPrefs.
    const channels = reactive<Record<ChannelKind, ChannelRuntimeState>>({
      telegram: emptyRuntimeState('telegram'),
      slack: emptyRuntimeState('slack'),
      discord: emptyRuntimeState('discord'),
    })

    // Per-channel message queues — `channels[kind].active` flips the polling
    // on/off but the queues live here so HMR doesn't lose in-flight messages.
    const messageQueues = {
      telegram: [] as ChannelQueueItem[],
      slack: [] as ChannelQueueItem[],
      discord: [] as ChannelQueueItem[],
    } satisfies Record<ChannelKind, ChannelQueueItem[]>

    // Adapter instances — one per kind. Created at setup time; their methods
    // close over the IPC bridge so the renderer always uses the same adapter
    // identity (matters for the draft-stream cache the streaming code uses).
    const adapters: Record<ChannelKind, ChannelAdapter | null> = {
      telegram: createTelegramAdapter(),
      slack: createSlackAdapter(),
      discord: null, // populated when Discord lands
    }

    /**
     * Conversation key remote traffic currently routes into. `null` means
     * "create one on first use" — covers fresh installs and post-`/new`
     * sessions before the user sends anything. Single global because the UI
     * only ever shows one Home Agent thread at a time regardless of which
     * channel posted into it.
     */
    const activeRemoteConversationKey = ref<string | null>(null)

    /** All conversation keys whose meta marks them as Home Agent threads. */
    const remoteConversationKeys = computed(() =>
      Object.entries(conversations.conversationThreadMeta)
        .filter(([_, meta]) => meta?.kind === 'homeAgent')
        .map(([key]) => key),
    )

    /**
     * Pending state for the interactive `/imgGen` flow. Not persisted —
     * picker sessions are short-lived (5-minute timeout) and re-routing the
     * preset choice across restarts would surprise the user.
     */
    const pendingImgGen = ref<ImgGenPending | null>(null)

    /** Visibility flag for the dedicated Home Agent inference settings panel. */
    const showSettings = ref(false)

    function openSettings(): void {
      showSettings.value = true
    }

    function closeSettings(): void {
      showSettings.value = false
    }

    /**
     * Per-thread summary cache for the bare `/load` menu. Keyed by conversation
     * key; entries are invalidated whenever the conversation grows (we compare
     * `messageCount` so any new turn forces a re-summarize on the next /load).
     * Persisted so summaries survive app restarts.
     */
    const summaryCache = ref<Record<string, { messageCount: number; summary: string }>>({})

    // Umbrella "currently fielding remote traffic" flag — true if any channel
    // is on. Many existing call sites (textInference, …) treat this as "are we
    // serving a remote chat right now?" — keep that semantic.
    const isHomeAgentActive = computed(() => KINDS.some((k) => channels[k].active))

    const isAvailable = computed(
      () =>
        isFeatureEnabled.value &&
        backendServices.info.find((s) => s.serviceName === 'home-agent-backend')?.status ===
          'running',
    )

    const homeAgentBaseUrl = computed(
      () => backendServices.info.find((s) => s.serviceName === 'home-agent-backend')?.baseUrl,
    )

    /**
     * Single source of activation truth. A channel is active iff the backend
     * is available, the master switch is on, and the channel is both enabled
     * (user pref) and verified. Runs immediately (and deeply) so that on
     * launch — once Pinia has restored `masterEnabled` / `channelPrefs` and the
     * backend reports running — previously-on channels resume polling without
     * any user action.
     */
    function recomputeActive() {
      for (const kind of KINDS) {
        channels[kind].active =
          isAvailable.value &&
          masterEnabled.value &&
          channelPrefs[kind].enabled &&
          channelPrefs[kind].verified
      }
    }
    watch(
      [
        isAvailable,
        masterEnabled,
        () => KINDS.map((k) => channelPrefs[k].enabled),
        () => KINDS.map((k) => channelPrefs[k].verified),
      ],
      recomputeActive,
      { immediate: true, deep: true },
    )

    // When the backend + channel credentials are ready, inject so the bot
    // starts (or restarts if creds changed). One watcher per kind so each
    // can decide its own "credentials ready" predicate without coupling.
    for (const kind of KINDS) {
      watch(
        [isAvailable, () => channels[kind].config, () => channelPrefs[kind].identity],
        ([avail, config, identity]) => {
          if (!avail) return
          // Readiness + identity threading are fully data-driven via
          // CHANNEL_FIELD_SPEC — no per-kind branching. A channel injects once
          // every required secret is present; the identity (chatId / userId /
          // …) is folded back into its config key if missing.
          const spec = CHANNEL_FIELD_SPEC[kind]
          const payload: Record<string, string | undefined> = {
            ...(config as Record<string, string>),
          }
          if (spec.requiredSecrets.some((field) => !payload[field])) return
          if (identity && !payload[spec.identityField]) {
            payload[spec.identityField] = identity ?? undefined
          }
          void window.electronAPI.homeAgent.channel
            .inject(kind, payload)
            .catch((e: unknown) => console.error(`homeAgent: inject(${kind}) failed:`, e))
        },
        { flush: 'post', immediate: true, deep: true },
      )

      // Per-channel polling lifecycle.
      watch(
        () => channels[kind].active,
        (val) => {
          if (val) {
            startPolling(kind)
          } else {
            stopPolling(kind)
          }
        },
      )
    }

    // When the user selects a Home Agent thread from the desktop UI (e.g. the
    // HistoryChat list), mirror that into `activeRemoteConversationKey` so the
    // channel bridge keeps routing into the same conversation.
    watch(
      () => conversations.activeKey,
      (k) => {
        if (k && conversations.getThreadKind(k) === 'homeAgent') {
          activeRemoteConversationKey.value = k
        }
      },
    )

    const IMG_GEN_REGEX = /^\/imgGen\s*/i
    const CHAT_REGEX = /^\/chat\s*/i
    const HELP_REGEX = /^\/help$/i
    const CANCEL_REGEX = /^\/cancel\s*$/i
    const NEW_REGEX = /^\/new\s*$/i
    const HISTORY_REGEX = /^\/history\s*$/i
    const LOAD_REGEX = /^\/load\s+(\S+)\s*$/i
    const LOAD_BARE_REGEX = /^\/load\s*$/i

    const HELP_MESSAGE =
      '🤖 <b>Available commands</b>\n\n' +
      '/imgGen\n' +
      'Open the image-generation picker. Tap a preset, then send your prompt as the next message.\n' +
      'You can also pre-fill the prompt with <code>/imgGen </code><i>&lt;prompt&gt;</i> — after you tap a preset the image generates immediately.\n\n' +
      '/cancel\n' +
      'Cancel a pending /imgGen flow (or tap the ✖ Cancel button on the picker).\n\n' +
      '<code>/chat </code><i>&lt;message&gt;</i>\n' +
      'Force a text chat reply (no image generation).\n\n' +
      '/new\n' +
      'Start a fresh chat thread. Subsequent messages go into it.\n\n' +
      '/history\n' +
      'List your saved Home Agent chat threads.\n\n' +
      '/load\n' +
      'Pick a recent chat from a tappable menu (the bot summarizes each one).\n\n' +
      '<code>/load </code><i>&lt;id&gt;</i>\n' +
      'Resume a specific chat. Use the id from <code>/history</code>.\n\n' +
      '/help\n' +
      'Show this help message.\n\n' +
      'Any other message is handled by the AI in <b>agentic mode</b>: it decides whether to reply with text or generate an image based on your request.\n\n' +
      '📷 <b>Photos</b>\n' +
      'Send a photo (with or without a caption) and the AI will answer based on what it sees. ' +
      'Requires a <b>vision-capable model</b> selected in Chat settings.\n\n' +
      '🎙️ <b>Voice messages</b>\n' +
      'Send a voice note or audio file and it will be transcribed and handled like a typed message. ' +
      'Requires Speech To Text (OVMS) enabled, or a fallback transcription endpoint configured in Settings.\n' +
      'When Text To Speech is enabled, the reply to a voice message is also sent back as a voice message.'

    function resolveLoadTarget(idArg: string): string | null {
      const items = listRemoteConversations()
      // Allow either the 1-based index from /history or the raw conversation key.
      const asIndex = Number.parseInt(idArg, 10)
      if (Number.isFinite(asIndex) && asIndex >= 1 && asIndex <= items.length) {
        return items[asIndex - 1].key
      }
      const direct = items.find((i) => i.key === idArg)
      return direct?.key ?? null
    }

    function homeAgentTitleFor(key: string): string {
      // Legacy singleton keeps its historical title for continuity.
      if (key === HOME_AGENT_CONVERSATION_KEY) return HOME_AGENT_CONVERSATION_TITLE
      const stamp = new Date(Number(key)).toLocaleString(undefined, {
        year: '2-digit',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
      return `Home Agent - ${stamp}`
    }

    function maybeSetHomeAgentConversationTitle(key: string | null) {
      if (!key) return
      const msgs = conversations.conversationList[key]
      const first = msgs?.[0]
      if (first && !first.metadata?.conversationTitle) {
        conversations.renameConversationTitle(key, homeAgentTitleFor(key))
      }
    }

    /**
     * Allocate a brand-new Home Agent conversation, mark it as the routing
     * target for new remote messages, and return its key. If the most-recent
     * Home Agent conversation is still empty, reuse it instead of stacking
     * empty buckets.
     */
    function createNewRemoteConversation(): string {
      const existingEmpty = remoteConversationKeys.value.find(
        (k) => (conversations.conversationList[k] ?? []).length === 0,
      )
      if (existingEmpty) {
        activeRemoteConversationKey.value = existingEmpty
        return existingEmpty
      }
      const newKey = conversations.createConversation({
        kind: 'homeAgent',
        presetName: HOME_AGENT_CHAT_PRESET_NAME,
      })
      activeRemoteConversationKey.value = newKey
      return newKey
    }

    /** Switch which Home Agent thread remote messages route into. */
    function switchRemoteConversation(key: string): boolean {
      const meta = conversations.getThreadMeta(key)
      if (meta?.kind !== 'homeAgent') return false
      activeRemoteConversationKey.value = key
      return true
    }

    function ensureActiveRemoteConversation(): string {
      const current = activeRemoteConversationKey.value
      if (current && conversations.conversationList[current]) return current
      // Adopt the legacy singleton if it exists with content; otherwise allocate fresh.
      if (
        conversations.conversationList[HOME_AGENT_CONVERSATION_KEY] &&
        (conversations.conversationList[HOME_AGENT_CONVERSATION_KEY]?.length ?? 0) > 0
      ) {
        activeRemoteConversationKey.value = HOME_AGENT_CONVERSATION_KEY
        return HOME_AGENT_CONVERSATION_KEY
      }
      return createNewRemoteConversation()
    }

    function listRemoteConversations(): Array<{
      key: string
      title: string
      messageCount: number
      isActive: boolean
    }> {
      const entries = remoteConversationKeys.value.map((key) => {
        const msgs = conversations.conversationList[key] ?? []
        const titleFromMeta = msgs[0]?.metadata?.conversationTitle as string | undefined
        return {
          key,
          title: titleFromMeta || homeAgentTitleFor(key),
          messageCount: msgs.length,
          isActive: key === activeRemoteConversationKey.value,
        }
      })
      // Most recent first. Numeric timestamp keys sort by their integer value
      // so newer chats land on top; the legacy singleton string key parses to
      // NaN → 0 so it falls to the bottom.
      return entries.sort((a, b) => (parseInt(b.key) || 0) - (parseInt(a.key) || 0))
    }

    /** Show Chat view on the active Home Agent thread so remote traffic is visible. */
    function focusRemoteChatDiscussion() {
      const key = ensureActiveRemoteConversation()
      conversations.ensureConversationBucket(key)
      conversations.activeKey = key
      promptStore.setModeOnly('chat')
    }

    /** Flatten the last 5 messages of a conversation into a "User: …" /
     *  "Assistant: …" transcript suitable for one-shot summarization. */
    function flattenForSummary(messages: AipgUiMessage[]): string {
      const last5 = messages.slice(-5)
      return last5
        .map((m) => {
          const role = m.role === 'user' ? 'User' : 'Assistant'
          const body = (m.parts as { type: string; text?: string }[])
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map((p) => p.text)
            .join(' ')
            .trim()
          return body ? `${role}: ${body}` : ''
        })
        .filter(Boolean)
        .join('\n')
    }

    async function summarizeConversation(key: string): Promise<string> {
      const msgs = chatStore.getMessagesForKey(key) ?? conversations.conversationList[key] ?? []
      if (msgs.length === 0) return 'Empty chat'

      const cached = summaryCache.value[key]
      if (cached && cached.messageCount === msgs.length) return cached.summary

      const transcript = flattenForSummary(msgs)
      if (!transcript) return 'Untitled chat'

      try {
        const summary = await chatStore.summarizeMessages(transcript)
        const clean = summary || 'Untitled chat'
        summaryCache.value[key] = { messageCount: msgs.length, summary: clean }
        return clean
      } catch (e) {
        console.error('homeAgent: summarizeConversation failed:', e)
        return 'Untitled chat'
      }
    }

    // ── Channel-dispatch helpers ─────────────────────────────────────────────
    // All handler bodies funnel outbound traffic through these small wrappers
    // so the same logic services every channel without duplicating the slash-
    // command + image-gen pipelines.

    async function reply(adapter: ChannelAdapter, htmlSnippet: string, meta?: InboundMeta) {
      return adapter.reply(adapter.formatRichSnippet(htmlSnippet), meta)
    }

    async function replyMarkdown(adapter: ChannelAdapter, md: string, meta?: InboundMeta) {
      return adapter.reply(adapter.formatMarkdown(md), meta)
    }

    /**
     * Send a synthesized voice reply when the inbound message was itself a
     * voice message and Text To Speech is enabled. Best-effort: failures are
     * logged and never break the (already-delivered) text reply.
     */
    async function maybeSendVoiceReply(
      adapter: ChannelAdapter,
      text: string,
      fromVoice: boolean,
      meta?: InboundMeta,
    ): Promise<void> {
      if (!fromVoice) return
      const trimmed = (text ?? '').trim()
      if (!trimmed) return
      const textToSpeech = useTextToSpeech()
      if (!textToSpeech.enabled || !textToSpeech.autoSpeakOnVoiceInput) return

      try {
        const endpoint = await textToSpeech.resolveSpeech()
        if (!endpoint) return
        // Request opus so Telegram renders a real voice bubble; servers that
        // don't support it fall back to wav inside synthesizeSpeech. Pass the
        // actual returned media type so the channel labels the file correctly.
        const { bytes, mediaType } = await synthesizeSpeech(trimmed, endpoint, { format: 'opus' })
        const base64 = bytesToBase64(bytes)
        await adapter.voice(base64, mediaType || 'audio/ogg', meta)
      } catch (e) {
        console.error('homeAgent: voice reply failed:', e)
      }
    }

    async function keyboard(
      adapter: ChannelAdapter,
      htmlIntro: string,
      buttons: KeyboardButton[][],
      meta?: InboundMeta,
    ) {
      return adapter.keyboard(adapter.formatRichSnippet(htmlIntro), buttons, meta)
    }

    async function photo(
      adapter: ChannelAdapter,
      base64: string,
      caption: string,
      meta?: InboundMeta,
    ) {
      return adapter.photo(base64, caption, meta)
    }

    function typing(adapter: ChannelAdapter, action: string, meta?: InboundMeta): () => void {
      return adapter.startTypingHeartbeat(action, meta)
    }

    function draftStream(adapter: ChannelAdapter, meta?: InboundMeta) {
      return adapter.createDraftStream(meta)
    }

    /**
     * Pin the live preset/backend to Home Agent and prep inference so the
     * summarizer uses the bundled Home Agent model. Returns `false` and
     * replies to the active channel with an error if readiness fails.
     */
    async function ensureSummarizerReady(
      adapter: ChannelAdapter,
      meta?: InboundMeta,
    ): Promise<boolean> {
      const textInference = useTextInference()
      // Snapshot the user's currently selected desktop preset/variant so we
      // can restore them after transiently switching to the Home Agent
      // preset for summarization.
      const previousPreset = presetsStore.activePresetName
      const previousVariant = previousPreset
        ? (presetsStore.activeVariantName[previousPreset] ?? null)
        : null
      textInference.applyPresetToGlobals(HOME_AGENT_CHAT_PRESET_NAME, null)
      try {
        await textInference.ensureReadyForInference()
        return true
      } catch (e) {
        console.error('homeAgent: ensureReadyForInference for summary failed:', e)
        await reply(
          adapter,
          '⚠️ Could not prepare the model to summarize chats. Try again later.',
          meta,
        )
        return false
      } finally {
        if (previousPreset && previousPreset !== HOME_AGENT_CHAT_PRESET_NAME) {
          try {
            textInference.applyPresetToGlobals(previousPreset, previousVariant)
          } catch (e) {
            console.error('homeAgent: failed to restore previous preset:', e)
          }
        }
      }
    }

    /**
     * Handle a bare `/load` (no argument) by sending a keyboard with the 3
     * most recent Home Agent chats. Button labels are AI-generated 5-word-or-
     * less summaries; tapping is equivalent to `/load <key>`.
     */
    async function handleLoadMenu(adapter: ChannelAdapter, meta?: InboundMeta): Promise<void> {
      focusRemoteChatDiscussion()

      const candidates = listRemoteConversations().slice(0, 3)
      if (candidates.length === 0) {
        await reply(adapter, '📭 No saved chats yet. Send a message to start one.', meta)
        return
      }

      // Quick acknowledgement so the user knows the bot is working — summary
      // generation can take a few seconds (3 sequential LLM calls worst case).
      await reply(adapter, '🤔 Preparing recent chats…', meta)

      const stopTyping = typing(adapter, 'typing', meta)
      try {
        if (!(await ensureSummarizerReady(adapter, meta))) return

        const items: Array<{ key: string; label: string }> = []
        for (const c of candidates) {
          const summary = await summarizeConversation(c.key)
          const label = c.isActive ? `${summary} (active)` : summary
          items.push({ key: c.key, label })
        }

        const buttons = items.map((it) => [{ text: it.label, callbackData: `loadConv:${it.key}` }])

        await keyboard(adapter, '📂 Pick a chat to resume:', buttons, meta)
      } finally {
        stopTyping()
      }
    }

    /** Cap on the number of /history entries that get AI-generated summaries.
     *  Keeps the worst-case latency bounded; older entries get a "…" stub. */
    const MAX_HISTORY_SUMMARIES = 10

    async function handleHistoryCommand(
      adapter: ChannelAdapter,
      meta?: InboundMeta,
    ): Promise<void> {
      focusRemoteChatDiscussion()

      const items = listRemoteConversations()
      if (items.length === 0) {
        await reply(
          adapter,
          '📭 No saved Home Agent chat threads yet. Send a message to start one.',
          meta,
        )
        return
      }

      const summaryTargets = items.slice(0, MAX_HISTORY_SUMMARIES)

      const anyNeedsGen = summaryTargets.some((c) => {
        const cached = summaryCache.value[c.key]
        return !cached || cached.messageCount !== c.messageCount
      })

      const stopTyping = anyNeedsGen ? typing(adapter, 'typing', meta) : () => {}
      try {
        if (anyNeedsGen) {
          await reply(adapter, '🤔 Preparing chat history…', meta)
          if (!(await ensureSummarizerReady(adapter, meta))) return
        }

        const summaries: Record<string, string> = {}
        for (const c of summaryTargets) {
          summaries[c.key] = await summarizeConversation(c.key)
        }

        const lines = items.map((item, idx) => {
          const marker = item.isActive ? ' • <i>(active)</i>' : ''
          const summary = summaries[item.key] ?? '…'
          const escapedSummary = escapeHtml(summary)
          return `${idx + 1}. <code>${idx + 1}</code> — ${escapedSummary} (${item.messageCount} msg)${marker}`
        })

        const trimmedCount = Math.max(0, items.length - MAX_HISTORY_SUMMARIES)
        const footer =
          trimmedCount > 0
            ? `\n\n…and <b>${trimmedCount}</b> older chat${trimmedCount === 1 ? '' : 's'} (no summary).`
            : ''

        await reply(
          adapter,
          '📜 <b>Your Home Agent chats</b>\n\n' +
            lines.join('\n') +
            footer +
            '\n\nResume one with <code>/load &lt;id&gt;</code> or just <code>/load</code> for a tap menu.',
          meta,
        )
      } finally {
        stopTyping()
      }
    }

    /**
     * Convert remote image payloads into persisted `aipg-media://` URLs and
     * return them as AI SDK `FileUIPart`s.
     */
    async function prepareRemoteFiles(
      images: RemoteImage[] | undefined,
      sourceLabel: string,
    ): Promise<FileUIPart[] | undefined> {
      if (!images || images.length === 0) return undefined
      const parts: FileUIPart[] = []
      for (let i = 0; i < images.length; i++) {
        const img = images[i]
        try {
          const dataUri = `data:${img.mime};base64,${img.data_base64}`
          const aipgUrl = await saveImageToMediaInput(dataUri)
          const ext = img.mime === 'image/jpeg' ? 'jpg' : img.mime.replace('image/', '')
          parts.push({
            type: 'file',
            mediaType: img.mime,
            url: aipgUrl,
            filename: `${sourceLabel}-${Date.now()}-${i}.${ext}`,
          })
        } catch (e) {
          console.error(`homeAgent: failed to persist ${sourceLabel} image:`, e)
        }
      }
      return parts.length > 0 ? parts : undefined
    }

    /**
     * If the active chat model does not support vision, reply to the channel
     * and return `false`. Returns `true` when it's safe to proceed.
     */
    async function ensureVisionCapableForImages(
      adapter: ChannelAdapter,
      hasImages: boolean,
      meta?: InboundMeta,
    ): Promise<boolean> {
      if (!hasImages) return true
      const textInference = useTextInference()
      if (textInference.modelSupportsVision) return true
      await reply(
        adapter,
        '⚠️ The active chat model does not support images. Select a vision-capable model in Chat settings, then resend the image.',
        meta,
      )
      return false
    }

    /**
     * Transcribe inbound voice/audio payloads into text using the shared STT
     * resolver (OVMS Whisper first, configured fallback endpoint otherwise).
     * Shows a typing indicator while transcribing. Returns the combined
     * transcript (possibly empty) or `null` when no STT endpoint is available
     * or transcription failed — in which case the user has already been
     * notified via `reply()`.
     */
    async function transcribeRemoteAudio(
      adapter: ChannelAdapter,
      audio: RemoteAudio[],
      meta?: InboundMeta,
    ): Promise<string | null> {
      const speechToText = useSpeechToText()
      const endpoint = await speechToText.resolveTranscription()
      if (!endpoint) {
        await reply(
          adapter,
          '⚠️ No speech-to-text is available. Enable Speech To Text (OVMS) or configure a fallback transcription endpoint in Settings.',
          meta,
        )
        return null
      }
      const stopTyping = typing(adapter, 'typing', meta)
      try {
        const parts: string[] = []
        for (const a of audio) {
          const blob = base64ToBlob(a.data_base64, a.mime)
          const text = await transcribeAudioBlob(blob, endpoint)
          if (text) parts.push(text.trim())
        }
        return parts.filter(Boolean).join(' ').trim()
      } catch (e) {
        console.error('homeAgent: audio transcription failed:', e)
        await reply(
          adapter,
          `⚠️ Could not transcribe the audio: ${e instanceof Error ? e.message : String(e)}`,
          meta,
        )
        return null
      } finally {
        stopTyping()
      }
    }

    async function handleChatMessage(
      adapter: ChannelAdapter,
      text: string,
      images?: RemoteImage[],
      meta?: InboundMeta,
      fromVoice = false,
    ): Promise<void> {
      focusRemoteChatDiscussion()
      const targetKey = ensureActiveRemoteConversation()
      if (!(await ensureVisionCapableForImages(adapter, !!images?.length, meta))) return
      const files = await prepareRemoteFiles(images, adapter.kind)
      const stopTyping = typing(adapter, 'typing', meta)
      try {
        await chatStore.generate(text, {
          conversationKey: targetKey,
          clearInputs: false,
          files,
        })
        maybeSetHomeAgentConversationTitle(targetKey)
        if (!isHomeAgentActive.value) return
        const assistantReply = extractAssistantReply(chatStore.getMessagesForKey(targetKey))
        if (assistantReply) {
          await replyMarkdown(adapter, assistantReply, meta)
          await maybeSendVoiceReply(adapter, assistantReply, fromVoice, meta)
        }
      } finally {
        stopTyping()
      }
    }

    /**
     * Poll the live assistant message on a tight interval during an agentic
     * turn and stream it via the adapter's draft stream. Reasoning, text and
     * tool-call markers are concatenated into one growing message that
     * animates in place; photos produced by ComfyUI tool calls still ship as
     * separate adapter.photo() calls.
     */
    function watchAndStreamToChannel(
      adapter: ChannelAdapter,
      targetKey: string,
      meta?: InboundMeta,
    ): () => Promise<void> {
      const sentMediaForPart = new WeakSet<object>()
      let sendChain: Promise<void> = Promise.resolve()
      let stopped = false
      const draft = draftStream(adapter, meta)

      // Snapshot the assistant message that already exists on this thread so
      // we don't stream/ship parts that belong to a previous turn.
      const preExistingMsgs = chatStore.getMessagesForKey(targetKey) ?? []
      const preExistingAssistantId = [...preExistingMsgs]
        .reverse()
        .find((m) => m.role === 'assistant')?.id

      function enqueueImage(fn: () => Promise<unknown>) {
        sendChain = sendChain
          .then(() => fn())
          .then(() => undefined)
          .catch((e) => console.error('homeAgent stream image send failed:', e))
      }

      function shipPendingImages(parts: RawPart[]) {
        for (const part of parts) {
          if (part.type !== 'tool-comfyUI' && part.type !== 'tool-comfyUiImageEdit') continue
          if (part.state !== 'output-available') continue
          if (sentMediaForPart.has(part as object)) continue
          sentMediaForPart.add(part as object)
          const media = part.output?.images ?? []
          if (media.length === 0) continue
          enqueueImage(async () => {
            for (const item of media) {
              if (item.type === 'image' && item.imageUrl) {
                await sendImageToChannel(adapter, item.imageUrl, '', meta)
              } else if (item.type === 'video' && item.videoUrl) {
                await sendVideoToChannel(adapter, item.videoUrl, '', meta)
              } else if (item.type === 'model3d' && item.model3dUrl) {
                await send3DModelToChannel(adapter, item.model3dUrl, '', meta)
              }
            }
          })
        }
      }

      function tick() {
        const msgs = chatStore.getMessagesForKey(targetKey) ?? []
        const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
        if (!lastAssistant) return
        // Ignore the pre-existing assistant from a previous turn.
        if (lastAssistant.id === preExistingAssistantId) return
        const parts = lastAssistant.parts as RawPart[]
        const draftText = adapter.formatDraft(parts)
        if (draftText) draft.update(draftText)
        shipPendingImages(parts)
      }

      const intervalId = setInterval(() => {
        if (!stopped) tick()
      }, 250)

      return async function flush() {
        stopped = true
        clearInterval(intervalId)
        const msgs = chatStore.getMessagesForKey(targetKey) ?? []
        const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
        const isStaleAssistant = !lastAssistant || lastAssistant.id === preExistingAssistantId
        const parts = isStaleAssistant ? [] : (lastAssistant!.parts as RawPart[])
        shipPendingImages(parts)
        const finalText = adapter.formatFinal(parts)
        await draft.finalize(finalText)
        await sendChain
      }
    }

    async function handleAgenticMessage(
      adapter: ChannelAdapter,
      text: string,
      images?: RemoteImage[],
      meta?: InboundMeta,
      fromVoice = false,
    ): Promise<void> {
      focusRemoteChatDiscussion()
      const targetKey = ensureActiveRemoteConversation()
      if (!(await ensureVisionCapableForImages(adapter, !!images?.length, meta))) return
      const files = await prepareRemoteFiles(images, adapter.kind)
      // Show "typing…" the moment we accept the turn — covers the silent
      // window before the watcher has any reasoning/text/tool part to send.
      const stopTyping = typing(adapter, 'typing', meta)
      const flush = watchAndStreamToChannel(adapter, targetKey, meta)
      try {
        await chatStore.generate(text, {
          conversationKey: targetKey,
          clearInputs: false,
          files,
        })
        maybeSetHomeAgentConversationTitle(targetKey)
      } finally {
        stopTyping()
        if (isHomeAgentActive.value) {
          await flush()
          // After the streamed text reply is delivered, send a voice version
          // if the inbound turn was itself a voice message.
          const assistantReply = extractAssistantReply(chatStore.getMessagesForKey(targetKey))
          if (assistantReply) {
            await maybeSendVoiceReply(adapter, assistantReply, fromVoice, meta)
          }
        } else {
          // Home Agent was disabled mid-generation: still drain so already
          // enqueued sends complete, but do not block the caller.
          void flush()
        }
      }
    }

    async function sendImageToChannel(
      adapter: ChannelAdapter,
      imageUrl: string,
      caption: string,
      meta?: InboundMeta,
    ): Promise<void> {
      try {
        const base64 = await mediaToBase64(imageUrl)
        const result = await photo(adapter, base64, caption, meta)
        if (!result.success) {
          throw new Error(result.error ?? 'photo returned failure')
        }
      } catch (e) {
        await reply(
          adapter,
          `⚠️ Image was generated but could not be sent: ${e instanceof Error ? e.message : String(e)}`,
          meta,
        )
      }
    }

    async function sendVideoToChannel(
      adapter: ChannelAdapter,
      videoUrl: string,
      caption: string,
      meta?: InboundMeta,
    ): Promise<void> {
      try {
        const base64 = await mediaToBase64(videoUrl)
        const result = await adapter.video(
          base64,
          caption,
          basenameForUrl(videoUrl, 'video.mp4'),
          meta,
        )
        if (!result.success) {
          throw new Error(result.error ?? 'video returned failure')
        }
      } catch (e) {
        await reply(
          adapter,
          `⚠️ Video was generated but could not be sent: ${e instanceof Error ? e.message : String(e)}`,
          meta,
        )
      }
    }

    /**
     * Ship a generated 3D model. Chat clients have no inline glTF preview, so
     * we render a thumbnail on-device and send it as a photo first, then ship
     * the `.glb` as a document. If thumbnail rendering fails we still send the
     * document so the user gets the file.
     */
    async function send3DModelToChannel(
      adapter: ChannelAdapter,
      model3dUrl: string,
      caption: string,
      meta?: InboundMeta,
    ): Promise<void> {
      try {
        try {
          const thumb = await render3dThumbnail(model3dUrl)
          await photo(adapter, thumb.base64, caption, meta)
        } catch (e) {
          console.error('homeAgent: 3D thumbnail render failed, sending document only:', e)
        }
        const base64 = await mediaToBase64(model3dUrl)
        const result = await adapter.document(
          base64,
          basenameForUrl(model3dUrl, 'model.glb'),
          caption,
          meta,
        )
        if (!result.success) {
          throw new Error(result.error ?? 'document returned failure')
        }
      } catch (e) {
        await reply(
          adapter,
          `⚠️ 3D model was generated but could not be sent: ${e instanceof Error ? e.message : String(e)}`,
          meta,
        )
      }
    }

    /** Extract a filename from an `aipg-media://`/http(s) URL, falling back to
     *  `fallback` for data URIs or empty basenames. */
    function basenameForUrl(url: string, fallback: string): string {
      try {
        const withoutScheme = url.replace(/^aipg-media:\/\//, '').split(/[?#]/)[0]
        const base = withoutScheme.split('/').pop()
        return base && base.length > 0 ? base : fallback
      } catch {
        return fallback
      }
    }

    async function mediaToBase64(mediaUrl: string): Promise<string> {
      if (mediaUrl.startsWith('aipg-media://')) {
        const result = await window.electronAPI.readAipgMediaAsBase64(mediaUrl)
        if (!result.success) {
          throw new Error(`readAipgMediaAsBase64 failed: ${result.error}`)
        }
        return result.data
      }
      if (mediaUrl.startsWith('data:')) {
        const comma = mediaUrl.indexOf('base64,')
        if (comma === -1) throw new Error('Malformed media data URI')
        return mediaUrl.slice(comma + 'base64,'.length)
      }
      const resp = await fetch(mediaUrl)
      if (!resp.ok) throw new Error(`fetch failed (${resp.status})`)
      const arrayBuf = await resp.arrayBuffer()
      const bytes = new Uint8Array(arrayBuf)
      let binary = ''
      const CHUNK = 8192
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
      }
      return btoa(binary)
    }

    /**
     * After generate() is called, wait for all newly enqueued images to
     * finish (done or stopped/error) sending each one as soon as it's ready.
     */
    async function waitAndSendAllImages(
      adapter: ChannelAdapter,
      newImageIds: Set<string>,
      prompt: string,
      meta?: InboundMeta,
    ): Promise<void> {
      const deadline = Date.now() + IMG_GEN_TIMEOUT_MS
      const sentIds = new Set<string>()

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500))

        for (const id of newImageIds) {
          if (sentIds.has(id)) continue
          const img = imageGenStore.generatedImages.find((i) => i.id === id)
          if (!img) continue

          if (img.state === 'done') {
            sentIds.add(id)
            if (isImage(img) && img.imageUrl) {
              await sendImageToChannel(adapter, img.imageUrl, prompt, meta)
            } else if (isVideo(img) && img.videoUrl) {
              await sendVideoToChannel(adapter, img.videoUrl, prompt, meta)
            } else if (is3D(img) && img.model3dUrl) {
              await send3DModelToChannel(adapter, img.model3dUrl, prompt, meta)
            }
          } else if (img.state === 'stopped') {
            sentIds.add(id) // count as handled, don't send
          }
        }

        if (imageGenStore.currentState === 'error') {
          const remaining = [...newImageIds].filter((id) => !sentIds.has(id))
          if (remaining.length > 0) {
            await reply(
              adapter,
              '⚠️ Image generation failed. Please check AI Playground for details.',
              meta,
            )
          }
          return
        }

        if (sentIds.size === newImageIds.size) return
      }

      const unsent = [...newImageIds].filter((id) => !sentIds.has(id))
      if (unsent.length > 0) {
        await reply(adapter, `⚠️ ${unsent.length} image(s) timed out and were not sent.`, meta)
      }
    }

    /** Clear `pendingImgGen` if its deadline has elapsed. */
    function expireImgGenPendingIfStale(): void {
      const p = pendingImgGen.value
      if (p && Date.now() > p.deadline) {
        pendingImgGen.value = null
      }
    }

    async function showImgGenPresetPicker(
      adapter: ChannelAdapter,
      cachedPrompt: string,
      meta?: InboundMeta,
    ): Promise<void> {
      focusRemoteChatDiscussion()

      const comfyService = backendServices.info.find((s) => s.serviceName === 'comfyui-backend')
      if (!comfyService || comfyService.status !== 'running') {
        await reply(
          adapter,
          '⚠️ Image generation is not available — the ComfyUI backend is not running.',
          meta,
        )
        return
      }

      const presetsList = presetsStore
        .getPresetsByCategories(['create-images'], 'comfy')
        .filter((p) => !p.excludeFromHomeAgentPicker)
      if (presetsList.length === 0) {
        await reply(
          adapter,
          '⚠️ No image generation presets are available. Configure one in AI Playground.',
          meta,
        )
        return
      }

      // Telegram caps callback_data at 64 bytes; Slack caps action_id at 255
      // bytes but truncates button labels at 75 chars. Both limits matter —
      // gate on the tighter Telegram cap so the same picker works for either.
      const encoder = new TextEncoder()
      const buttons: KeyboardButton[][] = []
      for (const p of presetsList) {
        const cb = `imgGen:preset:${p.name}`
        if (encoder.encode(cb).length > 64) continue
        const label = p.name.length > 30 ? `${p.name.slice(0, 29)}…` : p.name
        buttons.push([{ text: label, callbackData: cb }])
      }
      if (buttons.length === 0) {
        await reply(
          adapter,
          '⚠️ No image generation presets with safe-length names. Configure one in AI Playground.',
          meta,
        )
        return
      }
      buttons.push([{ text: '✖ Cancel', callbackData: 'imgGen:cancel' }])

      pendingImgGen.value = {
        phase: 'awaitingPresetTap',
        cachedPrompt,
        deadline: Date.now() + IMGGEN_PENDING_TIMEOUT_MS,
      }

      const intro = cachedPrompt
        ? '🎨 Pick a preset to generate your image:'
        : '🎨 Pick a preset, then send your prompt as the next message:'
      await keyboard(adapter, intro, buttons, meta)
    }

    /**
     * Generate an image using the named preset and the given prompt. Reused
     * by both the cached-prompt fast-path and the awaitingPrompt → free-text
     * path.
     */
    async function runImgGenWithPreset(
      adapter: ChannelAdapter,
      presetName: string,
      prompt: string,
      meta?: InboundMeta,
    ): Promise<void> {
      const comfyService = backendServices.info.find((s) => s.serviceName === 'comfyui-backend')
      if (!comfyService || comfyService.status !== 'running') {
        await reply(
          adapter,
          '⚠️ Image generation is not available — the ComfyUI backend is not running.',
          meta,
        )
        return
      }

      const previousMode = promptStore.getCurrentMode()
      // Match the typing indicator to the eventual delivery so Telegram shows
      // "sending a photo/video/document…" during the ComfyUI render. Read the
      // media type from the target preset by name (the active preset hasn't
      // been switched yet at this point). Slack ignores the action name and
      // just toggles the :eyes: reaction.
      const targetMediaType = presetsStore.presets.find((p) => p.name === presetName)?.mediaType
      const uploadAction =
        targetMediaType === 'video'
          ? 'upload_video'
          : targetMediaType === 'model3d'
            ? 'upload_document'
            : 'upload_photo'
      const stopTyping = typing(adapter, uploadAction, meta)

      // Phase-aware draft. Drafts auto-expire 30 s after the last update on
      // Telegram (Slack has no expiry); the keep-alive timer inside the
      // Telegram draft stream covers the gap between long ComfyUI state
      // transitions.
      const draft = draftStream(adapter, meta)
      let phaseStopped = false
      const updateDraftPhase = () => {
        if (phaseStopped) return
        draft.update(
          adapter.formatImgGenPhase({
            presetName,
            state: imageGenStore.currentState,
            step: imageGenStore.stepText,
          }),
        )
      }
      updateDraftPhase()
      const phaseIntervalId = setInterval(updateDraftPhase, 500)
      const stopDraft = () => {
        if (phaseStopped) return
        phaseStopped = true
        clearInterval(phaseIntervalId)
        draft.cancel()
      }

      try {
        promptStore.setModeOnly('imageGen')

        const switchResult = await presetSwitching.switchPreset(presetName, {
          skipModeSwitch: true,
        })
        if (!switchResult.success) {
          const presetLabel = adapter.formatItalic(adapter.escapeInline(presetName))
          const errLabel = adapter.escapeInline(switchResult.error ?? 'unknown error')
          await reply(adapter, `⚠️ Could not select preset ${presetLabel}: ${errLabel}`, meta)
          return
        }

        if (!imageGenStore.activePreset) {
          await reply(
            adapter,
            '⚠️ No image generation preset is selected. Please configure one in AI Playground.',
            meta,
          )
          return
        }

        const validation = await imageGenStore.validatePresetRequirements()
        if (!validation.backendRunning) {
          await reply(
            adapter,
            '⚠️ Image generation is not available — the ComfyUI backend is not running.',
            meta,
          )
          return
        }
        if (
          validation.missingCustomNodes.length > 0 ||
          validation.missingPythonPackages.length > 0 ||
          validation.missingModels.length > 0
        ) {
          const parts: string[] = []
          if (validation.missingModels.length > 0)
            parts.push(
              `missing models: ${validation.missingModels.map((m) => m.repo_id).join(', ')}`,
            )
          if (validation.missingCustomNodes.length > 0)
            parts.push(`missing custom nodes: ${validation.missingCustomNodes.join(', ')}`)
          if (validation.missingPythonPackages.length > 0)
            parts.push(`missing packages: ${validation.missingPythonPackages.join(', ')}`)
          await reply(
            adapter,
            `⚠️ Image generation requirements are not met: ${parts.join('; ')}. Please configure AI Playground first.`,
            meta,
          )
          return
        }

        const knownIdsBefore = new Set(imageGenStore.generatedImages.map((img) => img.id))
        imageGenStore.prompt = prompt
        try {
          await imageGenStore.generate('imageGen')
        } catch (e) {
          await reply(
            adapter,
            `⚠️ Image generation failed to start: ${e instanceof Error ? e.message : String(e)}`,
            meta,
          )
          return
        }

        const newImageIds = new Set(
          imageGenStore.generatedImages
            .filter((img) => !knownIdsBefore.has(img.id))
            .map((img) => img.id),
        )

        if (newImageIds.size === 0) {
          await reply(adapter, '⚠️ Image generation did not produce any images.', meta)
          return
        }

        await waitAndSendAllImages(adapter, newImageIds, prompt, meta)
      } finally {
        stopDraft()
        stopTyping()
        promptStore.setModeOnly(previousMode)
      }
    }

    async function handleImgGenPresetCallback(
      adapter: ChannelAdapter,
      presetName: string,
      meta?: InboundMeta,
    ): Promise<void> {
      const pending = pendingImgGen.value
      const cachedPrompt = pending?.phase === 'awaitingPresetTap' ? pending.cachedPrompt.trim() : ''

      if (cachedPrompt) {
        pendingImgGen.value = null
        await runImgGenWithPreset(adapter, presetName, cachedPrompt, meta)
        return
      }

      pendingImgGen.value = {
        phase: 'awaitingPrompt',
        presetName,
        deadline: Date.now() + IMGGEN_PENDING_TIMEOUT_MS,
      }
      await reply(
        adapter,
        `✅ Selected <i>${escapeHtml(presetName)}</i>.\nNow send your prompt as the next message, or /cancel to abort.`,
        meta,
      )
    }

    /** Cancel button on the picker OR the /cancel slash command. */
    async function handleImgGenCancel(adapter: ChannelAdapter, meta?: InboundMeta): Promise<void> {
      const wasPending = pendingImgGen.value !== null
      pendingImgGen.value = null
      await reply(
        adapter,
        wasPending ? '✖ Image generation cancelled.' : 'Nothing to cancel.',
        meta,
      )
    }

    /**
     * Channel-agnostic queue drain. Pulls items off the per-channel queue and
     * dispatches them through `adapter`.
     */
    async function drainCommonQueue(kind: ChannelKind) {
      if (drainBusyByKind[kind]) return
      drainBusyByKind[kind] = true
      const queue = messageQueues[kind]
      const adapter = adapters[kind]
      if (!adapter) {
        drainBusyByKind[kind] = false
        return
      }
      try {
        while (queue.length > 0 && channels[kind].active) {
          const item = queue.shift()!
          const meta = item.meta
          expireImgGenPendingIfStale()

          // Inline-keyboard taps from the /imgGen preset picker arrive with a
          // `callback` field instead of `text`.
          if (item.callback) {
            try {
              if (item.callback === 'imgGen:cancel') {
                await handleImgGenCancel(adapter, meta)
              } else if (item.callback.startsWith('imgGen:preset:')) {
                const name = item.callback.slice('imgGen:preset:'.length)
                await handleImgGenPresetCallback(adapter, name, meta)
              }
            } catch (e) {
              console.error(`Error processing ${kind} callback:`, e)
            }
            continue
          }

          let text = item.text ?? ''
          const images = item.images
          // Whether the inbound turn came from a voice message — used to decide
          // whether to also reply with a synthesized voice message.
          const fromVoice = !!item.audio?.length
          // Voice/audio messages: transcribe first, then treat the transcript
          // as the message text so slash-commands spoken aloud and plain
          // prompts both flow through the normal handling below.
          if (item.audio?.length) {
            const transcript = await transcribeRemoteAudio(adapter, item.audio, meta)
            if (transcript === null) continue // STT unavailable / failed — already replied
            text = [text, transcript].filter(Boolean).join(' ').trim()
            if (!text) {
              await reply(
                adapter,
                "🎙️ I couldn't make out any speech in that audio. Please try again.",
                meta,
              )
              continue
            }
          }
          try {
            if (HELP_REGEX.test(text)) {
              focusRemoteChatDiscussion()
              await reply(adapter, HELP_MESSAGE, meta)
            } else if (CANCEL_REGEX.test(text)) {
              await handleImgGenCancel(adapter, meta)
            } else if (NEW_REGEX.test(text)) {
              const newKey = createNewRemoteConversation()
              focusRemoteChatDiscussion()
              await reply(
                adapter,
                `🆕 Started a new chat thread: <i>${homeAgentTitleFor(newKey).replace(/[<>&]/g, '')}</i>.\nNext message will land in this thread.`,
                meta,
              )
            } else if (HISTORY_REGEX.test(text)) {
              await handleHistoryCommand(adapter, meta)
            } else if (LOAD_BARE_REGEX.test(text)) {
              await handleLoadMenu(adapter, meta)
            } else if (LOAD_REGEX.test(text)) {
              const match = text.match(LOAD_REGEX)
              const arg = match?.[1] ?? ''
              const key = resolveLoadTarget(arg)
              if (!key) {
                await reply(
                  adapter,
                  `⚠️ Couldn't find a chat with id <code>${escapeHtml(arg)}</code>. Try <code>/history</code> first.`,
                  meta,
                )
              } else if (switchRemoteConversation(key)) {
                focusRemoteChatDiscussion()
                const items = listRemoteConversations()
                const found = items.find((i) => i.key === key)
                await reply(
                  adapter,
                  `📂 Loaded <i>${escapeHtml(found?.title ?? key)}</i>.\nReplies and new messages now use this thread.`,
                  meta,
                )
              } else {
                await reply(adapter, '⚠️ Could not load that chat thread.', meta)
              }
            } else if (IMG_GEN_REGEX.test(text)) {
              const prompt = text.replace(IMG_GEN_REGEX, '').trim()
              if (images?.length) {
                await reply(
                  adapter,
                  'ℹ️ <code>/imgGen</code> is text-only — the attached photo is ignored.',
                  meta,
                )
              }
              await showImgGenPresetPicker(adapter, prompt, meta)
            } else if (CHAT_REGEX.test(text)) {
              const msg = text.replace(CHAT_REGEX, '').trim()
              if (msg || images?.length) {
                await handleChatMessage(adapter, msg, images, meta, fromVoice)
              } else {
                focusRemoteChatDiscussion()
                await reply(
                  adapter,
                  '⚠️ Please add a message after the command.\nExample: <code>/chat Hello, world!</code>',
                  meta,
                )
              }
            } else if (pendingImgGen.value?.phase === 'awaitingPrompt') {
              const presetName = pendingImgGen.value.presetName
              const promptText = images?.length && text === '[image]' ? '' : text.trim()
              if (!promptText) {
                await reply(
                  adapter,
                  '⚠️ Please send your prompt as text. Photos are ignored for /imgGen. /cancel to abort.',
                  meta,
                )
              } else {
                pendingImgGen.value = null
                await runImgGenWithPreset(adapter, presetName, promptText, meta)
              }
            } else if (pendingImgGen.value?.phase === 'awaitingPresetTap' && text.trim()) {
              await reply(adapter, '🖼️ Tap a preset above, or /cancel to dismiss the picker.', meta)
            } else {
              // Agentic mode — for photo-only messages the Python side queues
              // "[image]" as a placeholder; clear it so the model isn't biased
              // by a literal token.
              const agenticText = images?.length && text === '[image]' ? '' : text
              await handleAgenticMessage(adapter, agenticText, images, meta, fromVoice)
            }
          } catch (e) {
            console.error(`Error processing ${kind} message:`, e)
          }
        }
      } finally {
        drainBusyByKind[kind] = false
      }
    }

    async function processChannelMessages(kind: ChannelKind) {
      try {
        const msgs = await window.electronAPI.homeAgent.channel.poll(kind)
        if (!msgs || msgs.length === 0) return
        const queue = messageQueues[kind]
        for (const msg of msgs) {
          if (queue.length >= MAX_QUEUE_SIZE) {
            toast.warning(`Home Agent: ${kind} queue full, dropping oldest message.`)
            queue.shift()
          }
          queue.push({
            text: msg.text,
            images: msg.images,
            audio: msg.audio,
            callback: msg.callback,
            // Thread inbound metadata so adapters can target reactions /
            // threaded sends at the originating message (only Slack uses this
            // today; benign for Telegram).
            meta:
              msg.channel || msg.ts || msg.chat_id
                ? { channel: msg.channel, ts: msg.ts, chatId: msg.chat_id }
                : undefined,
          })
        }
        void drainCommonQueue(kind)
      } catch (e) {
        console.error(`Error polling ${kind}:`, e)
      }
    }

    function startPolling(kind: ChannelKind) {
      disposePoll(kind)
      pollIntervalIds[kind] = setInterval(() => {
        void processChannelMessages(kind)
      }, POLL_INTERVAL_MS)
    }

    function stopPolling(kind: ChannelKind) {
      disposePoll(kind)
      messageQueues[kind].length = 0
    }

    // ── Config / activation API (channel-agnostic) ──────────────────────────

    async function saveChannelConfig(
      kind: ChannelKind,
      config: Partial<ChannelConfig>,
    ): Promise<{ success: boolean; error?: string }> {
      try {
        // safeStorage save (electron main process). Pass the flat config blob;
        // the main side partitions secret vs public fields.
        const result = await window.electronAPI.homeAgent.channel.saveConfig(
          kind,
          config as Record<string, string>,
        )
        if (result.success) {
          const prev = channels[kind].config as Record<string, string>
          const next = config as Record<string, string>
          const fieldChanged = Object.keys(next).some((k) => prev[k] !== next[k])
          channels[kind].config = { ...config }
          // Track identity in the dedicated prefs `.identity` field so consumers
          // don't need to know which sub-key carries it for each kind.
          const idKey = CHANNEL_FIELD_SPEC[kind].identityField
          if (idKey && next[idKey] !== undefined) channelPrefs[kind].identity = next[idKey]
          // Credentials changed — force re-verification (but keep the user's
          // enabled preference; the channel just won't run until re-verified).
          if (fieldChanged) {
            channelPrefs[kind].verified = false
          }
        }
        return result
      } catch (e) {
        console.error(`homeAgent.saveChannelConfig(${kind}) failed:`, e)
        return { success: false, error: String(e) }
      }
    }

    async function clearChannelConfig(kind: ChannelKind): Promise<void> {
      try {
        await window.electronAPI.homeAgent.channel.clearConfig(kind)
      } catch (e) {
        console.error(`homeAgent.clearChannelConfig(${kind}) failed:`, e)
      }
      channels[kind] = emptyRuntimeState(kind)
      channelPrefs[kind] = emptyPrefs()
    }

    /** Mark a channel verified after a successful test. A freshly verified
     *  channel defaults to enabled so it starts running immediately (subject
     *  to the master switch) — matching the prior "verify ⇒ on" behavior. */
    function setVerified(kind: ChannelKind) {
      channelPrefs[kind].verified = true
      channelPrefs[kind].enabled = true
    }

    /** Per-channel enable/disable — invoked from the setup screen. Enabling a
     *  channel requires it to be verified first. */
    function setChannelEnabled(kind: ChannelKind, on: boolean) {
      if (on && !channelPrefs[kind].verified) {
        toast.error(`Verify the ${kind} connection before enabling it.`)
        return
      }
      channelPrefs[kind].enabled = on
      if (on && masterEnabled.value && isAvailable.value) focusRemoteChatDiscussion()
    }

    /** Master Home Agent on/off — the single title-bar toggle. */
    function setMasterEnabled(on: boolean) {
      masterEnabled.value = on
      if (on && isAvailable.value && KINDS.some((k) => channelPrefs[k].enabled)) {
        focusRemoteChatDiscussion()
      }
    }

    function toggleMaster() {
      setMasterEnabled(!masterEnabled.value)
    }

    /** Load tokens from safeStorage. Persisted Pinia state already carries
     *  `channelPrefs` (verified / identity / enabled); this rehydrates the
     *  in-memory secret config and back-fills identity when it is missing. */
    async function initConfig() {
      try {
        try {
          const localSettings = await window.electronAPI.getLocalSettings()
          isFeatureEnabled.value = !!localSettings.isHomeAgentEnabled
        } catch (e) {
          console.error('homeAgent.initConfig: getLocalSettings failed:', e)
          isFeatureEnabled.value = false
        }
        if (!isFeatureEnabled.value) {
          for (const k of KINDS) channels[k] = emptyRuntimeState(k)
          return
        }
        for (const kind of KINDS) {
          const cfg = await window.electronAPI.homeAgent.channel.loadConfig(kind)
          if (cfg) {
            channels[kind].config = { ...cfg, kind } as Partial<ChannelConfig>
            // Back-fill the prefs `.identity` from the saved config's identity
            // key (chatId / userId / …). The persisted Pinia state may already
            // carry it, but a migrated legacy config or an older persisted blob
            // without identity would otherwise leave it null — making the setup
            // wizard think no chat/DM partner exists even though the backend
            // has one.
            const idKey = CHANNEL_FIELD_SPEC[kind].identityField
            const savedIdentity = (cfg as Record<string, string>)[idKey]
            if (savedIdentity && !channelPrefs[kind].identity) {
              channelPrefs[kind].identity = savedIdentity
            }
          } else if (!channelPrefs[kind].verified) {
            channels[kind].config = {}
          }
        }
      } catch (e) {
        console.error('homeAgent.initConfig failed:', e)
      }
    }

    void initConfig()

    // ── Read-only convenience getters ───────────────────────────────────────
    // External consumers (setup composables, setup-step components) read these.
    // They are NOT used for persistence — `channelPrefs` is persisted directly.
    const telegramVerified = computed(() => channelPrefs.telegram.verified)
    const telegramChatId = computed(() => channelPrefs.telegram.identity ?? '')
    const slackVerified = computed(() => channelPrefs.slack.verified)
    const slackUserId = computed(() => channelPrefs.slack.identity ?? '')

    return {
      isFeatureEnabled,
      isHomeAgentActive,
      // Master title-bar switch + persisted per-channel prefs.
      masterEnabled,
      channelPrefs,
      // Runtime channel state map (secrets + derived `active`); in-memory only.
      channels,
      // Read-only per-kind convenience getters over channelPrefs.
      telegramVerified,
      telegramChatId,
      slackVerified,
      slackUserId,
      isAvailable,
      homeAgentBaseUrl,
      // Remote conversation registry
      activeRemoteConversationKey,
      remoteConversationKeys,
      createNewRemoteConversation,
      switchRemoteConversation,
      ensureActiveRemoteConversation,
      listRemoteConversations,
      // Settings panel visibility
      showSettings,
      openSettings,
      closeSettings,
      // Bare-/load summary cache (persisted)
      summaryCache,
      summarizeConversation,
      // Channel-agnostic control surface
      setChannelEnabled,
      setMasterEnabled,
      toggleMaster,
      saveChannelConfig,
      clearChannelConfig,
      setVerified,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      // Persist only non-secret state. `channelPrefs` (verified / identity /
      // enabled per kind) and `masterEnabled` drive activation on the next
      // launch; the secret `config` in `channels` is rehydrated from
      // safeStorage by initConfig() and never serialized here.
      // activeRemoteConversationKey persisted so /load <id> survives restart.
      // summaryCache persisted so /load menu summaries survive restarts.
      pick: ['masterEnabled', 'channelPrefs', 'activeRemoteConversationKey', 'summaryCache'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeAllPollHandlers()
    for (const k of Object.keys(drainBusyByKind)) {
      drainBusyByKind[k as ChannelKind] = false
    }
  })
  import.meta.hot.accept(acceptHMRUpdate(useHomeAgent, import.meta.hot))
}
