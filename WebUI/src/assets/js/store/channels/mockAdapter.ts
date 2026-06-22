// Dev-only mock ChannelAdapter — drives the Home Agent message pipeline
// without IPC or the Python backend. Inbound messages come from an in-memory
// queue (`mockChannelBus.inbox`) and every outbound send is captured into
// `mockChannelBus.outbox`, so e2e tests (and the dev panel) can inject traffic
// and assert on the agent's replies deterministically.

import { reactive } from 'vue'
import type { InboundMeta, KeyboardButton, RemoteImage, RemoteAudio, RemoteDocument } from './types'
import { successRef, type ChannelAdapter, type DraftStream, type RawPart } from './adapter'
import { renderGenericToolMarker, stripAipgMediaReferences } from './adapterHelpers'

/** Inbound message shape the store's poll loop consumes. Mirrors the IPC
 *  `homeAgent.channel.poll` element shape (flattened `chat_id`/`channel`/`ts`)
 *  so the mock path flows through `processChannelMessages` unchanged. */
export type MockInboundMessage = {
  text?: string
  chat_id?: string
  channel?: string
  ts?: string
  images?: RemoteImage[]
  audio?: RemoteAudio[]
  documents?: RemoteDocument[]
  callback?: string
}

/** A single captured outbound event. `kind` mirrors the adapter primitive that
 *  produced it so tests can assert on the exact delivery (a final `reply`, an
 *  animated `draftFinal`, a `photo`, …). Media payloads keep their base64 so a
 *  test can decode and inspect them if needed. */
export type MockOutboundEvent = {
  kind:
    | 'reply'
    | 'photo'
    | 'video'
    | 'voice'
    | 'document'
    | 'keyboard'
    | 'keyboardEdit'
    | 'draftUpdate'
    | 'draftFinal'
    | 'typingStart'
    | 'typingStop'
  text?: string
  caption?: string
  filename?: string
  mime?: string
  base64?: string
  buttons?: KeyboardButton[][]
  meta?: InboundMeta
  ts: number
}

/** Shared in-memory bus connecting the mock adapter (outbound capture) to the
 *  Home Agent store's poll loop (inbound source). Module-level singleton so the
 *  adapter instance and the store reference the same queues across Vite HMR. */
export const mockChannelBus = {
  /** Inbound messages awaiting the next `drainInbound()` from the store. */
  inbox: [] as MockInboundMessage[],
  /** Reactive log of captured outbound events. */
  outbox: reactive([]) as MockOutboundEvent[],

  pushInbound(item: MockInboundMessage): void {
    this.inbox.push(item)
  },

  drainInbound(): MockInboundMessage[] {
    const msgs = this.inbox.slice()
    this.inbox.length = 0
    return msgs
  },

  record(event: Omit<MockOutboundEvent, 'ts'>): void {
    this.outbox.push({ ...event, ts: Date.now() })
  },

  clear(): void {
    this.inbox.length = 0
    this.outbox.length = 0
  },
}

/** Strip our hand-authored HTML snippets down to plain text so captured output
 *  is easy to assert on. */
function htmlSnippetToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Render message parts as plain text (text parts + generic tool markers).
 *  ComfyUI image/video parts are rendered as photos/videos via the outbox
 *  primitives, so the generic marker helper already skips them. */
function renderParts(parts: RawPart[], tense: 'using' | 'used'): string {
  const lines: string[] = []
  for (const part of parts) {
    if (part.type === 'reasoning') {
      const txt = (part.text ?? '').trim()
      if (txt) lines.push(`[reasoning] ${txt}`)
    } else if (part.type === 'text') {
      const cleaned = stripAipgMediaReferences(part.text ?? '').trim()
      if (cleaned) lines.push(cleaned)
    } else {
      const marker = renderGenericToolMarker(part, tense)
      if (marker) lines.push(marker)
    }
  }
  return lines.join('\n\n')
}

function createMockDraftStream(meta: InboundMeta | undefined): DraftStream {
  return {
    update: (text: string) => {
      mockChannelBus.record({ kind: 'draftUpdate', text, meta })
    },
    finalize: async (finalText: string) => {
      mockChannelBus.record({ kind: 'draftFinal', text: finalText, meta })
    },
    cancel: () => {},
  }
}

export function createMockAdapter(): ChannelAdapter {
  return {
    kind: 'mock',
    reply: async (text, meta) => {
      mockChannelBus.record({ kind: 'reply', text, meta })
      return successRef()
    },
    photo: async (imageBase64, caption, meta) => {
      mockChannelBus.record({ kind: 'photo', base64: imageBase64, caption, meta })
      return successRef()
    },
    video: async (videoBase64, caption, filename, meta) => {
      mockChannelBus.record({ kind: 'video', base64: videoBase64, caption, filename, meta })
      return successRef()
    },
    voice: async (audioBase64, mime, meta) => {
      mockChannelBus.record({ kind: 'voice', base64: audioBase64, mime, meta })
      return successRef()
    },
    document: async (documentBase64, filename, caption, meta) => {
      mockChannelBus.record({ kind: 'document', base64: documentBase64, filename, caption, meta })
      return successRef()
    },
    keyboard: async (text, buttons, meta) => {
      mockChannelBus.record({ kind: 'keyboard', text, buttons, meta })
      // Return a synthetic ref so callers (e.g. the confirmation flow) can later
      // edit the prompt in place via `editKeyboardMessage`.
      return successRef({ ts: `mock-${Date.now()}`, channel: meta?.channel })
    },
    editKeyboardMessage: async (_ref, text, meta) => {
      mockChannelBus.record({ kind: 'keyboardEdit', text, meta })
      return successRef()
    },
    startTypingHeartbeat: (_action, meta) => {
      mockChannelBus.record({ kind: 'typingStart', meta })
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        mockChannelBus.record({ kind: 'typingStop', meta })
      }
    },
    createDraftStream: (meta) => createMockDraftStream(meta),
    formatMarkdown: (md) => md,
    formatRichSnippet: htmlSnippetToPlainText,
    formatDraft: (parts) => renderParts(parts, 'using'),
    formatFinal: (parts) => renderParts(parts, 'used'),
    formatImgGenPhase: (input) => {
      const { presetName, state, step } = input
      if (state === 'generating') return step ? `Generating: ${step}` : 'Generating…'
      return `[imgGen:${state}] ${presetName}`
    },
    formatItalic: (t) => t,
    escapeInline: (t) => t,
  }
}
