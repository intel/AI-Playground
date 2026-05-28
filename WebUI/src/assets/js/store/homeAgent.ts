import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { FileUIPart } from 'ai'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices } from './backendServices'
import { useOpenAiCompatibleChat, type AipgUiMessage } from './openAiCompatibleChat'
import { useImageGenerationPresets, isImage } from './imageGenerationPresets'
import { usePromptStore } from './promptArea'
import { usePresetSwitching } from './presetSwitching'
import { usePresets } from './presets'
// Lazy-instantiated inside helpers to avoid a setup-time cycle with textInference,
// which already instantiates useHomeAgent() at the top of its own setup.
import { useTextInference } from './textInference'
import {
  useConversations,
  HOME_AGENT_CONVERSATION_KEY,
  HOME_AGENT_CONVERSATION_TITLE,
  HOME_AGENT_CHAT_PRESET_NAME,
} from './conversations'
import { saveImageToMediaInput } from '@/lib/utils'
import { markdownToTelegramHtml } from '../telegramMarkdown'
import { markdownToSlackMrkdwn } from '../slackMrkdwn'
import * as toast from '../toast'

type RemoteImage = { mime: string; data_base64: string }
/** Adapter-opaque inbound metadata threaded through the drain pipeline.
 *  Telegram does not need it (chat-id is implicit); Slack uses it to target
 *  reactions and threaded sends at the inbound message. */
type InboundMeta = { channel?: string; ts?: string; chatId?: string }
type RemoteQueueItem = {
  text?: string
  images?: RemoteImage[]
  callback?: string
  meta?: InboundMeta
}
// Back-compat alias — local declarations still reference the older name.
// Removing it is purely cosmetic, so it stays.
type TelegramQueueItem = RemoteQueueItem

export type ChannelKind = 'telegram' | 'slack'

/** Per-channel handle returned by `sendReply` so the streaming layer can
 *  edit the message in place. Telegram identifies drafts by `draftId`;
 *  Slack identifies posted messages by `{channel, ts}`. */
type ChannelMessageRef = {
  draftId?: number
  ts?: string
  channel?: string
}

type DraftStream = {
  update: (text: string) => void
  /** Persist the final text and dispose the stream. */
  finalize: (finalText: string) => Promise<void>
  cancel: () => void
}

/** Channel-agnostic surface used by every slash-command / chat / image-gen
 *  handler. Each adapter wraps the per-channel IPC primitives and quirks. */
type ChannelAdapter = {
  kind: ChannelKind
  /** Convert assistant markdown to the channel's native rich-text format. */
  formatMarkdown: (md: string) => string
  /** Convert one of our HTML-ish hardcoded UI strings to channel-native. */
  formatRichSnippet: (htmlSnippet: string) => string
  sendReply: (
    text: string,
    opts?: { meta?: InboundMeta },
  ) => Promise<{ success: boolean; ref?: ChannelMessageRef; error?: string }>
  sendPhoto: (
    imageBase64: string,
    caption: string,
    opts?: { meta?: InboundMeta },
  ) => Promise<{ success: boolean; error?: string }>
  sendKeyboard: (opts: {
    text: string
    buttons: Array<Array<{ text: string; callbackData: string }>>
    meta?: InboundMeta
  }) => Promise<{ success: boolean; error?: string }>
  /** "Bot is working" indicator — Telegram uses chat-action heartbeats,
   *  Slack uses reaction add/remove on the inbound message. */
  startTypingHeartbeat: (action: string, meta?: InboundMeta) => () => void
  /** In-place streaming preview. Telegram uses sendMessageDraft, Slack uses
   *  chat.update after an initial chat.postMessage. */
  createDraftStream: (opts?: { meta?: InboundMeta }) => DraftStream
}

/** Lightweight HTML → Slack mrkdwn conversion for the hand-authored UI
 *  strings (HELP_MESSAGE, status banners, …). Limited to the set of tags
 *  those snippets actually use. */
function htmlSnippetToSlackMrkdwn(html: string): string {
  return html
    .replace(/<b>([\s\S]*?)<\/b>/gi, '*$1*')
    .replace(/<strong>([\s\S]*?)<\/strong>/gi, '*$1*')
    .replace(/<i>([\s\S]*?)<\/i>/gi, '_$1_')
    .replace(/<em>([\s\S]*?)<\/em>/gi, '_$1_')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '<$1|$2>')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

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

/** Module-level so Vite HMR does not orphan intervals across Pinia setup closures. */
let telegramPollIntervalId: ReturnType<typeof setInterval> | null = null
let slackPollIntervalId: ReturnType<typeof setInterval> | null = null

function disposeTelegramPollHandlers() {
  if (telegramPollIntervalId !== null) {
    clearInterval(telegramPollIntervalId)
    telegramPollIntervalId = null
  }
}

function disposeSlackPollHandlers() {
  if (slackPollIntervalId !== null) {
    clearInterval(slackPollIntervalId)
    slackPollIntervalId = null
  }
}

/** Module-level so HMR release doesn't strand drainQueue mid-patch. */
let telegramDrainBusy = false
let slackDrainBusy = false

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
    // Per-channel "running" flags. `isHomeAgentActive` is now a computed of
    // either channel being on, so existing callsites that gate by "are we
    // currently fielding remote traffic?" keep working without changes.
    const isTelegramActive = ref(false)
    const isSlackActive = ref(false)
    const telegramToken = ref<string | null>(null)
    const telegramChatId = ref<string | null>(null)
    const telegramVerified = ref(false)
    // Slack credentials: tokens live only in safeStorage (not persisted to
    // pinia disk). `slackUserId` and `slackVerified` ARE persisted so the
    // "ready to activate" flag survives restarts.
    const slackBotToken = ref<string | null>(null)
    const slackAppToken = ref<string | null>(null)
    const slackUserId = ref<string | null>(null)
    const slackVerified = ref(false)

    /**
     * Conversation key Telegram traffic currently routes into. `null` means
     * "create one on first use" — covers fresh installs and post-`/new`
     * sessions before the user sends anything.
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

    const _messageQueue: TelegramQueueItem[] = []
    const _slackQueue: RemoteQueueItem[] = []
    // Per-channel "user explicitly turned this off" so re-enabling one channel
    // doesn't trample the other.
    let _telegramUserDisabled = false
    let _slackUserDisabled = false

    const isTelegramConfigured = computed(() => !!telegramToken.value && !!telegramChatId.value)
    const isSlackConfigured = computed(
      () => !!slackBotToken.value && !!slackAppToken.value && !!slackUserId.value,
    )

    // "Ready to activate" = previously verified. *Verified flags are persisted,
    // so these are true immediately on startup when the user verified earlier.
    const isReadyToActivate = computed(() => telegramVerified.value)
    const isSlackReadyToActivate = computed(() => slackVerified.value)

    // Umbrella flag — true if either channel is currently fielding traffic.
    // Many existing call sites (textInference, HomeAgentToggle) treat this as
    // "are we serving a remote chat right now?" — keep that semantic.
    const isHomeAgentActive = computed(() => isTelegramActive.value || isSlackActive.value)

    const isAvailable = computed(
      () =>
        isFeatureEnabled.value &&
        backendServices.info.find((s) => s.serviceName === 'home-agent-backend')?.status ===
          'running',
    )

    const homeAgentBaseUrl = computed(
      () => backendServices.info.find((s) => s.serviceName === 'home-agent-backend')?.baseUrl,
    )

    // When the backend becomes available and a channel has been verified,
    // auto-activate that channel (unless the user explicitly turned it off).
    watch(isAvailable, (val) => {
      if (val) {
        if (isReadyToActivate.value && !_telegramUserDisabled) isTelegramActive.value = true
        if (isSlackReadyToActivate.value && !_slackUserDisabled) isSlackActive.value = true
      } else {
        isTelegramActive.value = false
        isSlackActive.value = false
      }
    })

    // Single polling bot start via Flask (/set-telegram-token). Runs when backend + credentials
    // are ready (token may hydrate after the backend reports running).
    watch(
      [isAvailable, telegramToken, telegramChatId],
      ([avail, tok, cid]) => {
        const token = tok?.trim()
        const chatId = cid?.trim()
        if (!avail || !token || !chatId) return
        void window.electronAPI.homeAgent
          .injectToken(token, chatId)
          .catch((e: unknown) => console.error('homeAgent: injectToken failed:', e))
      },
      { flush: 'post', immediate: true },
    )

    // Slack mirror — when backend + both Slack tokens are ready, inject so the
    // Socket Mode bot starts (or restarts if tokens changed).
    watch(
      [isAvailable, slackBotToken, slackAppToken, slackUserId],
      ([avail, bot, appTok, user]) => {
        const botStr = bot?.trim()
        const appStr = appTok?.trim()
        const userStr = user?.trim() || undefined
        if (!avail || !botStr || !appStr) return
        void window.electronAPI.homeAgent.slack
          .injectTokens(botStr, appStr, userStr)
          .catch((e: unknown) => console.error('homeAgent: slack injectTokens failed:', e))
      },
      { flush: 'post', immediate: true },
    )

    // When verification state changes, sync active state.
    watch(isReadyToActivate, (val) => {
      if (!val) {
        isTelegramActive.value = false
      } else if (isAvailable.value && !_telegramUserDisabled) {
        isTelegramActive.value = true
      }
    })
    watch(isSlackReadyToActivate, (val) => {
      if (!val) {
        isSlackActive.value = false
      } else if (isAvailable.value && !_slackUserDisabled) {
        isSlackActive.value = true
      }
    })

    // Start/stop per-channel polling when its active state changes.
    watch(isTelegramActive, (val) => {
      if (val) {
        startTelegramPolling()
      } else {
        stopTelegramPolling()
      }
    })
    watch(isSlackActive, (val) => {
      if (val) {
        startSlackPolling()
      } else {
        stopSlackPolling()
      }
    })

    // When the user selects a Home Agent thread from the desktop UI (e.g. the
    // HistoryChat list), mirror that into `activeRemoteConversationKey` so the
    // Telegram bridge keeps routing into the same conversation. Keeps the two
    // "last active Home Agent thread" stores in lockstep with `/load` and
    // `focusRemoteChatDiscussion()` from the Telegram side.
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
    const IMG_GEN_TIMEOUT_MS = 120_000

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
      'Requires a <b>vision-capable model</b> selected in Chat settings.'

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
     * target for new Telegram messages, and return its key. If the most-recent
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

    /** Switch which Home Agent thread Telegram messages route into. */
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
      // Most recent first. Numeric timestamp keys sort by their integer value so
      // newer chats land on top; the legacy singleton string key parses to NaN
      // → 0 so it falls to the bottom (instead of being pushed to the top by
      // lexical ordering, where '_' > '9').
      return entries.sort((a, b) => (parseInt(b.key) || 0) - (parseInt(a.key) || 0))
    }

    /** Show Chat view on the active Home Agent thread so remote traffic is visible. */
    function focusRemoteChatDiscussion() {
      const key = ensureActiveRemoteConversation()
      conversations.ensureConversationBucket(key)
      conversations.activeKey = key
      promptStore.setModeOnly('chat')
    }

    /**
     * Flatten the last 5 messages of a conversation into a "User: …" /
     * "Assistant: …" transcript suitable for one-shot summarization.
     */
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

    /**
     * Return a 5-word-or-less label for a conversation suitable for an
     * inline-keyboard button. Cached per `(conversationKey, messageCount)` so
     * unchanged threads do not re-summarize on subsequent /load presses.
     */
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
    // so the same logic services both Telegram and Slack without duplicating
    // the slash-command + image-gen pipelines. Each helper takes the current
    // adapter and (where relevant) the inbound message metadata so Slack can
    // target reactions / threaded sends.

    async function reply(
      adapter: ChannelAdapter,
      htmlSnippet: string,
      meta?: InboundMeta,
    ): Promise<{ success: boolean; ref?: ChannelMessageRef; error?: string }> {
      return adapter.sendReply(adapter.formatRichSnippet(htmlSnippet), { meta })
    }

    async function replyMarkdown(
      adapter: ChannelAdapter,
      md: string,
      meta?: InboundMeta,
    ): Promise<{ success: boolean; ref?: ChannelMessageRef; error?: string }> {
      return adapter.sendReply(adapter.formatMarkdown(md), { meta })
    }

    async function keyboard(
      adapter: ChannelAdapter,
      htmlIntro: string,
      buttons: Array<Array<{ text: string; callbackData: string }>>,
      meta?: InboundMeta,
    ): Promise<{ success: boolean; error?: string }> {
      return adapter.sendKeyboard({
        text: adapter.formatRichSnippet(htmlIntro),
        buttons,
        meta,
      })
    }

    async function photo(
      adapter: ChannelAdapter,
      base64: string,
      caption: string,
      meta?: InboundMeta,
    ): Promise<{ success: boolean; error?: string }> {
      return adapter.sendPhoto(base64, caption, { meta })
    }

    function typing(adapter: ChannelAdapter, action: string, meta?: InboundMeta): () => void {
      return adapter.startTypingHeartbeat(action, meta)
    }

    function draftStream(adapter: ChannelAdapter, meta?: InboundMeta): DraftStream {
      return adapter.createDraftStream({ meta })
    }

    /**
     * Pin the live preset/backend to Home Agent and prep inference so the
     * summarizer uses the bundled Home Agent model. Returns `false` and replies
     * to the active channel with an error if readiness fails. Used by both
     * `/load` (bare) and `/history` before they fan out summary calls.
     *
     * Lazy-instantiates `useTextInference` to avoid the documented setup-time
     * cycle with this store.
     */
    async function ensureSummarizerReady(
      adapter: ChannelAdapter,
      meta?: InboundMeta,
    ): Promise<boolean> {
      const textInference = useTextInference()
      // Snapshot the user's currently selected desktop preset/variant so we can
      // restore them after we transiently switch to the Home Agent preset for
      // summarization. Without this, calls like `/history` from Telegram would
      // permanently overwrite the desktop session's preset.
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

    /** Minimal HTML escape for chunks of summary text rendered with parse_mode=HTML. */
    function escapeHtml(input: string): string {
      return input.replace(/[&<>"']/g, (c) =>
        c === '&'
          ? '&amp;'
          : c === '<'
            ? '&lt;'
            : c === '>'
              ? '&gt;'
              : c === '"'
                ? '&quot;'
                : '&#39;',
      )
    }

    /**
     * Handle a bare `/load` (no argument) by sending an inline keyboard with
     * the 3 most recent Home Agent chats. Each button label is an AI-generated
     * 5-word-or-less summary of that thread; tapping a button is equivalent to
     * `/load <key>` (handled via the Python CallbackQueryHandler on `loadConv:`).
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
     *  Keeps the worst-case latency bounded when the user has accumulated many
     *  Home Agent chats. Entries past the cap are still listed (with their
     *  timestamp title) plus a footer noting how many were trimmed. */
    const MAX_HISTORY_SUMMARIES = 10

    /**
     * Handle `/history` by replying with the full list of Home Agent chats.
     * Each line gets a 5-word-or-less AI summary (cache-aware) for the most
     * recent up-to-`MAX_HISTORY_SUMMARIES` threads; older entries fall back to
     * their timestamp-based title and a "…" placeholder so the user is not
     * blocked on summarising an old archive.
     */
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

      // Only spin up the model if at least one entry actually needs work.
      // For all-cache-hit calls this short-circuits and avoids loading the
      // backend just to format the response.
      const anyNeedsGen = summaryTargets.some((c) => {
        const cached = summaryCache.value[c.key]
        return !cached || cached.messageCount !== c.messageCount
      })

      // Heartbeat is only meaningful while we're actually generating; cache-hit
      // path is essentially instant.
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
     * return them as AI SDK `FileUIPart`s. Returns `undefined` for empty input
     * so callers can pass the value straight through to `chat.sendMessage`.
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
     * and return `false` so the caller skips inference. Returns `true` when
     * it's safe to proceed (no images, or model supports vision).
     */
    async function ensureVisionCapableForImages(
      adapter: ChannelAdapter,
      hasImages: boolean,
      meta?: InboundMeta,
    ): Promise<boolean> {
      if (!hasImages) return true
      // Lazy instantiation: textInference imports useHomeAgent at top of its setup;
      // calling useTextInference() here (not in this store's setup body) avoids
      // a circular setup-time dependency. Same pattern as presetSwitching.
      const textInference = useTextInference()
      if (textInference.modelSupportsVision) return true
      await reply(
        adapter,
        '⚠️ The active chat model does not support images. Select a vision-capable model in Chat settings, then resend the image.',
        meta,
      )
      return false
    }

    async function handleChatMessage(
      adapter: ChannelAdapter,
      text: string,
      images?: RemoteImage[],
      meta?: InboundMeta,
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
        }
      } finally {
        stopTyping()
      }
    }

    /**
     * Show a persistent Telegram "typing…" indicator while a long-running
     * operation is in flight. Telegram chat actions auto-expire after ~5s
     * on the client (per https://core.telegram.org/bots/api#sendchataction),
     * so we fire one immediately and refresh every 4s until stopped.
     *
     * Returns a stop function — idempotent, safe to call from a `finally`.
     */
    function startTelegramTypingHeartbeat(action: string = 'typing'): () => void {
      let stopped = false
      void window.electronAPI.homeAgent.sendTelegramChatAction(action)
      const intervalId = setInterval(() => {
        if (stopped) return
        void window.electronAPI.homeAgent.sendTelegramChatAction(action)
      }, 4000)
      return () => {
        if (stopped) return
        stopped = true
        clearInterval(intervalId)
      }
    }

    /**
     * Slack has no native bot "typing…" indicator in DMs, so we use the
     * OpenClaw pattern: add an :eyes: reaction to the inbound message when
     * processing starts and remove it on completion. The reaction is purely
     * visual feedback — Slack ignores duplicate `reactions.add` so we don't
     * refresh on a timer the way Telegram requires.
     *
     * Without an inbound message ref (no meta.ts / no meta.channel — e.g.
     * a slash command sent via Slack's command bar carries the channel id
     * but not a message ts) this becomes a no-op stop function; the user
     * still sees the reply itself which signals progress.
     */
    function startSlackTypingHeartbeat(_action: string, meta?: InboundMeta): () => void {
      const channel = meta?.channel
      const ts = meta?.ts
      const name = 'eyes'
      if (!channel || !ts) return () => {}
      void window.electronAPI.homeAgent.slack
        .sendTypingReaction({ channel, ts, name, action: 'add' })
        .catch(() => {})
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        void window.electronAPI.homeAgent.slack
          .sendTypingReaction({ channel, ts, name, action: 'remove' })
          .catch(() => {})
      }
    }

    // Strip every `aipg-media://…` reference from a text part before sending it
    // to Telegram. ComfyUI tool results already produce the image via
    // `output.images` (shipped as a separate sendPhoto call); the model has the
    // URL in its tool-result context though and often parrots it back in the
    // narration ("You can view it here: aipg-media://AIPG_Image_…png"). On
    // Telegram these URLs are not clickable / addressable, so leaving them in
    // looks like a broken link next to the actual photo.
    const AIPG_MEDIA_URL_TOKEN_RE = /aipg-media:\/\/[^\s)\]]+/
    const AIPG_MEDIA_URL_GLOBAL_RE = /aipg-media:\/\/[^\s)\]]+/g
    // ![alt](aipg-media://…) — pure image token, drop wholesale.
    const AIPG_MEDIA_IMAGE_MD_RE = /!\[[^\]]*]\(aipg-media:\/\/[^)\s]+\)/g
    // [text](aipg-media://…) — markdown link wrapping our URL; drop the whole
    // link (the inner text is usually "view it here" type filler).
    const AIPG_MEDIA_LINK_MD_RE = /\[[^\]]*]\(aipg-media:\/\/[^)\s]+\)/g
    // Optional " · " / "—" / colon-style preamble followed by the URL, possibly
    // wrapped in parens or angle brackets. Catches common narration patterns
    // like "view it here: aipg-media://…" or "(file: aipg-media://…)".
    const AIPG_MEDIA_PHRASING_RE =
      /(?:[(\[<«]\s*)?(?:(?:you\s+can\s+)?(?:view|see|find|open|download|access|check\s+it\s+out)(?:\s+(?:it|the\s+(?:image|file|photo|result|generated\s+image)))?(?:\s+(?:here|at|out))?|here'?s?\s+(?:the\s+)?(?:image|link|file|url|photo|result|generated\s+image)|available(?:\s+at|\s+here)?|saved\s+(?:to|at)|stored\s+at|link|image|file|url|photo|path|location)\s*[:=]?\s*[(<\[«]?\s*aipg-media:\/\/[^\s)\]>»]+\s*[)\]>»]?/gi

    function stripAipgMediaReferences(input: string): string {
      if (!input || !AIPG_MEDIA_URL_TOKEN_RE.test(input)) return input
      let out = input
        .replace(AIPG_MEDIA_IMAGE_MD_RE, '')
        .replace(AIPG_MEDIA_LINK_MD_RE, '')
        .replace(AIPG_MEDIA_PHRASING_RE, '')
        .replace(AIPG_MEDIA_URL_GLOBAL_RE, '')
      // Tidy up the gaps left behind: empty parens / brackets, doubled spaces,
      // and stranded punctuation that used to lead into the URL.
      out = out
        .replace(/\(\s*\)|\[\s*\]|<\s*>/g, '')
        .replace(/[ \t]+([,.!?;])/g, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
      return out.trim()
    }

    // ── Draft streaming helper ────────────────────────────────────────────
    // Wraps Telegram's sendMessageDraft (Bot API 9.5) for animated, in-place
    // updates of a single message while it is being generated. See
    // https://core.telegram.org/bots/api#sendmessagedraft.
    //
    // Behavior:
    //   - 800 ms throttle, "latest text wins" coalescing, to stay under
    //     Telegram's ~1 msg/sec/chat rate limit.
    //   - 25 s keep-alive interval so the 30 s ephemeral preview window does
    //     not lapse during slow phases (model downloads, custom-node installs).
    //   - All draft sends are best-effort: failures are swallowed so a
    //     transient Telegram outage never breaks the actual chat turn. The
    //     final sendMessage (via sendTelegramReply, ie. finalize()) is the
    //     canonical, persisted message — drafts are pure UX gravy.
    const DRAFT_THROTTLE_MS = 800
    const DRAFT_KEEPALIVE_MS = 25_000
    // Telegram only refreshes the 30 s draft preview window when the text
    // actually changes between updates — identical sendMessageDraft calls are
    // no-ops. During quiet phases (LLM paused on a tool call, ComfyUI mid-
    // render) we'd otherwise watch the preamble expire mid-turn. Appending a
    // rotating Braille spinner per keep-alive guarantees the payload differs
    // and incidentally gives the user a small "still working" indicator.
    const DRAFT_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

    function newDraftId(): number {
      // Telegram requires a non-zero int draft_id; uniqueness is only needed
      // across concurrent open drafts in the same chat. Date.now() & 0x7fffffff
      // gives a stable monotonic 31-bit value that fits Python int and JS
      // safe-int comfortably.
      const id = Date.now() & 0x7fffffff
      return id === 0 ? 1 : id
    }

    function createTelegramDraftStream(
      draftId: number,
      parseMode: 'HTML' | 'Markdown' = 'HTML',
    ): DraftStream {
      // `baseText` is the current authoritative content (no spinner suffix).
      // `lastSentVariant` is whatever string was last POSTed to Telegram —
      // possibly with a spinner appended by the keep-alive timer. Tracking
      // them separately stops keep-alive's spinner from spuriously
      // invalidating the throttle's "no real change" check on the next tick.
      let baseText = ''
      let lastSentVariant = ''
      let throttleTimerId: ReturnType<typeof setTimeout> | null = null
      let keepAliveIntervalId: ReturnType<typeof setInterval> | null = null
      let stopped = false
      let spinnerFrame = 0

      async function send(variant: string): Promise<void> {
        try {
          const result = await window.electronAPI.homeAgent.sendTelegramDraft({
            draftId,
            text: variant,
            parseMode,
          })
          if (!result?.success) {
            // Keep lastSentVariant unchanged so the next throttle tick can retry
            // with the same content instead of being skipped as a no-op.
            return
          }
          lastSentVariant = variant
        } catch {
          // Swallow — drafts are best-effort.
        }
      }

      function scheduleSend(): void {
        if (stopped || throttleTimerId !== null) return
        throttleTimerId = setTimeout(() => {
          throttleTimerId = null
          if (stopped || !baseText) return
          if (baseText !== lastSentVariant) void send(baseText)
        }, DRAFT_THROTTLE_MS)
      }

      function startKeepAlive(): void {
        if (keepAliveIntervalId !== null) return
        keepAliveIntervalId = setInterval(() => {
          if (stopped || !baseText) return
          const frame = DRAFT_SPINNER_FRAMES[spinnerFrame % DRAFT_SPINNER_FRAMES.length]
          spinnerFrame++
          void send(`${baseText} ${frame}`)
        }, DRAFT_KEEPALIVE_MS)
      }

      function update(text: string): void {
        if (stopped) return
        // Skip no-op updates so the throttle isn't reset by every poll tick
        // when the source content has not actually advanced.
        if (text === baseText) return
        baseText = text
        if (lastSentVariant === '' && text !== '') {
          // First non-empty update: send immediately for low first-frame
          // latency, and start the keep-alive so the preview survives long
          // gaps between subsequent updates.
          startKeepAlive()
          void send(text)
          return
        }
        scheduleSend()
      }

      function cancel(): void {
        stopped = true
        if (throttleTimerId !== null) {
          clearTimeout(throttleTimerId)
          throttleTimerId = null
        }
        if (keepAliveIntervalId !== null) {
          clearInterval(keepAliveIntervalId)
          keepAliveIntervalId = null
        }
      }

      async function finalize(finalText: string): Promise<void> {
        cancel()
        if (!finalText) return
        try {
          const result = await window.electronAPI.homeAgent.sendTelegramReply(finalText, parseMode)
          if (!result?.success) {
            console.error(
              'homeAgent: draft finalize sendTelegramReply returned error:',
              result?.error ?? 'unknown',
            )
          }
        } catch (e) {
          console.error('homeAgent: draft finalize sendTelegramReply failed:', e)
        }
      }

      return { update, finalize, cancel }
    }

    /**
     * Slack draft stream: post a placeholder via chat.postMessage to capture a
     * `{channel, ts}` handle, then chat.update the same ts on every throttled
     * update. Same 800 ms throttle + spinner pattern as Telegram, minus the
     * keep-alive timer (Slack messages don't auto-expire). Best-effort: any
     * single update failure is swallowed; the final chat.update is the
     * canonical reply.
     */
    function createSlackDraftStream(meta: InboundMeta | undefined): DraftStream {
      const targetChannel = meta?.channel
      let baseText = ''
      let lastSentVariant = ''
      let messageRef: { channel: string; ts: string } | null = null
      let throttleTimerId: ReturnType<typeof setTimeout> | null = null
      let stopped = false
      // Reuse Telegram's spinner suffix logic so transient updates appear
      // animated for the user even when the source content has not advanced.
      let spinnerFrame = 0

      async function ensurePosted(initialText: string): Promise<void> {
        if (messageRef || stopped) return
        try {
          const res = await window.electronAPI.homeAgent.slack.sendReply({
            text: initialText,
            channel: targetChannel,
          })
          if (res.success && res.ts && res.channel) {
            messageRef = { channel: res.channel, ts: res.ts }
            lastSentVariant = initialText
          }
        } catch {
          // best-effort
        }
      }

      async function send(variant: string): Promise<void> {
        if (stopped) return
        if (!messageRef) {
          await ensurePosted(variant)
          return
        }
        try {
          const res = await window.electronAPI.homeAgent.slack.sendUpdate({
            channel: messageRef.channel,
            ts: messageRef.ts,
            text: variant,
          })
          if (res.success) lastSentVariant = variant
        } catch {
          // swallow — draft updates are best-effort
        }
      }

      function scheduleSend(): void {
        if (stopped || throttleTimerId !== null) return
        throttleTimerId = setTimeout(() => {
          throttleTimerId = null
          if (stopped || !baseText) return
          if (baseText !== lastSentVariant) void send(baseText)
        }, DRAFT_THROTTLE_MS)
      }

      function update(text: string): void {
        if (stopped) return
        if (text === baseText) return
        baseText = text
        if (lastSentVariant === '' && text !== '') {
          void send(text)
          return
        }
        // Animate trailing spinner so long quiet phases visibly tick. Slack
        // doesn't *need* this for preview liveness (no 30 s expiry) but the
        // UX matches Telegram's behavior.
        const frame = DRAFT_SPINNER_FRAMES[spinnerFrame % DRAFT_SPINNER_FRAMES.length]
        spinnerFrame++
        baseText = `${text} ${frame}`
        scheduleSend()
      }

      function cancel(): void {
        stopped = true
        if (throttleTimerId !== null) {
          clearTimeout(throttleTimerId)
          throttleTimerId = null
        }
      }

      async function finalize(finalText: string): Promise<void> {
        cancel()
        if (!finalText) return
        try {
          if (messageRef) {
            await window.electronAPI.homeAgent.slack.sendUpdate({
              channel: messageRef.channel,
              ts: messageRef.ts,
              text: finalText,
            })
          } else {
            await window.electronAPI.homeAgent.slack.sendReply({
              text: finalText,
              channel: targetChannel,
            })
          }
        } catch (e) {
          console.error('homeAgent: slack draft finalize failed:', e)
        }
      }

      return { update, finalize, cancel }
    }

    type RawPart = {
      type: string
      text?: string
      state?: string
      input?: { workflow?: string; prompt?: string }
      output?: { images?: { type: string; imageUrl?: string; videoUrl?: string }[] }
      providerMetadata?: { aipg?: { reasoningStarted?: number; reasoningFinished?: number } }
    }

    /**
     * Poll `chatStore.getMessagesForKey(targetKey)` every 250 ms during an
     * agentic turn and stream the in-flight assistant message to Telegram as a
     * single animated draft (sendMessageDraft, Bot API 9.5). Reasoning, text,
     * and tool-call phase markers are concatenated into one growing message
     * that animates in place on the Telegram client, replacing the older
     * per-part discrete-bubble flow.
     *
     * Photos produced by ComfyUI tool calls (output-available) still ship as
     * separate `sendPhoto` messages — drafts are text-only. On flush we
     * finalize the draft with one persisted `sendMessage` carrying the
     * canonical reply (reasoning + text parts + a "Generated using preset X"
     * marker for each completed tool call). The marker stays so the chat scroll
     * preserves the why-this-image context next to the actual photo bubble.
     *
     * Polling (vs. a Vue watcher) keeps this resilient to Pinia store
     * reactivity boundaries — when `chatStore.messages` is replaced wholesale
     * mid-generation, a watcher on a captured `messages` ref would miss the
     * swap.
     */
    function watchAndStreamToChannel(
      adapter: ChannelAdapter,
      targetKey: string,
      meta?: InboundMeta,
    ): () => Promise<void> {
      const sentImagesForPart = new WeakSet<object>()
      let sendChain: Promise<void> = Promise.resolve()
      let stopped = false
      const draft = draftStream(adapter, meta)

      // Snapshot the assistant message that already exists on this thread so we
      // don't stream/ship parts that belong to a previous turn. `chat.sendMessage`
      // pushes the new USER message synchronously but only pushes the new
      // ASSISTANT message on the first stream chunk — until then,
      // `[...msgs].reverse().find(m => m.role === 'assistant')` resolves to the
      // PRIOR assistant (loaded from disk after an AIPG restart, that's the
      // assistant carrying the last generated image's `tool-comfyUI` part with
      // state='output-available'). Acting on it here would replay the previous
      // turn's draft text and re-ship its image to Telegram on every new turn.
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

      // Render a single tool-comfyUI / tool-comfyUiImageEdit part. `verb`
      // controls the lead phrase so the live draft reads "Generating using …"
      // (active) and the persisted final reads "Generated using …" (past tense,
      // since by flush time the tool call has resolved). Output is channel-
      // native (Telegram HTML vs Slack mrkdwn) so it can be concatenated
      // straight into the draft text without further conversion.
      function renderImageToolPart(part: RawPart, verb: 'Generating' | 'Generated'): string | null {
        const { workflow, prompt } = part.input ?? {}
        if (!workflow && !prompt) return null
        const phase = part.state === 'output-available' ? '✅' : '🎨'
        if (adapter.kind === 'slack') {
          const titleBase = workflow ? `${verb} using preset _${workflow}_` : `${verb} image`
          const noticeLines = [`${phase} ${titleBase}`]
          if (prompt) noticeLines.push(`_${prompt}_`)
          return noticeLines.join('\n')
        }
        const titleBase = workflow
          ? `${verb} using preset <i>${escapeHtml(workflow)}</i>`
          : `${verb} image`
        const noticeLines = [`${phase} ${titleBase}`]
        if (prompt) noticeLines.push(`<i>${escapeHtml(prompt)}</i>`)
        return noticeLines.join('\n')
      }

      function buildDraftText(parts: RawPart[]): string {
        const lines: string[] = []
        for (const part of parts) {
          if (part.type === 'reasoning') {
            const txt = (part.text ?? '').trim()
            if (!txt) continue
            if (adapter.kind === 'slack') {
              lines.push(
                txt
                  .split('\n')
                  .map((l) => (l ? `> 💭 ${l}` : '>'))
                  .join('\n'),
              )
            } else {
              lines.push(`<blockquote>💭 ${escapeHtml(txt)}</blockquote>`)
            }
          } else if (part.type === 'text') {
            const cleaned = stripAipgMediaReferences(part.text ?? '').trim()
            if (cleaned) lines.push(adapter.formatMarkdown(cleaned))
          } else if (part.type === 'tool-comfyUI' || part.type === 'tool-comfyUiImageEdit') {
            const marker = renderImageToolPart(part, 'Generating')
            if (marker) lines.push(marker)
          }
        }
        return lines.join('\n\n')
      }

      function buildFinalText(parts: RawPart[]): string {
        const lines: string[] = []
        // Coalesce all reasoning parts in this turn into a single expandable
        // blockquote with a "Thought for X.X seconds" header, a blank line,
        // and the full reasoning transcript. Each reasoning part carries its
        // own start/finish timestamps via providerMetadata.aipg (set in
        // openAiCompatibleChat's customFetch onChunk handler); the SDK can
        // emit several reasoning blocks per turn (e.g. across tool-call
        // cycles) so we sum per-block elapsed durations rather than spanning
        // earliest-start → latest-finish — that keeps tool-execution gaps out
        // of the reported figure.
        let reasoningElapsedMs = 0
        const reasoningChunks: string[] = []
        for (const part of parts) {
          if (part.type !== 'reasoning') continue
          const txt = (part.text ?? '').trim()
          if (!txt) continue
          reasoningChunks.push(txt)
          const timing = part.providerMetadata?.aipg
          if (timing?.reasoningStarted && timing?.reasoningFinished) {
            reasoningElapsedMs += Math.max(0, timing.reasoningFinished - timing.reasoningStarted)
          }
        }
        if (reasoningChunks.length > 0) {
          const seconds = (reasoningElapsedMs / 1000).toFixed(1)
          if (adapter.kind === 'slack') {
            // Slack has no expandable blockquote; emit a single quoted block
            // with the timing header at the top.
            const body = reasoningChunks.join('\n\n')
            const quoted = `💭 _Thought for ${seconds} seconds_\n\n${body}`
              .split('\n')
              .map((l) => (l ? `> ${l}` : '>'))
              .join('\n')
            lines.push(quoted)
          } else {
            const header = `💭 <i>Thought for ${seconds} seconds</i>`
            const body = reasoningChunks.map((t) => escapeHtml(t)).join('\n\n')
            // Single <blockquote expandable> so Telegram collapses both the
            // header and the transcript together by default.
            lines.push(`<blockquote expandable>${header}\n\n${body}</blockquote>`)
          }
        }
        for (const part of parts) {
          if (part.type === 'reasoning') {
            // Replaced by the coalesced expandable summary above.
            continue
          } else if (part.type === 'text') {
            const cleaned = stripAipgMediaReferences(part.text ?? '').trim()
            if (cleaned) lines.push(adapter.formatMarkdown(cleaned))
          } else if (part.type === 'tool-comfyUI' || part.type === 'tool-comfyUiImageEdit') {
            // Persist the tool marker too — the live draft showed
            // "Generating using preset X"; the persisted message reads
            // "Generated using preset X" so the photo bubble below it keeps
            // its surrounding context.
            const marker = renderImageToolPart(part, 'Generated')
            if (marker) lines.push(marker)
          }
        }
        return lines.join('\n\n')
      }

      function shipPendingImages(parts: RawPart[]) {
        for (const part of parts) {
          if (part.type !== 'tool-comfyUI' && part.type !== 'tool-comfyUiImageEdit') continue
          if (part.state !== 'output-available') continue
          if (sentImagesForPart.has(part as object)) continue
          sentImagesForPart.add(part as object)
          const images =
            part.output?.images?.filter(
              (i): i is { type: string; imageUrl: string } =>
                i.type === 'image' && typeof i.imageUrl === 'string',
            ) ?? []
          if (images.length === 0) continue
          enqueueImage(async () => {
            for (const img of images) {
              await sendImageToChannel(adapter, img.imageUrl, '', meta)
            }
          })
        }
      }

      function tick() {
        const msgs = chatStore.getMessagesForKey(targetKey) ?? []
        const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
        if (!lastAssistant) return
        // Ignore the pre-existing assistant from a previous turn — it would
        // otherwise replay its old draft text and re-ship its old image.
        if (lastAssistant.id === preExistingAssistantId) return
        const parts = lastAssistant.parts as RawPart[]
        const draftText = buildDraftText(parts)
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
        // Same guard as `tick()`: if the stream produced no new assistant (e.g.
        // it errored before any chunk arrived), the prior turn's assistant is
        // still on top — do not finalize with its content.
        const isStaleAssistant = !lastAssistant || lastAssistant.id === preExistingAssistantId
        const parts = isStaleAssistant ? [] : (lastAssistant!.parts as RawPart[])
        shipPendingImages(parts)
        const finalText = buildFinalText(parts)
        await draft.finalize(finalText)
        await sendChain
      }
    }

    async function handleAgenticMessage(
      adapter: ChannelAdapter,
      text: string,
      images?: RemoteImage[],
      meta?: InboundMeta,
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
        const base64 = await imageToBase64(imageUrl)
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

    async function imageToBase64(imageUrl: string): Promise<string> {
      if (imageUrl.startsWith('aipg-media://')) {
        const result = await window.electronAPI.readAipgMediaAsBase64(imageUrl)
        if (!result.success) {
          throw new Error(`readAipgMediaAsBase64 failed: ${result.error}`)
        }
        return result.data
      }
      if (imageUrl.startsWith('data:image/')) {
        const comma = imageUrl.indexOf('base64,')
        if (comma === -1) throw new Error('Malformed image data URI')
        return imageUrl.slice(comma + 'base64,'.length)
      }
      const resp = await fetch(imageUrl)
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
     * After generate() is called, wait for all newly enqueued images to finish
     * (done or stopped/error) sending each one to Telegram as soon as it's ready.
     * Returns when all images have been handled or the timeout expires.
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

          if (img.state === 'done' && isImage(img) && img.imageUrl) {
            sentIds.add(id)
            await sendImageToChannel(adapter, img.imageUrl, prompt, meta)
          } else if (img.state === 'stopped') {
            sentIds.add(id) // count as handled, don't send
          }
        }

        // Check for global error state
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

        // All images handled
        if (sentIds.size === newImageIds.size) return
      }

      // Timeout — report images that never completed
      const unsent = [...newImageIds].filter((id) => !sentIds.has(id))
      if (unsent.length > 0) {
        await reply(adapter, `⚠️ ${unsent.length} image(s) timed out and were not sent.`, meta)
      }
    }

    /** Clear `pendingImgGen` if its deadline has elapsed. Cheap; safe to call on every queue iteration. */
    function expireImgGenPendingIfStale(): void {
      const p = pendingImgGen.value
      if (p && Date.now() > p.deadline) {
        pendingImgGen.value = null
      }
    }

    /**
     * Show an inline-keyboard preset picker for /imgGen.
     *
     * `cachedPrompt` carries any text the user typed after the slash command
     * (e.g. `/imgGen a sunset over snowy mountains`) so we can generate
     * immediately once they tap a preset — no second message required.
     */
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

      // `getPresetsByCategories` already returns sorted by displayPriority desc.
      // Drop presets that opt out via the `excludeFromHomeAgentPicker` flag — those
      // need extra UI configuration (reference images, manual model picks, etc.)
      // and can't be driven cleanly via a chat command.
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
      // gate on the tighter Telegram cap so the same picker works for either
      // channel.
      const encoder = new TextEncoder()
      const buttons: Array<Array<{ text: string; callbackData: string }>> = []
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
     * Map the live ComfyUI/imageGen state machine to a one-line phase string
     * for the draft preview. Driven on a 500 ms interval inside
     * `runImgGenWithPreset` so the user sees animated transitions through
     * `install_workflow_components` → `load_*` → `generating N/M` → photo.
     */
    function imgGenPhaseText(adapter: ChannelAdapter, presetName: string): string {
      const state = imageGenStore.currentState
      const step = imageGenStore.stepText
      const slack = adapter.kind === 'slack'
      switch (state) {
        case 'install_workflow_components':
          return '🛠 Installing workflow components…'
        case 'load_workflow_components':
          return '🧠 Loading workflow components…'
        case 'load_model':
        case 'load_model_components':
          return '🎨 Loading model…'
        case 'generating':
          if (!step) return '✨ Generating…'
          return slack ? `✨ ${step}` : `✨ ${escapeHtml(step)}`
        case 'image_out':
          return '🖼 Finalizing image…'
        case 'error':
        case 'no_start':
        default:
          return slack
            ? `🎬 Preparing _${presetName}_…`
            : `🎬 Preparing <i>${escapeHtml(presetName)}</i>…`
      }
    }

    /**
     * Generate an image using the named preset and the given prompt. Reused by
     * both the cached-prompt fast-path (preset tap with prompt already supplied)
     * and the awaitingPrompt → free-text path (preset tap, then prompt arrives).
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
      // `upload_photo` so Telegram shows "sending a photo…" rather than
      // "typing…" during the ComfyUI render — matches the eventual delivery.
      // Slack ignores the action name and just toggles the :eyes: reaction.
      const stopTyping = typing(adapter, 'upload_photo', meta)

      // Phase-aware draft. Drafts auto-expire 30 s after the last update on
      // Telegram (Slack has no expiry), so the keep-alive timer inside
      // `createTelegramDraftStream` covers the gap between ComfyUI state
      // transitions during long model loads.
      const draft = draftStream(adapter, meta)
      let phaseStopped = false
      const updateDraftPhase = () => {
        if (phaseStopped) return
        draft.update(imgGenPhaseText(adapter, presetName))
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
          const presetLabel =
            adapter.kind === 'slack' ? `_${presetName}_` : `<i>${escapeHtml(presetName)}</i>`
          const errLabel =
            adapter.kind === 'slack'
              ? (switchResult.error ?? 'unknown error')
              : escapeHtml(switchResult.error ?? 'unknown error')
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

    /**
     * Handle a preset-button tap from the inline keyboard.
     *
     * If the picker was opened with a cached prompt (user ran `/imgGen <text>`),
     * we generate immediately. Otherwise we transition to `awaitingPrompt` and
     * wait for the next plain-text message.
     */
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
     * dispatches them through `adapter`. The busy flag (`isBusy`) is captured
     * via getter/setter so the module-level `telegramDrainBusy` / `slackDrainBusy`
     * variables can be flipped without needing an object wrapper.
     */
    async function drainCommonQueue(
      queue: RemoteQueueItem[],
      adapter: ChannelAdapter,
      isActiveRef: typeof isTelegramActive,
      isBusyGetter: () => boolean,
      isBusySetter: (v: boolean) => void,
    ) {
      if (isBusyGetter()) return
      isBusySetter(true)
      try {
        while (queue.length > 0 && isActiveRef.value) {
          const item = queue.shift()!
          const meta = item.meta
          expireImgGenPendingIfStale()

          // Inline-keyboard taps from the /imgGen preset picker arrive with a
          // `callback` field instead of `text` — route them before any
          // text-based regex matching.
          if (item.callback) {
            try {
              if (item.callback === 'imgGen:cancel') {
                await handleImgGenCancel(adapter, meta)
              } else if (item.callback.startsWith('imgGen:preset:')) {
                const name = item.callback.slice('imgGen:preset:'.length)
                await handleImgGenPresetCallback(adapter, name, meta)
              }
            } catch (e) {
              console.error(`Error processing ${adapter.kind} callback:`, e)
            }
            continue
          }

          const text = item.text ?? ''
          const images = item.images
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
                // `arg` is user-supplied from `/load <id>` — keep the original
                // HTML markers for Telegram; the adapter's formatRichSnippet
                // strips them for Slack and the inner text remains intact.
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
                // /imgGen is text-to-image — the photo is not used as reference.
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
                await handleChatMessage(adapter, msg, images, meta)
              } else {
                focusRemoteChatDiscussion()
                await reply(
                  adapter,
                  '⚠️ Please add a message after the command.\nExample: <code>/chat Hello, world!</code>',
                  meta,
                )
              }
            } else if (pendingImgGen.value?.phase === 'awaitingPrompt') {
              // After the user tapped a preset, the next plain-text message
              // becomes the prompt. Photo-only messages (text === '[image]')
              // are rejected with a reminder — /imgGen is text-only.
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
              // The picker keyboard is still up; remind the user to tap a button.
              await reply(adapter, '🖼️ Tap a preset above, or /cancel to dismiss the picker.', meta)
            } else {
              // Agentic mode — AI decides whether to chat or generate an image.
              // For photo-only messages the Python side queues "[image]" as a
              // placeholder; clear it so the model isn't biased by a literal token.
              const agenticText = images?.length && text === '[image]' ? '' : text
              await handleAgenticMessage(adapter, agenticText, images, meta)
            }
          } catch (e) {
            console.error(`Error processing ${adapter.kind} message:`, e)
          }
        }
      } finally {
        isBusySetter(false)
      }
    }

    // ── Channel adapters ──────────────────────────────────────────────────
    // Defined after all the helpers they wrap so they can close over them.
    // Method-shorthand keeps lookups lazy — the adapter object is constructed
    // at setup time but each method body only runs at invocation, by which
    // point every referenced helper exists.
    const telegramAdapter: ChannelAdapter = {
      kind: 'telegram',
      formatMarkdown: markdownToTelegramHtml,
      formatRichSnippet: (s) => s, // Telegram already speaks HTML
      sendReply: async (text, _opts) => {
        const r = await window.electronAPI.homeAgent.sendTelegramReply(text, 'HTML')
        return { success: r.success, error: r.error, ref: r.success ? { draftId: 0 } : undefined }
      },
      sendPhoto: async (base64, caption) => {
        return window.electronAPI.homeAgent.sendTelegramPhoto(base64, caption)
      },
      sendKeyboard: async ({ text, buttons }) => {
        return window.electronAPI.homeAgent.sendTelegramKeyboard({
          text,
          parseMode: 'HTML',
          buttons,
        })
      },
      startTypingHeartbeat: (action) => startTelegramTypingHeartbeat(action),
      createDraftStream: () => createTelegramDraftStream(newDraftId(), 'HTML'),
    }

    const slackAdapter: ChannelAdapter = {
      kind: 'slack',
      formatMarkdown: markdownToSlackMrkdwn,
      formatRichSnippet: htmlSnippetToSlackMrkdwn,
      sendReply: async (text, opts) => {
        const r = await window.electronAPI.homeAgent.slack.sendReply({
          text,
          channel: opts?.meta?.channel,
        })
        return {
          success: r.success,
          error: r.error,
          ref: r.success && r.ts && r.channel ? { ts: r.ts, channel: r.channel } : undefined,
        }
      },
      sendPhoto: async (base64, caption, opts) => {
        return window.electronAPI.homeAgent.slack.sendPhoto({
          imageBase64: base64,
          caption,
          channel: opts?.meta?.channel,
        })
      },
      sendKeyboard: async ({ text, buttons, meta }) => {
        // Translate the channel-agnostic button matrix into Block Kit actions.
        // Slack limits 5 buttons per actions block and 25 elements per message,
        // so we break wide rows across multiple actions blocks. Action labels
        // truncate at 75 chars per Slack's spec.
        const blocks: Array<Record<string, unknown>> = [
          { type: 'section', text: { type: 'mrkdwn', text } },
        ]
        for (const row of buttons) {
          for (let i = 0; i < row.length; i += 5) {
            const slice = row.slice(i, i + 5)
            blocks.push({
              type: 'actions',
              elements: slice.map((b) => ({
                type: 'button',
                text: { type: 'plain_text', text: b.text.slice(0, 75) },
                action_id: b.callbackData.slice(0, 255),
                value: b.callbackData.slice(0, 2000),
              })),
            })
          }
        }
        const r = await window.electronAPI.homeAgent.slack.sendKeyboard({
          text,
          blocks,
          channel: meta?.channel,
        })
        return { success: r.success, error: r.error }
      },
      startTypingHeartbeat: (action, meta) => startSlackTypingHeartbeat(action, meta),
      createDraftStream: (opts) => createSlackDraftStream(opts?.meta),
    }

    async function processTelegramMessages() {
      try {
        const msgs = await window.electronAPI.homeAgent.pollTelegram()
        if (!msgs || msgs.length === 0) return
        for (const msg of msgs) {
          if (_messageQueue.length >= MAX_QUEUE_SIZE) {
            toast.warning('Home Agent: message queue full, dropping oldest message.')
            _messageQueue.shift()
          }
          _messageQueue.push({ text: msg.text, images: msg.images, callback: msg.callback })
        }
        void drainCommonQueue(
          _messageQueue,
          telegramAdapter,
          isTelegramActive,
          () => telegramDrainBusy,
          (v) => {
            telegramDrainBusy = v
          },
        )
      } catch (e) {
        console.error('Error polling Telegram:', e)
      }
    }

    async function processSlackMessages() {
      try {
        const msgs = await window.electronAPI.homeAgent.slack.pollSlack()
        if (!msgs || msgs.length === 0) return
        for (const msg of msgs) {
          if (_slackQueue.length >= MAX_QUEUE_SIZE) {
            toast.warning('Home Agent: Slack queue full, dropping oldest message.')
            _slackQueue.shift()
          }
          _slackQueue.push({
            text: msg.text,
            images: msg.images,
            callback: msg.callback,
            // Thread the inbound metadata so the Slack adapter can target
            // reactions / threaded sends at the originating message.
            meta: { channel: msg.channel, ts: msg.ts, chatId: msg.chat_id },
          })
        }
        void drainCommonQueue(
          _slackQueue,
          slackAdapter,
          isSlackActive,
          () => slackDrainBusy,
          (v) => {
            slackDrainBusy = v
          },
        )
      } catch (e) {
        console.error('Error polling Slack:', e)
      }
    }

    function startTelegramPolling() {
      disposeTelegramPollHandlers()
      telegramPollIntervalId = setInterval(() => {
        void processTelegramMessages()
      }, POLL_INTERVAL_MS)
    }

    function stopTelegramPolling() {
      disposeTelegramPollHandlers()
      _messageQueue.length = 0
    }

    function startSlackPolling() {
      disposeSlackPollHandlers()
      slackPollIntervalId = setInterval(() => {
        void processSlackMessages()
      }, POLL_INTERVAL_MS)
    }

    function stopSlackPolling() {
      disposeSlackPollHandlers()
      _slackQueue.length = 0
    }

    async function saveConfig(
      token: string,
      chatId: string,
    ): Promise<{ success: boolean; error?: string }> {
      try {
        const result = await window.electronAPI.homeAgent.saveConfig(token, chatId)
        if (result.success) {
          const configChanged = token !== telegramToken.value || chatId !== telegramChatId.value
          telegramToken.value = token
          telegramChatId.value = chatId
          // Reset verified only when credentials actually change — must re-verify
          if (configChanged) {
            telegramVerified.value = false
            isTelegramActive.value = false
            _telegramUserDisabled = false
          }
        }
        return result
      } catch (e) {
        console.error('homeAgent.saveConfig failed:', e)
        return { success: false, error: String(e) }
      }
    }

    async function clearConfig(): Promise<void> {
      try {
        await window.electronAPI.homeAgent.clearConfig()
      } catch (e) {
        console.error('homeAgent.clearConfig failed:', e)
      }
      telegramToken.value = null
      telegramChatId.value = null
      telegramVerified.value = false
      isTelegramActive.value = false
      _telegramUserDisabled = false
    }

    function setVerified() {
      telegramVerified.value = true
    }

    // ── Slack config + activation ────────────────────────────────────────
    async function saveSlackConfig(
      botToken: string,
      appToken: string,
      userId: string,
    ): Promise<{ success: boolean; error?: string }> {
      try {
        const result = await window.electronAPI.homeAgent.slack.saveConfig(
          botToken,
          appToken,
          userId,
        )
        if (result.success) {
          const changed =
            botToken !== slackBotToken.value ||
            appToken !== slackAppToken.value ||
            userId !== slackUserId.value
          slackBotToken.value = botToken
          slackAppToken.value = appToken
          slackUserId.value = userId
          if (changed) {
            slackVerified.value = false
            isSlackActive.value = false
            _slackUserDisabled = false
          }
        }
        return result
      } catch (e) {
        console.error('homeAgent.saveSlackConfig failed:', e)
        return { success: false, error: String(e) }
      }
    }

    async function clearSlackConfig(): Promise<void> {
      try {
        await window.electronAPI.homeAgent.slack.clearConfig()
      } catch (e) {
        console.error('homeAgent.clearSlackConfig failed:', e)
      }
      slackBotToken.value = null
      slackAppToken.value = null
      slackUserId.value = null
      slackVerified.value = false
      isSlackActive.value = false
      _slackUserDisabled = false
    }

    function setSlackVerified() {
      slackVerified.value = true
    }

    function activate() {
      if (!isAvailable.value) {
        toast.error(
          'Home Agent is not installed. Please install it from App Settings → Installation Management.',
        )
        return
      }
      if (!isReadyToActivate.value) {
        toast.error('Complete Telegram setup and verify the connection in Setup Wizard.')
        return
      }
      _telegramUserDisabled = false
      isTelegramActive.value = true
      focusRemoteChatDiscussion()
    }

    function activateSlack() {
      if (!isAvailable.value) {
        toast.error(
          'Home Agent is not installed. Please install it from App Settings → Installation Management.',
        )
        return
      }
      if (!isSlackReadyToActivate.value) {
        toast.error('Complete Slack setup and verify the connection in Setup Wizard.')
        return
      }
      _slackUserDisabled = false
      isSlackActive.value = true
      focusRemoteChatDiscussion()
    }

    /** Toggle a specific channel, or both at once when `kind` is omitted (the
     *  no-arg form preserves back-compat for callers like `HomeAgentToggle`). */
    function toggle(kind?: ChannelKind) {
      if (kind === 'slack') {
        if (isSlackActive.value) {
          _slackUserDisabled = true
          isSlackActive.value = false
        } else {
          activateSlack()
        }
        return
      }
      if (kind === 'telegram') {
        if (isTelegramActive.value) {
          _telegramUserDisabled = true
          isTelegramActive.value = false
        } else {
          activate()
        }
        return
      }
      // No kind specified — toggle the umbrella state. If anything is on, turn
      // every configured-and-active channel off; otherwise turn each ready
      // channel on. Matches the back-compat semantics of the original toggle().
      if (isHomeAgentActive.value) {
        if (isTelegramActive.value) {
          _telegramUserDisabled = true
          isTelegramActive.value = false
        }
        if (isSlackActive.value) {
          _slackUserDisabled = true
          isSlackActive.value = false
        }
      } else {
        if (isReadyToActivate.value) activate()
        if (isSlackReadyToActivate.value) activateSlack()
      }
    }

    // Load token from safeStorage (not persisted to disk for security).
    // *Verified and *ChatId/*UserId ARE persisted via Pinia, so they are
    // already populated synchronously before this resolves.
    async function initConfig() {
      try {
        // Resolve the feature flag first; when it's off there is no Home Agent
        // backend / IPC bridge to load credentials from, so skip the rest.
        try {
          const localSettings = await window.electronAPI.getLocalSettings()
          isFeatureEnabled.value = !!localSettings.isHomeAgentEnabled
        } catch (e) {
          console.error('homeAgent.initConfig: getLocalSettings failed:', e)
          isFeatureEnabled.value = false
        }
        if (!isFeatureEnabled.value) {
          telegramToken.value = null
          telegramChatId.value = null
          telegramVerified.value = false
          isTelegramActive.value = false
          slackBotToken.value = null
          slackAppToken.value = null
          slackUserId.value = null
          slackVerified.value = false
          isSlackActive.value = false
          return
        }
        const cfg = await window.electronAPI.homeAgent.loadConfig()
        if (cfg) {
          telegramToken.value = cfg.token
          telegramChatId.value = cfg.chatId
        } else if (!telegramVerified.value) {
          // No Telegram config in safeStorage — clear only if nothing was persisted.
          telegramToken.value = null
          telegramChatId.value = null
          isTelegramActive.value = false
        }
        const slackCfg = await window.electronAPI.homeAgent.slack.loadConfig()
        if (slackCfg) {
          slackBotToken.value = slackCfg.botToken
          slackAppToken.value = slackCfg.appToken
          slackUserId.value = slackCfg.userId || null
        } else if (!slackVerified.value) {
          slackBotToken.value = null
          slackAppToken.value = null
          slackUserId.value = null
          isSlackActive.value = false
        }
      } catch (e) {
        console.error('homeAgent.initConfig failed:', e)
      }
    }

    void initConfig()

    return {
      isFeatureEnabled,
      isHomeAgentActive,
      isTelegramActive,
      isSlackActive,
      isTelegramConfigured,
      isSlackConfigured,
      isReadyToActivate,
      isSlackReadyToActivate,
      telegramVerified,
      telegramChatId,
      telegramToken,
      slackVerified,
      slackUserId,
      slackBotToken,
      slackAppToken,
      isAvailable,
      homeAgentBaseUrl,
      // Remote conversation registry
      activeRemoteConversationKey,
      remoteConversationKeys,
      createNewRemoteConversation,
      switchRemoteConversation,
      ensureActiveRemoteConversation,
      listRemoteConversations,
      // Settings panel visibility (consumed by App.vue + HomeAgentToggle.vue)
      showSettings,
      openSettings,
      closeSettings,
      // Bare-/load summary cache (persisted)
      summaryCache,
      summarizeConversation,
      activate,
      activateSlack,
      toggle,
      saveConfig,
      clearConfig,
      setVerified,
      saveSlackConfig,
      clearSlackConfig,
      setSlackVerified,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      // telegramChatId persisted (non-sensitive) for display purposes.
      // *Verified flags persisted — the key signals for "ready to activate".
      // Tokens NOT persisted — they live only in safeStorage on the Electron side.
      // isHomeAgentActive / per-channel actives NOT persisted — re-derived on
      //   startup by watchers (isAvailable is false until the backend service
      //   reports ready).
      // activeRemoteConversationKey persisted so /load <id> survives restart and
      //   the same Telegram or Slack thread keeps draining into its bucket.
      // summaryCache persisted so /load menu summaries survive restarts.
      pick: [
        'telegramVerified',
        'telegramChatId',
        'slackVerified',
        'slackUserId',
        'activeRemoteConversationKey',
        'summaryCache',
      ],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeTelegramPollHandlers()
    disposeSlackPollHandlers()
    telegramDrainBusy = false
    slackDrainBusy = false
  })
  import.meta.hot.accept(acceptHMRUpdate(useHomeAgent, import.meta.hot))
}
