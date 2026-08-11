// Local web ChannelAdapter — delivers replies to browsers on the LAN via SSE.
//
// Structurally identical to the Telegram / Slack adapters: every method funnels
// through `window.electronAPI.homeAgent.channel.send('local-web', …)`, i.e. the
// same generic IPC → Flask `/channel/local-web/send/<action>` path the other
// channels use. The Python `LocalWebChannel` turns each send into one SSE event.

import type { ChannelAdapter, DraftStream, RawPart } from './adapter'
import { successRef } from './adapter'
import {
  reasoningElapsedMsFromParts,
  renderGenericToolMarker,
  stripAipgMediaReferences,
} from './adapterHelpers'

/** SSE can handle frequent updates (Telegram throttles more for Bot API limits). */
const LOCAL_WEB_DRAFT_THROTTLE_MS = 200

// Sentinels the served page (local_web_app_html.py) rewrites into a styled,
// collapsible reasoning block — the browser analogue of Telegram's expandable
// "💭 Thought for X.X seconds" blockquote. Without this the model's reasoning
// renders as plain answer text, indistinguishable from the reply. Control chars
// are used because they survive the page's HTML-escaping untouched and never
// appear in normal model output. MUST stay in sync with the THINK_* handling in
// that page's `formatBotText`.
const THINK_OPEN = String.fromCharCode(1)
const THINK_SEP = String.fromCharCode(2)
const THINK_CLOSE = String.fromCharCode(3)

// Emphasis sentinels the page rewrites into `<em>` — used to show the image
// prompt in italics. A dedicated marker (not `*`/`_` markdown) avoids mangling
// model output that legitimately contains those characters (snake_case, math).
const EM_OPEN = String.fromCharCode(5)
const EM_CLOSE = String.fromCharCode(6)
function italic(text: string): string {
  return `${EM_OPEN}${text}${EM_CLOSE}`
}

/** Wrap reasoning as `OPEN label SEP body CLOSE`. An empty label tells the page
 *  to render a live, expanded "Thinking…" block (used while streaming); a filled
 *  label ("Thought for X.X seconds") renders a collapsed block (final message). */
function reasoningBlock(label: string, body: string): string {
  return `${THINK_OPEN}${label}${THINK_SEP}${body}${THINK_CLOSE}`
}

/** Render a `tool-comfyUI` / `tool-comfyUiImageEdit` part as a plain-text notice
 *  showing the preset and prompt, mirroring the Telegram adapter's image marker.
 *  Without this the browser only ever received the finished photo — never the
 *  "Generating using preset … <prompt>" line the desktop app shows — because the
 *  generic tool marker deliberately skips image tools. `verb` flips present/past
 *  tense for the streaming preview vs the settled message. */
function renderImagePart(part: RawPart, verb: 'Generating' | 'Generated'): string | null {
  const { workflow, prompt } = part.input ?? {}
  if (!workflow && !prompt) return null
  const phase = part.state === 'output-available' ? '✅' : '🎨'
  const title = workflow
    ? `${phase} ${verb} using preset **${workflow}**`
    : `${phase} ${verb} image`
  const lines = [title]
  if (prompt) lines.push(italic(prompt))
  return lines.join('\n')
}

function send(
  action:
    | 'reply'
    | 'update'
    | 'photo'
    | 'video'
    | 'voice'
    | 'document'
    | 'typing'
    | 'keyboard'
    | 'editMessage'
    | 'history',
  payload: Record<string, unknown>,
) {
  return window.electronAPI.homeAgent.channel.send('local-web', action, payload)
}

/** Streaming preview: reasoning streams live in its own expanded block, the
 *  answer text and tool markers render inline. */
function formatDraftParts(parts: RawPart[]): string {
  const lines: string[] = []
  for (const part of parts) {
    if (part.type === 'reasoning') {
      const txt = (part.text ?? '').trim()
      if (txt) lines.push(reasoningBlock('', txt))
    } else if (part.type === 'text') {
      const cleaned = stripAipgMediaReferences(part.text ?? '').trim()
      if (cleaned) lines.push(cleaned)
    } else if (part.type === 'tool-comfyUI' || part.type === 'tool-comfyUiImageEdit') {
      const marker = renderImagePart(part, 'Generating')
      if (marker) lines.push(marker)
    } else {
      const marker = renderGenericToolMarker(part, 'using')
      if (marker) lines.push(marker)
    }
  }
  return lines.join('\n\n')
}

/** Final message: coalesce every reasoning part into one collapsed block above
 *  the answer, mirroring the Telegram adapter's "Thought for X.X seconds"
 *  expandable blockquote so reasoning is visibly separate from the reply. */
function formatFinalParts(parts: RawPart[]): string {
  const lines: string[] = []
  const reasoningChunks: string[] = []
  for (const part of parts) {
    if (part.type !== 'reasoning') continue
    const txt = (part.text ?? '').trim()
    if (txt) reasoningChunks.push(txt)
  }
  if (reasoningChunks.length > 0) {
    const seconds = (reasoningElapsedMsFromParts(parts) / 1000).toFixed(1)
    lines.push(reasoningBlock(`Thought for ${seconds} seconds`, reasoningChunks.join('\n\n')))
  }
  for (const part of parts) {
    if (part.type === 'reasoning') continue
    if (part.type === 'text') {
      const cleaned = stripAipgMediaReferences(part.text ?? '').trim()
      if (cleaned) lines.push(cleaned)
    } else if (part.type === 'tool-comfyUI' || part.type === 'tool-comfyUiImageEdit') {
      const marker = renderImagePart(part, 'Generated')
      if (marker) lines.push(marker)
    } else {
      const marker = renderGenericToolMarker(part, 'used')
      if (marker) lines.push(marker)
    }
  }
  return lines.join('\n\n')
}

function createLocalWebDraftStream(): DraftStream {
  let last = ''
  let pending = ''
  let throttleId: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    throttleId = null
    if (pending) void send('update', { text: pending })
  }

  return {
    update: (text: string) => {
      last = text
      pending = text
      if (!throttleId) throttleId = setTimeout(flush, LOCAL_WEB_DRAFT_THROTTLE_MS)
    },
    finalize: async (finalText: string) => {
      if (throttleId) {
        clearTimeout(throttleId)
        throttleId = null
      }
      const text = finalText || last
      if (text) await send('reply', { text })
    },
    cancel: () => {
      if (throttleId) {
        clearTimeout(throttleId)
        throttleId = null
      }
      pending = ''
    },
  }
}

export function createLocalWebAdapter(): ChannelAdapter {
  return {
    kind: 'local-web',
    reply: async (text, _meta) => {
      await send('reply', { text })
      return successRef()
    },
    photo: async (imageBase64, caption, _meta) => {
      await send('photo', { base64: imageBase64, caption })
      return successRef()
    },
    video: async (videoBase64, caption, filename, _meta) => {
      await send('video', { base64: videoBase64, caption, filename })
      return successRef()
    },
    voice: async (audioBase64, mime, _meta) => {
      await send('voice', { base64: audioBase64, mime })
      return successRef()
    },
    document: async (documentBase64, filename, caption, _meta) => {
      await send('document', { base64: documentBase64, filename, caption })
      return successRef()
    },
    keyboard: async (text, buttons, _meta) => {
      await send('keyboard', { text, buttons })
      return successRef({ ts: String(Date.now()), channel: 'local-web' })
    },
    editKeyboardMessage: async (_ref, text, _meta) => {
      // Its own action, not a plain reply: the page uses it to retire the prompt's
      // buttons, so an already-settled prompt can't be tapped again.
      await send('editMessage', { text })
      return successRef()
    },
    startTypingHeartbeat: (_action, _meta) => {
      // SSE needs no heartbeat (the indicator stays until told otherwise), but it
      // does need the stop: a turn that ends without any output would otherwise
      // leave the browser showing the typing dots forever.
      void send('typing', { action: 'typing' })
      return () => void send('typing', { action: 'stop' })
    },
    replayHistory: async (messages, _meta) => {
      // One SSE event carrying the whole transcript; the page repaints its log
      // from it (it has no persistent history like Telegram/Slack do).
      await send('history', { messages })
      return successRef()
    },
    createDraftStream: () => createLocalWebDraftStream(),
    formatMarkdown: (md) => md,
    formatRichSnippet: (html) =>
      html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&'),
    formatDraft: (parts) => formatDraftParts(parts),
    formatFinal: (parts) => formatFinalParts(parts),
    formatImgGenPhase: (input) => {
      const { presetName, state, step } = input
      if (state === 'generating') return step ? `Generating: ${step}` : 'Generating…'
      return `${presetName} — ${state}`
    },
    formatItalic: (t) => t,
    escapeInline: (t) => t,
  }
}

export type { KeyboardButton } from './types'
