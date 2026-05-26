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
import * as toast from '../toast'

type TelegramImage = { mime: string; data_base64: string }
type TelegramQueueItem = { text?: string; images?: TelegramImage[]; callback?: string }

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

function disposeTelegramPollHandlers() {
  if (telegramPollIntervalId !== null) {
    clearInterval(telegramPollIntervalId)
    telegramPollIntervalId = null
  }
}

/** Module-level so HMR release doesn't strand drainQueue mid-patch. */
let telegramDrainBusy = false

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
    const isHomeAgentActive = ref(false)
    const telegramToken = ref<string | null>(null)
    const telegramChatId = ref<string | null>(null)
    const telegramVerified = ref(false)

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
    let _userDisabled = false

    const isTelegramConfigured = computed(() => !!telegramToken.value && !!telegramChatId.value)

    // "Ready to activate" = previously verified. telegramVerified is persisted,
    // so this is true immediately on startup if the user verified in a previous run.
    const isReadyToActivate = computed(() => telegramVerified.value)

    const isAvailable = computed(
      () =>
        isFeatureEnabled.value &&
        backendServices.info.find((s) => s.serviceName === 'home-agent-backend')?.status ===
          'running',
    )

    const homeAgentBaseUrl = computed(
      () => backendServices.info.find((s) => s.serviceName === 'home-agent-backend')?.baseUrl,
    )

    // When the backend becomes available and Telegram has been verified, auto-activate.
    watch(isAvailable, (val) => {
      if (val && isReadyToActivate.value && !_userDisabled) {
        isHomeAgentActive.value = true
      }
      if (!val) {
        isHomeAgentActive.value = false
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

    // When verification state changes, sync active state.
    watch(isReadyToActivate, (val) => {
      if (!val) {
        isHomeAgentActive.value = false
      } else if (isAvailable.value && !_userDisabled) {
        isHomeAgentActive.value = true
      }
    })

    // Start/stop Telegram polling when active state changes
    watch(isHomeAgentActive, (val) => {
      if (val) {
        startPolling()
      } else {
        stopPolling()
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

    /**
     * Pin the live preset/backend to Home Agent and prep inference so the
     * summarizer uses the bundled Home Agent model. Returns `false` and replies
     * to Telegram with an error if readiness fails. Used by both `/load` (bare)
     * and `/history` before they fan out summary calls.
     *
     * Lazy-instantiates `useTextInference` to avoid the documented setup-time
     * cycle with this store.
     */
    async function ensureSummarizerReady(): Promise<boolean> {
      const textInference = useTextInference()
      textInference.applyPresetToGlobals(HOME_AGENT_CHAT_PRESET_NAME, null)
      try {
        await textInference.ensureReadyForInference()
        return true
      } catch (e) {
        console.error('homeAgent: ensureReadyForInference for summary failed:', e)
        await window.electronAPI.homeAgent.sendTelegramReply(
          '⚠️ Could not prepare the model to summarize chats. Try again later.',
        )
        return false
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
    async function handleLoadMenu(): Promise<void> {
      focusRemoteChatDiscussion()

      const candidates = listRemoteConversations().slice(0, 3)
      if (candidates.length === 0) {
        await window.electronAPI.homeAgent.sendTelegramReply(
          '📭 No saved chats yet. Send a message to start one.',
        )
        return
      }

      // Quick acknowledgement so the user knows the bot is working — summary
      // generation can take a few seconds (3 sequential LLM calls worst case).
      await window.electronAPI.homeAgent.sendTelegramReply('🤔 Preparing recent chats…')

      const stopTyping = startTypingHeartbeat('typing')
      try {
        if (!(await ensureSummarizerReady())) return

        const items: Array<{ key: string; label: string }> = []
        for (const c of candidates) {
          const summary = await summarizeConversation(c.key)
          const label = c.isActive ? `${summary} (active)` : summary
          items.push({ key: c.key, label })
        }

        const buttons = items.map((it) => [{ text: it.label, callbackData: `loadConv:${it.key}` }])

        await window.electronAPI.homeAgent.sendTelegramKeyboard({
          text: '📂 Pick a chat to resume:',
          parseMode: 'HTML',
          buttons,
        })
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
    async function handleHistoryCommand(): Promise<void> {
      focusRemoteChatDiscussion()

      const items = listRemoteConversations()
      if (items.length === 0) {
        await window.electronAPI.homeAgent.sendTelegramReply(
          '📭 No saved Home Agent chat threads yet. Send a message to start one.',
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
      const stopTyping = anyNeedsGen ? startTypingHeartbeat('typing') : () => {}
      try {
        if (anyNeedsGen) {
          await window.electronAPI.homeAgent.sendTelegramReply('🤔 Preparing chat history…')
          if (!(await ensureSummarizerReady())) return
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

        await window.electronAPI.homeAgent.sendTelegramReply(
          '📜 <b>Your Home Agent chats</b>\n\n' +
            lines.join('\n') +
            footer +
            '\n\nResume one with <code>/load &lt;id&gt;</code> or just <code>/load</code> for a tap menu.',
          'HTML',
        )
      } finally {
        stopTyping()
      }
    }

    /**
     * Convert Telegram image payloads into persisted `aipg-media://` URLs and
     * return them as AI SDK `FileUIPart`s. Returns `undefined` for empty input
     * so callers can pass the value straight through to `chat.sendMessage`.
     */
    async function prepareTelegramFiles(
      images: TelegramImage[] | undefined,
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
            filename: `telegram-${Date.now()}-${i}.${ext}`,
          })
        } catch (e) {
          console.error('homeAgent: failed to persist Telegram image:', e)
        }
      }
      return parts.length > 0 ? parts : undefined
    }

    /**
     * If the active chat model does not support vision, reply to Telegram and
     * return `false` so the caller skips inference. Returns `true` when it's
     * safe to proceed (no images, or model supports vision).
     */
    async function ensureVisionCapableForImages(hasImages: boolean): Promise<boolean> {
      if (!hasImages) return true
      // Lazy instantiation: textInference imports useHomeAgent at top of its setup;
      // calling useTextInference() here (not in this store's setup body) avoids
      // a circular setup-time dependency. Same pattern as presetSwitching.
      const textInference = useTextInference()
      if (textInference.modelSupportsVision) return true
      await window.electronAPI.homeAgent.sendTelegramReply(
        '⚠️ The active chat model does not support images. Select a vision-capable model in Chat settings, then resend the image.',
      )
      return false
    }

    async function handleChatMessage(text: string, images?: TelegramImage[]): Promise<void> {
      focusRemoteChatDiscussion()
      const targetKey = ensureActiveRemoteConversation()
      if (!(await ensureVisionCapableForImages(!!images?.length))) return
      const files = await prepareTelegramFiles(images)
      const stopTyping = startTypingHeartbeat('typing')
      try {
        await chatStore.generate(text, {
          conversationKey: targetKey,
          clearInputs: false,
          files,
        })
        maybeSetHomeAgentConversationTitle(targetKey)
        if (!isHomeAgentActive.value) return
        const reply = extractAssistantReply(chatStore.getMessagesForKey(targetKey))
        if (reply) {
          await window.electronAPI.homeAgent.sendTelegramReply(
            markdownToTelegramHtml(reply),
            'HTML',
          )
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
    function startTypingHeartbeat(action: string = 'typing'): () => void {
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

    // Strip pattern for inline aipg-media image markdown tokens. The streaming
    // watcher removes them from text parts before sending — ComfyUI tool calls
    // already produce the same image via their `output.images` array, and the
    // inline markdown form would otherwise duplicate it on Telegram.
    const AIPG_IMAGE_MD_STRIP_RE = /!\[[^\]]*]\(aipg-media:\/\/[^)]+\)/g

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

    type DraftStream = {
      update: (text: string) => void
      finalize: (finalText: string, finalParseMode?: string) => Promise<void>
      cancel: () => void
    }

    function createDraftStream(
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
          await window.electronAPI.homeAgent.sendTelegramDraft({
            draftId,
            text: variant,
            parseMode,
          })
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

      async function finalize(finalText: string, finalParseMode?: string): Promise<void> {
        cancel()
        if (!finalText) return
        try {
          await window.electronAPI.homeAgent.sendTelegramReply(
            finalText,
            finalParseMode ?? parseMode,
          )
        } catch (e) {
          console.error('homeAgent: draft finalize sendTelegramReply failed:', e)
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
     * canonical reply (reasoning + text parts; tool phase markers are dropped
     * because the photo itself is the durable artifact of that step).
     *
     * Polling (vs. a Vue watcher) keeps this resilient to Pinia store
     * reactivity boundaries — when `chatStore.messages` is replaced wholesale
     * mid-generation, a watcher on a captured `messages` ref would miss the
     * swap.
     */
    function watchAndStreamToTelegram(targetKey: string): () => Promise<void> {
      const sentImagesForPart = new WeakSet<object>()
      let sendChain: Promise<void> = Promise.resolve()
      let stopped = false
      const draft = createDraftStream(newDraftId(), 'HTML')

      function enqueueImage(fn: () => Promise<unknown>) {
        sendChain = sendChain
          .then(() => fn())
          .then(() => undefined)
          .catch((e) => console.error('homeAgent stream image send failed:', e))
      }

      function buildDraftText(parts: RawPart[]): string {
        const lines: string[] = []
        for (const part of parts) {
          if (part.type === 'reasoning') {
            const txt = (part.text ?? '').trim()
            if (txt) lines.push(`💭 <i>${escapeHtml(txt)}</i>`)
          } else if (part.type === 'text') {
            const cleaned = (part.text ?? '').replace(AIPG_IMAGE_MD_STRIP_RE, '').trim()
            if (cleaned) lines.push(markdownToTelegramHtml(cleaned))
          } else if (part.type === 'tool-comfyUI' || part.type === 'tool-comfyUiImageEdit') {
            const { workflow, prompt } = part.input ?? {}
            if (!workflow && !prompt) continue
            const phase = part.state === 'output-available' ? '✅' : '🎨'
            const titleBase = workflow
              ? `Generating using preset <i>${escapeHtml(workflow)}</i>`
              : 'Generating image'
            const noticeLines = [`${phase} ${titleBase}`]
            if (prompt) noticeLines.push(`<i>${escapeHtml(prompt)}</i>`)
            lines.push(noticeLines.join('\n'))
          }
        }
        return lines.join('\n\n')
      }

      function buildFinalText(parts: RawPart[]): string {
        const lines: string[] = []
        for (const part of parts) {
          if (part.type === 'reasoning') {
            const txt = (part.text ?? '').trim()
            if (txt) lines.push(`💭 <i>${escapeHtml(txt)}</i>`)
          } else if (part.type === 'text') {
            const cleaned = (part.text ?? '').replace(AIPG_IMAGE_MD_STRIP_RE, '').trim()
            if (cleaned) lines.push(markdownToTelegramHtml(cleaned))
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
              await sendImageToTelegram(img.imageUrl, '')
            }
          })
        }
      }

      function tick() {
        const msgs = chatStore.getMessagesForKey(targetKey) ?? []
        const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
        if (!lastAssistant) return
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
        const parts = (lastAssistant?.parts as RawPart[] | undefined) ?? []
        shipPendingImages(parts)
        const finalText = buildFinalText(parts)
        await draft.finalize(finalText, 'HTML')
        await sendChain
      }
    }

    async function handleAgenticMessage(text: string, images?: TelegramImage[]): Promise<void> {
      focusRemoteChatDiscussion()
      const targetKey = ensureActiveRemoteConversation()
      if (!(await ensureVisionCapableForImages(!!images?.length))) return
      const files = await prepareTelegramFiles(images)
      // Show "typing…" the moment we accept the turn — covers the silent
      // window before the watcher has any reasoning/text/tool part to send.
      const stopTyping = startTypingHeartbeat('typing')
      const flush = watchAndStreamToTelegram(targetKey)
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

    async function sendImageToTelegram(imageUrl: string, caption: string): Promise<void> {
      try {
        const base64 = await imageToBase64(imageUrl)
        const result = await window.electronAPI.homeAgent.sendTelegramPhoto(base64, caption)
        if (!result.success) {
          throw new Error(result.error ?? 'sendTelegramPhoto returned failure')
        }
      } catch (e) {
        await window.electronAPI.homeAgent.sendTelegramReply(
          `⚠️ Image was generated but could not be sent: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }

    async function imageToBase64(imageUrl: string): Promise<string> {
      if (imageUrl.startsWith('aipg-media://')) {
        return await window.electronAPI.readAipgMediaAsBase64(imageUrl)
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
    async function waitAndSendAllImages(newImageIds: Set<string>, prompt: string): Promise<void> {
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
            await sendImageToTelegram(img.imageUrl, prompt)
          } else if (img.state === 'stopped') {
            sentIds.add(id) // count as handled, don't send
          }
        }

        // Check for global error state
        if (imageGenStore.currentState === 'error') {
          const remaining = [...newImageIds].filter((id) => !sentIds.has(id))
          if (remaining.length > 0) {
            await window.electronAPI.homeAgent.sendTelegramReply(
              '⚠️ Image generation failed. Please check AI Playground for details.',
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
        await window.electronAPI.homeAgent.sendTelegramReply(
          `⚠️ ${unsent.length} image(s) timed out and were not sent.`,
        )
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
    async function showImgGenPresetPicker(cachedPrompt: string): Promise<void> {
      focusRemoteChatDiscussion()

      const comfyService = backendServices.info.find((s) => s.serviceName === 'comfyui-backend')
      if (!comfyService || comfyService.status !== 'running') {
        await window.electronAPI.homeAgent.sendTelegramReply(
          '⚠️ Image generation is not available — the ComfyUI backend is not running.',
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
        await window.electronAPI.homeAgent.sendTelegramReply(
          '⚠️ No image generation presets are available. Configure one in AI Playground.',
        )
        return
      }

      // Telegram caps callback_data at 64 bytes. Preset names in this repo are
      // short (≤30 chars typical), but guard defensively.
      const encoder = new TextEncoder()
      const buttons: Array<Array<{ text: string; callbackData: string }>> = []
      for (const p of presetsList) {
        const cb = `imgGen:preset:${p.name}`
        if (encoder.encode(cb).length > 64) continue
        const label = p.name.length > 30 ? `${p.name.slice(0, 29)}…` : p.name
        buttons.push([{ text: label, callbackData: cb }])
      }
      if (buttons.length === 0) {
        await window.electronAPI.homeAgent.sendTelegramReply(
          '⚠️ No image generation presets with safe-length names. Configure one in AI Playground.',
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
      await window.electronAPI.homeAgent.sendTelegramKeyboard({
        text: intro,
        parseMode: 'HTML',
        buttons,
      })
    }

    /**
     * Map the live ComfyUI/imageGen state machine to a one-line phase string
     * for the draft preview. Driven on a 500 ms interval inside
     * `runImgGenWithPreset` so the user sees animated transitions through
     * `install_workflow_components` → `load_*` → `generating N/M` → photo.
     */
    function imgGenPhaseText(presetName: string): string {
      const state = imageGenStore.currentState
      const step = imageGenStore.stepText
      switch (state) {
        case 'install_workflow_components':
          return '🛠 Installing workflow components…'
        case 'load_workflow_components':
          return '🧠 Loading workflow components…'
        case 'load_model':
        case 'load_model_components':
          return '🎨 Loading model…'
        case 'generating':
          return step ? `✨ ${escapeHtml(step)}` : '✨ Generating…'
        case 'image_out':
          return '🖼 Finalizing image…'
        case 'error':
        case 'no_start':
        default:
          return `🎬 Preparing <i>${escapeHtml(presetName)}</i>…`
      }
    }

    /**
     * Generate an image using the named preset and the given prompt. Reused by
     * both the cached-prompt fast-path (preset tap with prompt already supplied)
     * and the awaitingPrompt → free-text path (preset tap, then prompt arrives).
     */
    async function runImgGenWithPreset(presetName: string, prompt: string): Promise<void> {
      const comfyService = backendServices.info.find((s) => s.serviceName === 'comfyui-backend')
      if (!comfyService || comfyService.status !== 'running') {
        await window.electronAPI.homeAgent.sendTelegramReply(
          '⚠️ Image generation is not available — the ComfyUI backend is not running.',
        )
        return
      }

      const previousMode = promptStore.getCurrentMode()
      // `upload_photo` so Telegram shows "sending a photo…" rather than
      // "typing…" during the ComfyUI render — matches the eventual delivery.
      const stopTyping = startTypingHeartbeat('upload_photo')

      // Phase-aware draft. Drafts auto-expire 30 s after the last update, so
      // the keep-alive timer inside `createDraftStream` covers the gap between
      // ComfyUI state transitions during long model loads.
      const draft = createDraftStream(newDraftId(), 'HTML')
      let phaseStopped = false
      const updateDraftPhase = () => {
        if (phaseStopped) return
        draft.update(imgGenPhaseText(presetName))
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
          await window.electronAPI.homeAgent.sendTelegramReply(
            `⚠️ Could not select preset <i>${escapeHtml(presetName)}</i>: ${escapeHtml(
              switchResult.error ?? 'unknown error',
            )}`,
            'HTML',
          )
          return
        }

        if (!imageGenStore.activePreset) {
          await window.electronAPI.homeAgent.sendTelegramReply(
            '⚠️ No image generation preset is selected. Please configure one in AI Playground.',
          )
          return
        }

        const validation = await imageGenStore.validatePresetRequirements()
        if (!validation.backendRunning) {
          await window.electronAPI.homeAgent.sendTelegramReply(
            '⚠️ Image generation is not available — the ComfyUI backend is not running.',
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
          await window.electronAPI.homeAgent.sendTelegramReply(
            `⚠️ Image generation requirements are not met: ${parts.join('; ')}. Please configure AI Playground first.`,
          )
          return
        }

        const knownIdsBefore = new Set(imageGenStore.generatedImages.map((img) => img.id))
        imageGenStore.prompt = prompt
        try {
          await imageGenStore.generate('imageGen')
        } catch (e) {
          await window.electronAPI.homeAgent.sendTelegramReply(
            `⚠️ Image generation failed to start: ${e instanceof Error ? e.message : String(e)}`,
          )
          return
        }

        const newImageIds = new Set(
          imageGenStore.generatedImages
            .filter((img) => !knownIdsBefore.has(img.id))
            .map((img) => img.id),
        )

        if (newImageIds.size === 0) {
          await window.electronAPI.homeAgent.sendTelegramReply(
            '⚠️ Image generation did not produce any images.',
          )
          return
        }

        await waitAndSendAllImages(newImageIds, prompt)
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
    async function handleImgGenPresetCallback(presetName: string): Promise<void> {
      const pending = pendingImgGen.value
      const cachedPrompt = pending?.phase === 'awaitingPresetTap' ? pending.cachedPrompt.trim() : ''

      if (cachedPrompt) {
        pendingImgGen.value = null
        await runImgGenWithPreset(presetName, cachedPrompt)
        return
      }

      pendingImgGen.value = {
        phase: 'awaitingPrompt',
        presetName,
        deadline: Date.now() + IMGGEN_PENDING_TIMEOUT_MS,
      }
      await window.electronAPI.homeAgent.sendTelegramReply(
        `✅ Selected <i>${escapeHtml(presetName)}</i>.\nNow send your prompt as the next message, or /cancel to abort.`,
        'HTML',
      )
    }

    /** Cancel button on the picker OR the /cancel slash command. */
    async function handleImgGenCancel(): Promise<void> {
      const wasPending = pendingImgGen.value !== null
      pendingImgGen.value = null
      await window.electronAPI.homeAgent.sendTelegramReply(
        wasPending ? '✖ Image generation cancelled.' : 'Nothing to cancel.',
      )
    }

    async function drainQueue() {
      if (telegramDrainBusy) return
      telegramDrainBusy = true
      try {
        while (_messageQueue.length > 0 && isHomeAgentActive.value) {
          const item = _messageQueue.shift()!
          expireImgGenPendingIfStale()

          // Inline-keyboard taps from the /imgGen preset picker arrive with a
          // `callback` field instead of `text` — route them before any
          // text-based regex matching.
          if (item.callback) {
            try {
              if (item.callback === 'imgGen:cancel') {
                await handleImgGenCancel()
              } else if (item.callback.startsWith('imgGen:preset:')) {
                const name = item.callback.slice('imgGen:preset:'.length)
                await handleImgGenPresetCallback(name)
              }
            } catch (e) {
              console.error('Error processing Telegram callback:', e)
            }
            continue
          }

          const text = item.text ?? ''
          const images = item.images
          try {
            if (HELP_REGEX.test(text)) {
              focusRemoteChatDiscussion()
              await window.electronAPI.homeAgent.sendTelegramReply(HELP_MESSAGE, 'HTML')
            } else if (CANCEL_REGEX.test(text)) {
              await handleImgGenCancel()
            } else if (NEW_REGEX.test(text)) {
              const newKey = createNewRemoteConversation()
              focusRemoteChatDiscussion()
              await window.electronAPI.homeAgent.sendTelegramReply(
                `🆕 Started a new chat thread: <i>${homeAgentTitleFor(newKey).replace(/[<>&]/g, '')}</i>.\nNext message will land in this thread.`,
                'HTML',
              )
            } else if (HISTORY_REGEX.test(text)) {
              await handleHistoryCommand()
            } else if (LOAD_BARE_REGEX.test(text)) {
              await handleLoadMenu()
            } else if (LOAD_REGEX.test(text)) {
              const match = text.match(LOAD_REGEX)
              const arg = match?.[1] ?? ''
              const key = resolveLoadTarget(arg)
              if (!key) {
                await window.electronAPI.homeAgent.sendTelegramReply(
                  `⚠️ Couldn't find a chat with id <code>${arg}</code>. Try <code>/history</code> first.`,
                  'HTML',
                )
              } else if (switchRemoteConversation(key)) {
                focusRemoteChatDiscussion()
                const items = listRemoteConversations()
                const item = items.find((i) => i.key === key)
                await window.electronAPI.homeAgent.sendTelegramReply(
                  `📂 Loaded <i>${item?.title ?? key}</i>.\nReplies and new messages now use this thread.`,
                  'HTML',
                )
              } else {
                await window.electronAPI.homeAgent.sendTelegramReply(
                  '⚠️ Could not load that chat thread.',
                )
              }
            } else if (IMG_GEN_REGEX.test(text)) {
              const prompt = text.replace(IMG_GEN_REGEX, '').trim()
              if (images?.length) {
                // /imgGen is text-to-image — the Telegram photo is not used as a reference.
                await window.electronAPI.homeAgent.sendTelegramReply(
                  'ℹ️ <code>/imgGen</code> is text-only — the attached photo is ignored.',
                  'HTML',
                )
              }
              await showImgGenPresetPicker(prompt)
            } else if (CHAT_REGEX.test(text)) {
              const msg = text.replace(CHAT_REGEX, '').trim()
              if (msg || images?.length) {
                await handleChatMessage(msg, images)
              } else {
                focusRemoteChatDiscussion()
                await window.electronAPI.homeAgent.sendTelegramReply(
                  '⚠️ Please add a message after the command.\nExample: <code>/chat Hello, world!</code>',
                  'HTML',
                )
              }
            } else if (pendingImgGen.value?.phase === 'awaitingPrompt') {
              // After the user tapped a preset, the next plain-text message
              // becomes the prompt. Photo-only messages (text === '[image]')
              // are rejected with a reminder — /imgGen is text-only.
              const presetName = pendingImgGen.value.presetName
              const promptText = images?.length && text === '[image]' ? '' : text.trim()
              if (!promptText) {
                await window.electronAPI.homeAgent.sendTelegramReply(
                  '⚠️ Please send your prompt as text. Photos are ignored for /imgGen. /cancel to abort.',
                  'HTML',
                )
              } else {
                pendingImgGen.value = null
                await runImgGenWithPreset(presetName, promptText)
              }
            } else if (pendingImgGen.value?.phase === 'awaitingPresetTap' && text.trim()) {
              // The picker keyboard is still up; remind the user to tap a button.
              await window.electronAPI.homeAgent.sendTelegramReply(
                '🖼️ Tap a preset above, or /cancel to dismiss the picker.',
                'HTML',
              )
            } else {
              // Agentic mode — AI decides whether to chat or generate an image.
              // For photo-only messages the Python side queues "[image]" as a
              // placeholder; clear it so the model isn't biased by a literal token.
              const agenticText = images?.length && text === '[image]' ? '' : text
              await handleAgenticMessage(agenticText, images)
            }
          } catch (e) {
            console.error('Error processing Telegram message:', e)
          }
        }
      } finally {
        telegramDrainBusy = false
      }
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
        void drainQueue()
      } catch (e) {
        console.error('Error polling Telegram:', e)
      }
    }

    function startPolling() {
      disposeTelegramPollHandlers()
      telegramPollIntervalId = setInterval(() => {
        void processTelegramMessages()
      }, POLL_INTERVAL_MS)
    }

    function stopPolling() {
      disposeTelegramPollHandlers()
      _messageQueue.length = 0
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
            isHomeAgentActive.value = false
            _userDisabled = false
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
      isHomeAgentActive.value = false
      _userDisabled = false
    }

    function setVerified() {
      telegramVerified.value = true
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
      _userDisabled = false
      isHomeAgentActive.value = true
      focusRemoteChatDiscussion()
    }

    function toggle() {
      if (isHomeAgentActive.value) {
        _userDisabled = true
        isHomeAgentActive.value = false
      } else {
        activate()
      }
    }

    // Load token from safeStorage (not persisted to disk for security).
    // telegramChatId and telegramVerified ARE persisted, so they are already
    // populated synchronously before this resolves.
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
          isHomeAgentActive.value = false
          return
        }
        const cfg = await window.electronAPI.homeAgent.loadConfig()
        if (cfg) {
          telegramToken.value = cfg.token
          telegramChatId.value = cfg.chatId
        } else if (!telegramVerified.value) {
          // No config in safeStorage — clear everything only if nothing was persisted
          telegramToken.value = null
          telegramChatId.value = null
          isHomeAgentActive.value = false
        }
      } catch (e) {
        console.error('homeAgent.initConfig failed:', e)
      }
    }

    void initConfig()

    return {
      isFeatureEnabled,
      isHomeAgentActive,
      isTelegramConfigured,
      isReadyToActivate,
      telegramVerified,
      telegramChatId,
      telegramToken,
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
      toggle,
      saveConfig,
      clearConfig,
      setVerified,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      // telegramChatId persisted (non-sensitive) for display purposes.
      // telegramVerified persisted — this is the key flag for "ready to activate".
      // telegramToken NOT persisted — lives only in safeStorage.
      // isHomeAgentActive NOT persisted — re-derived on startup by watchers
      //   (isAvailable is false until the backend service reports ready).
      // activeRemoteConversationKey persisted so /load <id> survives restart and
      //   the same Telegram thread keeps draining into its conversation bucket.
      // summaryCache persisted so /load menu summaries survive restarts.
      pick: ['telegramVerified', 'telegramChatId', 'activeRemoteConversationKey', 'summaryCache'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeTelegramPollHandlers()
    telegramDrainBusy = false
  })
  import.meta.hot.accept(acceptHMRUpdate(useHomeAgent, import.meta.hot))
}
