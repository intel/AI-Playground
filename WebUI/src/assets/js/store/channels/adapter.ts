// Channel adapter contract + small shared helpers.
//
// Each chat-platform (Telegram, Slack, Discord) ships its own
// `create<Kind>Adapter()` factory returning a `ChannelAdapter`. The store
// only ever talks to the adapter — never platform-specific IPC.

import type {
  ChannelKind,
  ChannelMessageRef,
  ChannelSendResult,
  InboundMeta,
  KeyboardButton,
} from './types'

/** Streaming-update handle the store uses to animate in-flight assistant
 *  output. Each adapter implements draft streams in its native idiom:
 *  Telegram → sendMessageDraft; Slack → chat.postMessage + chat.update. */
export type DraftStream = {
  update: (text: string) => void
  /** Persist the final text and dispose the stream. */
  finalize: (finalText: string) => Promise<void>
  cancel: () => void
}

/** AI SDK message-part shape we receive from `chatStore.getMessagesForKey`.
 *  Promoted here (out of the store) so adapters can render them without
 *  redeclaring the shape per file. */
export type RawPart = {
  type: string
  text?: string
  state?: string
  // Present on dynamic (MCP) tool parts whose `type` is just 'dynamic-tool'.
  toolName?: string
  input?: { workflow?: string; prompt?: string }
  output?: {
    images?: { type: string; imageUrl?: string; videoUrl?: string; model3dUrl?: string }[]
    // captureScreenshot tool result: the captured window as a `data:image/...` URI.
    ok?: boolean
    dataUri?: string
  }
  providerMetadata?: { aipg?: { reasoningStarted?: number; reasoningFinished?: number } }
}

/** Image-generation lifecycle state passed into `formatImgGenPhase`. The
 *  adapter decides how to render this — Telegram uses HTML italics, Slack
 *  uses `_underscores_` and `mrkdwn`. Adapter does not look at the imageGen
 *  store directly, keeping it free of cross-cutting deps. */
export type ImgGenPhaseInput = {
  presetName: string
  state: string
  step?: string
}

/** Channel-agnostic adapter surface — see telegramAdapter.ts / slackAdapter.ts
 *  for concrete implementations. Every method that produces a string is
 *  responsible for delivering channel-native output (HTML for Telegram,
 *  mrkdwn for Slack, plain text + embeds for Discord).
 */
export type ChannelAdapter = {
  kind: ChannelKind

  // ── Outbound primitives ────────────────────────────────────────────────
  reply: (text: string, meta?: InboundMeta) => Promise<ChannelSendResult>
  photo: (imageBase64: string, caption: string, meta?: InboundMeta) => Promise<ChannelSendResult>
  /** Deliver a generated video. `filename` carries the extension so clients
   *  pick the right player. */
  video: (
    videoBase64: string,
    caption: string,
    filename: string,
    meta?: InboundMeta,
  ) => Promise<ChannelSendResult>
  /** Deliver a synthesized voice reply. `mime` carries the audio container
   *  (e.g. `audio/ogg` for opus voice notes) so the platform can render a real
   *  voice bubble where supported and fall back to an audio file otherwise. */
  voice: (audioBase64: string, mime: string, meta?: InboundMeta) => Promise<ChannelSendResult>
  /** Deliver an arbitrary file as a document (e.g. a `.glb` 3D model). Chat
   *  clients have no inline glTF preview, so 3D models ship as a document with
   *  a separately-sent thumbnail photo. `filename` is required so the client
   *  shows a real name. */
  document: (
    documentBase64: string,
    filename: string,
    caption: string,
    meta?: InboundMeta,
  ) => Promise<ChannelSendResult>
  keyboard: (
    text: string,
    buttons: KeyboardButton[][],
    meta?: InboundMeta,
  ) => Promise<ChannelSendResult>
  /** Edit a previously-sent `keyboard` message in place: replace its text and
   *  drop the buttons. Used to settle an interactive confirmation prompt so it
   *  no longer looks tappable/pending. `ref` is the handle returned by
   *  `keyboard()`. Best-effort — a failed edit must not break the turn. */
  editKeyboardMessage: (
    ref: ChannelMessageRef,
    text: string,
    meta?: InboundMeta,
  ) => Promise<ChannelSendResult>
  /** Returns a stop function — idempotent. Telegram refreshes a chat action
   *  every 4 s; Slack adds / removes a reaction on the inbound message. */
  startTypingHeartbeat: (action: string, meta?: InboundMeta) => () => void
  createDraftStream: (meta?: InboundMeta) => DraftStream

  // ── Formatting hooks (channel-native output) ───────────────────────────
  /** Convert assistant markdown to channel-native rich text. */
  formatMarkdown: (md: string) => string
  /** Convert one of our hand-authored HTML snippets (HELP_MESSAGE, banners)
   *  to channel-native rich text. Telegram returns the snippet as-is. */
  formatRichSnippet: (htmlSnippet: string) => string
  /** Render the streaming preview from a list of AI SDK message parts. */
  formatDraft: (parts: RawPart[]) => string
  /** Render the persisted final reply from a list of AI SDK message parts.
   *  Adapters add coalesced reasoning blocks, tool markers, etc. */
  formatFinal: (parts: RawPart[]) => string
  /** Render the live image-gen phase preview (driven on a 500 ms interval). */
  formatImgGenPhase: (input: ImgGenPhaseInput) => string
  /** Render an emphasized fragment (`<i>...</i>` for Telegram, `_..._` for
   *  Slack, etc.) given a safe-text body — used by handlers when assembling
   *  short status snippets without going through full markdown.
   */
  formatItalic: (text: string) => string
  /** Channel-safe escaping for raw user-supplied text rendered inline. */
  escapeInline: (text: string) => string
}

/** Helper exported here so concrete adapters can share an identical
 *  ChannelMessageRef-as-success-payload shape. */
export function successRef(ref?: ChannelMessageRef): ChannelSendResult {
  return { success: true, ref }
}
