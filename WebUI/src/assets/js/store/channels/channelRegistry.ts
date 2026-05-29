// Renderer-side channel registry. UI components iterate `CHANNELS` rather
// than hard-coding `if (kind === 'telegram')` branches. Adding a new channel
// = one new entry here + one new setup component + one new composable.

import { defineAsyncComponent, h, type Component } from 'vue'
import type { ChannelKind } from './types'
import { useTelegramSetup } from '../useTelegramSetup'
import { useSlackSetup } from '../useSlackSetup'

/** Inline 4-color Slack logo. Kept here because nothing else needs it and
 *  promoting it to a stand-alone .vue file would just trade one file for two. */
const SlackIcon: Component = {
  name: 'SlackIcon',
  setup() {
    return () =>
      h('svg', { class: 'w-5 h-5', viewBox: '0 0 24 24' }, [
        h('path', {
          fill: '#E01E5A',
          d: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z',
        }),
        h('path', {
          fill: '#36C5F0',
          d: 'M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z',
        }),
        h('path', {
          fill: '#2EB67D',
          d: 'M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522v-2.52zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z',
        }),
        h('path', {
          fill: '#ECB22E',
          d: 'M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z',
        }),
      ])
  },
}

/** Inline Telegram logo. */
const TelegramIcon: Component = {
  name: 'TelegramIcon',
  setup() {
    return () =>
      h('svg', { class: 'w-5 h-5 text-[#26a5e4]', viewBox: '0 0 24 24', fill: 'currentColor' }, [
        h('path', {
          d: 'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z',
        }),
      ])
  },
}

/** Wide-net composable surface every channel setup component shares. Channel
 *  composables may expose additional fields; downstream code grabs them via
 *  the typed composable hook directly. */
export type ChannelSetupComposable =
  | ReturnType<typeof useTelegramSetup>
  | ReturnType<typeof useSlackSetup>

export type ChannelCapabilities = {
  /** Channel only operates while a persistent socket / poll is open. Both
   *  Telegram (long-poll) and Slack (Socket Mode) qualify; future SSE/webhook
   *  channels would be `false`. Drives wording in the toggle UI. */
  socketModeOnly: boolean
  /** Adapter implements `createDraftStream` (animated streaming preview).
   *  False channels still render the final message but skip the streaming
   *  intermediate updates. */
  supportsDraftStream: boolean
  /** Adapter implements typing indicators (Telegram chat actions, Slack
   *  reactions). False channels treat `startTypingHeartbeat` as a no-op. */
  supportsTyping: boolean
  /** Adapter renders interactive keyboards (Telegram inline keyboards, Slack
   *  Block Kit actions). False channels fall back to listing options as plain
   *  numbered text. */
  supportsKeyboard: boolean
}

export type ChannelDescriptor = {
  kind: ChannelKind
  displayName: string
  /** Brand color used by the toggle chip's status dot. */
  brandColor: string
  /** Logo component rendered next to the channel name in setup tabs. */
  icon: Component
  /** Setup wizard sub-page (paste tokens → detect → verify → save). */
  setupComponent: Component
  /** Hook the setup component uses internally. Exposed so the registry can
   *  surface common UI state (`isAlreadyConfigured`, `canSave`, …) when the
   *  setup component is lazy-loaded. */
  composable: () => ChannelSetupComposable
  /** Human-readable name for the channel's identity value (the chatId / userId
   *  stored in `channelPrefs[kind].identity`). Lets the UI render an opaque
   *  code like `U0B6U5ZA1HA` as "Slack member ID" instead. */
  identityLabel: string
  /** One-line explanation of what the identity is and why it matters, shown as
   *  helper text beside the value in the verified summary. */
  identityHelp: string
  capabilities: ChannelCapabilities
}

// Lazy-load the heavy setup components so the toggle / wizard scaffolding can
// render without paying their import cost on every page load.
const TelegramSetupSteps = defineAsyncComponent(() => import('@/components/TelegramSetupSteps.vue'))
const SlackSetupSteps = defineAsyncComponent(() => import('@/components/SlackSetupSteps.vue'))

/** Ordered list of channels surfaced in the UI. Index in this array =
 *  default tab order in the setup wizard. */
export const CHANNELS: ChannelDescriptor[] = [
  {
    kind: 'telegram',
    displayName: 'Telegram',
    brandColor: '#26a5e4',
    icon: TelegramIcon,
    setupComponent: TelegramSetupSteps,
    composable: () => useTelegramSetup(),
    identityLabel: 'Telegram chat ID',
    identityHelp:
      'The Telegram chat the Home Agent talks to. It only answers messages from this chat.',
    capabilities: {
      socketModeOnly: false,
      supportsDraftStream: true,
      supportsTyping: true,
      supportsKeyboard: true,
    },
  },
  {
    kind: 'slack',
    displayName: 'Slack',
    brandColor: '#36C5F0',
    icon: SlackIcon,
    setupComponent: SlackSetupSteps,
    composable: () => useSlackSetup(),
    identityLabel: 'Slack member ID',
    identityHelp:
      'Your Slack member ID. The Home Agent only replies to direct messages from this account.',
    capabilities: {
      socketModeOnly: true,
      supportsDraftStream: true,
      supportsTyping: true,
      supportsKeyboard: true,
    },
  },
]

export function getDescriptor(kind: ChannelKind): ChannelDescriptor | undefined {
  return CHANNELS.find((c) => c.kind === kind)
}
