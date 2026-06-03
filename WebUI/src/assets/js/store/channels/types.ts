// Shared channel type contracts used by the renderer store, electron main IPC
// dispatcher, and (mirrored) the Python channel registry. Adding a new channel
// means extending `ChannelKind` and adding the matching `ChannelConfig` variant
// here, then implementing the renderer adapter + python channel module.

export type ChannelKind = 'telegram' | 'slack' | 'discord'

/** Persistent per-channel config. Each variant is keyed by `kind` so the
 *  generic IPC dispatcher can route to the right `safeStorage` blob without
 *  caring about field shape. Discord is reserved here ahead of time so the
 *  follow-up PR slots in by extending the discriminated union, not editing the
 *  generic store/IPC plumbing. */
export type TelegramChannelConfig = { kind: 'telegram'; token: string; chatId: string }
export type SlackChannelConfig = {
  kind: 'slack'
  botToken: string
  appToken: string
  userId: string
}
// Discord placeholder — concrete shape lands with the discord channel module.
// Marked optional so callers can build `{ kind: 'discord' }` without filling
// fields they don't have yet.
export type DiscordChannelConfig = { kind: 'discord'; botToken?: string; userId?: string }

export type ChannelConfig = TelegramChannelConfig | SlackChannelConfig | DiscordChannelConfig

/** Pure, dependency-free description of a channel's config shape. Keeping this
 *  here (rather than in the renderer registry, which pulls in Vue components
 *  and setup composables) lets the store import it without a circular
 *  dependency. `requiredSecrets` gates whether credentials are complete enough
 *  to inject into the backend; `identityField` is the single config key that
 *  carries the channel's identity (chatId / userId / …). Adding a channel =
 *  one entry here. */
export type ChannelFieldSpec = {
  requiredSecrets: string[]
  identityField: string
}

export const CHANNEL_FIELD_SPEC: Record<ChannelKind, ChannelFieldSpec> = {
  telegram: { requiredSecrets: ['token'], identityField: 'chatId' },
  slack: { requiredSecrets: ['botToken', 'appToken'], identityField: 'userId' },
  discord: { requiredSecrets: ['botToken'], identityField: 'userId' },
}

/** Runtime-only per-channel state. Lives inside `homeAgent.channels[kind]`,
 *  is NEVER persisted (it holds the in-memory secret `config` blob), and is
 *  rebuilt on every launch: `config` is rehydrated from safeStorage and
 *  `active` is re-derived from `channelPrefs` + availability. */
export type ChannelRuntimeState = {
  kind: ChannelKind
  /** Secrets (token / botToken / …) held in memory only. Never persisted. */
  config: Partial<ChannelConfig>
  /** Currently fielding remote traffic. Re-derived on startup. */
  active: boolean
}

/** Persisted, non-secret per-channel preferences. Separated from
 *  `ChannelRuntimeState` because Pinia's persist plugin serializes `$state`;
 *  keeping secrets out of this object guarantees tokens never reach
 *  localStorage. Pinia persists this whole map.
 *  - `verified`: credentials saved and tested successfully.
 *  - `identity`: last-known chat/user id (chatId / userId / …) for display.
 *  - `enabled`: user wants this channel running (toggled in the setup screen). */
export type ChannelPrefs = {
  verified: boolean
  identity: string | null
  enabled: boolean
}

/** Identifier the channel uses to address an existing message (for edit /
 *  reaction operations). Adapters interpret the fields opaquely; Telegram
 *  uses `draftId`, Slack uses `{channel, ts}`. */
export type ChannelMessageRef = {
  draftId?: number
  ts?: string
  channel?: string
}

/** Inbound metadata threaded through the drain pipeline so adapters can
 *  target reactions / threaded sends at the originating message. */
export type InboundMeta = {
  channel?: string
  ts?: string
  chatId?: string
}

/** Single image payload exchanged with the python backend in either direction. */
export type RemoteImage = { mime: string; data_base64: string }

/** Single inbound audio payload (voice note / uploaded audio) from a channel. */
export type RemoteAudio = { mime: string; data_base64: string }

/** Single inbound document payload (uploaded file) from a channel. Ingested
 *  into the RAG knowledge base rather than passed to the model directly. */
export type RemoteDocument = { filename: string; mime: string; data_base64: string }

/** Single keyboard button rendered by the adapter (Block Kit action, Telegram
 *  inline keyboard button, Discord component button, …). */
export type KeyboardButton = { text: string; callbackData: string }

/** Inbound queue item the python backend produces and the renderer drains. */
export type ChannelQueueItem = {
  text?: string
  images?: RemoteImage[]
  audio?: RemoteAudio[]
  documents?: RemoteDocument[]
  callback?: string
  meta?: InboundMeta
}

/** Result envelope from outbound send operations. `ref` is populated when the
 *  adapter has produced a handle the streaming layer can use to edit the
 *  message in place. */
export type ChannelSendResult = {
  success: boolean
  ref?: ChannelMessageRef
  error?: string
}

/** Bag of formatted message fragments the adapter assembles into a final
 *  channel-native draft / final string. Lets the store stay channel-agnostic
 *  while still describing rich structure (reasoning, text, tool markers). */
export type DraftParts = {
  reasoning?: { text: string }[]
  text?: string[]
  toolMarkers?: {
    phase: '🎨' | '✅'
    verb: 'Generating' | 'Generated'
    workflow?: string
    prompt?: string
  }[]
}

export type FinalParts = DraftParts & {
  reasoningElapsedMs?: number
}

/** Image-generation phase passed from the store into `formatImgGenPhase`.
 *  Adapters decide whether to render with HTML, mrkdwn, or plain text. */
export type ImgGenPhase =
  | { kind: 'install_workflow_components' }
  | { kind: 'load_workflow_components' }
  | { kind: 'load_model' }
  | { kind: 'load_model_components' }
  | { kind: 'generating'; step?: string }
  | { kind: 'image_out' }
  | { kind: 'preparing'; presetName: string }
