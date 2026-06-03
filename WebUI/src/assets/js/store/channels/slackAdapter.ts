// Slack ChannelAdapter — wraps the generic channel:send IPC and renders
// Slack mrkdwn / Block Kit.

import { markdownToSlackMrkdwn } from '../../slackMrkdwn'
import type { InboundMeta } from './types'
import type { ChannelAdapter, DraftStream, ImgGenPhaseInput, RawPart } from './adapter'
import {
  DRAFT_SPINNER_FRAMES,
  DRAFT_THROTTLE_MS,
  reasoningElapsedMsFromParts,
  stripAipgMediaReferences,
} from './adapterHelpers'

/** Lightweight HTML → Slack mrkdwn conversion for the hand-authored UI
 *  strings (HELP_MESSAGE, status banners). Limited to the set of tags those
 *  snippets actually use.
 */
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

function renderImageToolPart(part: RawPart, verb: 'Generating' | 'Generated'): string | null {
  const { workflow, prompt } = part.input ?? {}
  if (!workflow && !prompt) return null
  const phase = part.state === 'output-available' ? '✅' : '🎨'
  const titleBase = workflow ? `${verb} using preset _${workflow}_` : `${verb} image`
  const noticeLines = [`${phase} ${titleBase}`]
  if (prompt) noticeLines.push(`_${prompt}_`)
  return noticeLines.join('\n')
}

function formatDraft(parts: RawPart[]): string {
  const lines: string[] = []
  for (const part of parts) {
    if (part.type === 'reasoning') {
      const txt = (part.text ?? '').trim()
      if (!txt) continue
      lines.push(
        txt
          .split('\n')
          .map((l) => (l ? `> 💭 ${l}` : '>'))
          .join('\n'),
      )
    } else if (part.type === 'text') {
      const cleaned = stripAipgMediaReferences(part.text ?? '').trim()
      if (cleaned) lines.push(markdownToSlackMrkdwn(cleaned))
    } else if (part.type === 'tool-comfyUI' || part.type === 'tool-comfyUiImageEdit') {
      const marker = renderImageToolPart(part, 'Generating')
      if (marker) lines.push(marker)
    }
  }
  return lines.join('\n\n')
}

function formatFinal(parts: RawPart[]): string {
  const lines: string[] = []
  const reasoningChunks: string[] = []
  for (const part of parts) {
    if (part.type !== 'reasoning') continue
    const txt = (part.text ?? '').trim()
    if (txt) reasoningChunks.push(txt)
  }
  if (reasoningChunks.length > 0) {
    const seconds = (reasoningElapsedMsFromParts(parts) / 1000).toFixed(1)
    // Slack has no expandable blockquote — emit a single quoted block with
    // the timing header at the top.
    const body = reasoningChunks.join('\n\n')
    const quoted = `💭 _Thought for ${seconds} seconds_\n\n${body}`
      .split('\n')
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n')
    lines.push(quoted)
  }
  for (const part of parts) {
    if (part.type === 'reasoning') {
      continue
    } else if (part.type === 'text') {
      const cleaned = stripAipgMediaReferences(part.text ?? '').trim()
      if (cleaned) lines.push(markdownToSlackMrkdwn(cleaned))
    } else if (part.type === 'tool-comfyUI' || part.type === 'tool-comfyUiImageEdit') {
      const marker = renderImageToolPart(part, 'Generated')
      if (marker) lines.push(marker)
    }
  }
  return lines.join('\n\n')
}

function formatImgGenPhase(input: ImgGenPhaseInput): string {
  const { presetName, state, step } = input
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
      return `✨ ${step}`
    case 'image_out':
      return '🖼 Finalizing image…'
    default:
      return `🎬 Preparing _${presetName}_…`
  }
}

/** Slack typing indicator via reactions.add/remove on the inbound message.
 *  Without an inbound message ref (no meta.ts / no meta.channel) this is a
 *  no-op stop function; the reply itself signals progress.
 */
function startTypingHeartbeat(_action: string, meta?: InboundMeta): () => void {
  const channel = meta?.channel
  const ts = meta?.ts
  const name = 'eyes'
  if (!channel || !ts) return () => {}
  void window.electronAPI.homeAgent.channel
    .send('slack', 'typing', { channel, ts, name, action: 'add' })
    .catch(() => {})
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    void window.electronAPI.homeAgent.channel
      .send('slack', 'typing', { channel, ts, name, action: 'remove' })
      .catch(() => {})
  }
}

function createSlackDraftStream(meta: InboundMeta | undefined): DraftStream {
  const targetChannel = meta?.channel
  let baseText = ''
  let lastSentVariant = ''
  let messageRef: { channel: string; ts: string } | null = null
  let throttleTimerId: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let spinnerFrame = 0
  // Single-flight guard for the lazy initial post. `update()` calls `send()`
  // on every tick while `lastSentVariant === ''`, and the initial Slack reply
  // round-trip can outlast the 250ms watcher tick — without this, concurrent
  // ticks would each post a fresh message, leaving an orphaned partial draft
  // alongside the one that actually gets streamed/edited.
  let postPromise: Promise<void> | null = null

  function ensurePosted(initialText: string): Promise<void> {
    if (messageRef || stopped) return Promise.resolve()
    if (postPromise) return postPromise
    postPromise = (async () => {
      try {
        const res = await window.electronAPI.homeAgent.channel.send('slack', 'reply', {
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
    })()
    return postPromise
  }

  async function send(variant: string): Promise<void> {
    if (stopped) return
    if (!messageRef) {
      await ensurePosted(variant)
      return
    }
    try {
      const res = await window.electronAPI.homeAgent.channel.send('slack', 'update', {
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
    // Animate trailing spinner so long quiet phases visibly tick.
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
        await window.electronAPI.homeAgent.channel.send('slack', 'update', {
          channel: messageRef.channel,
          ts: messageRef.ts,
          text: finalText,
        })
      } else {
        await window.electronAPI.homeAgent.channel.send('slack', 'reply', {
          text: finalText,
          channel: targetChannel,
        })
      }
    } catch (e) {
      console.error('slackAdapter: draft finalize failed:', e)
    }
  }

  return { update, finalize, cancel }
}

export function createSlackAdapter(): ChannelAdapter {
  return {
    kind: 'slack',
    reply: async (text, meta) => {
      const r = await window.electronAPI.homeAgent.channel.send('slack', 'reply', {
        text,
        channel: meta?.channel,
      })
      return {
        success: r.success,
        error: r.error,
        ref: r.success && r.ts && r.channel ? { ts: r.ts, channel: r.channel } : undefined,
      }
    },
    photo: async (imageBase64, caption, meta) => {
      return window.electronAPI.homeAgent.channel.send('slack', 'photo', {
        photo: imageBase64,
        caption,
        channel: meta?.channel,
      })
    },
    video: async (videoBase64, caption, filename, meta) => {
      return window.electronAPI.homeAgent.channel.send('slack', 'video', {
        video: videoBase64,
        caption,
        filename,
        channel: meta?.channel,
      })
    },
    voice: async (audioBase64, mime, meta) => {
      return window.electronAPI.homeAgent.channel.send('slack', 'voice', {
        audio: audioBase64,
        mime,
        channel: meta?.channel,
      })
    },
    document: async (documentBase64, filename, caption, meta) => {
      return window.electronAPI.homeAgent.channel.send('slack', 'document', {
        document: documentBase64,
        filename,
        caption,
        channel: meta?.channel,
      })
    },
    keyboard: async (text, buttons, meta) => {
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
      const r = await window.electronAPI.homeAgent.channel.send('slack', 'keyboard', {
        text,
        blocks,
        channel: meta?.channel,
      })
      return { success: r.success, error: r.error }
    },
    startTypingHeartbeat: (action, meta) => startTypingHeartbeat(action, meta),
    createDraftStream: (meta) => createSlackDraftStream(meta),
    formatMarkdown: markdownToSlackMrkdwn,
    formatRichSnippet: htmlSnippetToSlackMrkdwn,
    formatDraft,
    formatFinal,
    formatImgGenPhase,
    formatItalic: (t) => `_${t}_`,
    // Slack mrkdwn has no formal escape, but `<` and `>` open entity links —
    // strip them to keep raw user-supplied text inert.
    escapeInline: (t) => t.replace(/[<>]/g, ''),
  }
}
