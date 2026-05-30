// Telegram ChannelAdapter — wraps the generic channel:send IPC and renders
// Telegram-native HTML (parse_mode=HTML).

import { markdownToTelegramHtml } from '../../telegramMarkdown'
import type { ChannelAdapter, DraftStream, ImgGenPhaseInput, RawPart } from './adapter'
import {
  DRAFT_KEEPALIVE_MS,
  DRAFT_SPINNER_FRAMES,
  DRAFT_THROTTLE_MS,
  escapeHtml,
  newDraftId,
  reasoningElapsedMsFromParts,
  stripAipgMediaReferences,
} from './adapterHelpers'

const PARSE_MODE = 'HTML' as const

function sendTelegramReply(text: string): Promise<{
  success: boolean
  ts?: string
  channel?: string
  error?: string
}> {
  return window.electronAPI.homeAgent.channel.send('telegram', 'reply', {
    text,
    parse_mode: PARSE_MODE,
  })
}

function sendTelegramChatAction(action: string) {
  return window.electronAPI.homeAgent.channel.send('telegram', 'typing', { action })
}

function sendTelegramDraft(draftId: number, text: string) {
  return window.electronAPI.homeAgent.channel.send('telegram', 'update', {
    draft_id: draftId,
    text,
    parse_mode: PARSE_MODE,
  })
}

/** Render one tool-comfyUI / tool-comfyUiImageEdit part as Telegram HTML.
 *  `verb` flips between "Generating" (live draft) and "Generated" (persisted
 *  final) so the streaming preview reads in present tense and the final
 *  message reads in past tense alongside the actual photo bubble. */
function renderImageToolPart(part: RawPart, verb: 'Generating' | 'Generated'): string | null {
  const { workflow, prompt } = part.input ?? {}
  if (!workflow && !prompt) return null
  const phase = part.state === 'output-available' ? '✅' : '🎨'
  const titleBase = workflow
    ? `${verb} using preset <i>${escapeHtml(workflow)}</i>`
    : `${verb} image`
  const noticeLines = [`${phase} ${titleBase}`]
  if (prompt) noticeLines.push(`<i>${escapeHtml(prompt)}</i>`)
  return noticeLines.join('\n')
}

function formatDraft(parts: RawPart[]): string {
  const lines: string[] = []
  for (const part of parts) {
    if (part.type === 'reasoning') {
      const txt = (part.text ?? '').trim()
      if (!txt) continue
      lines.push(`<blockquote>💭 ${escapeHtml(txt)}</blockquote>`)
    } else if (part.type === 'text') {
      const cleaned = stripAipgMediaReferences(part.text ?? '').trim()
      if (cleaned) lines.push(markdownToTelegramHtml(cleaned))
    } else if (part.type === 'tool-comfyUI' || part.type === 'tool-comfyUiImageEdit') {
      const marker = renderImageToolPart(part, 'Generating')
      if (marker) lines.push(marker)
    }
  }
  return lines.join('\n\n')
}

function formatFinal(parts: RawPart[]): string {
  const lines: string[] = []
  // Coalesce all reasoning parts into one expandable blockquote with a
  // "Thought for X.X seconds" header above the full transcript.
  const reasoningChunks: string[] = []
  for (const part of parts) {
    if (part.type !== 'reasoning') continue
    const txt = (part.text ?? '').trim()
    if (txt) reasoningChunks.push(txt)
  }
  if (reasoningChunks.length > 0) {
    const seconds = (reasoningElapsedMsFromParts(parts) / 1000).toFixed(1)
    const header = `💭 <i>Thought for ${seconds} seconds</i>`
    const body = reasoningChunks.map((t) => escapeHtml(t)).join('\n\n')
    lines.push(`<blockquote expandable>${header}\n\n${body}</blockquote>`)
  }
  for (const part of parts) {
    if (part.type === 'reasoning') {
      continue
    } else if (part.type === 'text') {
      const cleaned = stripAipgMediaReferences(part.text ?? '').trim()
      if (cleaned) lines.push(markdownToTelegramHtml(cleaned))
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
      return `✨ ${escapeHtml(step)}`
    case 'image_out':
      return '🖼 Finalizing image…'
    default:
      return `🎬 Preparing <i>${escapeHtml(presetName)}</i>…`
  }
}

/** Persistent "typing…" indicator via Telegram chat actions. Telegram
 *  chat actions auto-expire after ~5 s on the client so we fire one
 *  immediately and refresh every 4 s until stopped.
 */
function startTypingHeartbeat(action: string = 'typing'): () => void {
  let stopped = false
  void sendTelegramChatAction(action)
  const intervalId = setInterval(() => {
    if (stopped) return
    void sendTelegramChatAction(action)
  }, 4000)
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(intervalId)
  }
}

/** sendMessageDraft-based animated streaming preview.
 *  Behavior:
 *    - 800 ms throttle, "latest text wins" coalescing to stay under
 *      Telegram's ~1 msg/sec/chat rate limit.
 *    - 25 s keep-alive interval so the 30 s ephemeral preview window does
 *      not lapse during slow phases.
 *    - All draft sends are best-effort: failures are swallowed so a
 *      transient Telegram outage never breaks the actual chat turn. The
 *      final sendMessage (via /reply, ie. finalize()) is the canonical,
 *      persisted message — drafts are pure UX gravy.
 */
function createDraftStream(): DraftStream {
  const draftId = newDraftId()
  let baseText = ''
  let lastSentVariant = ''
  let throttleTimerId: ReturnType<typeof setTimeout> | null = null
  let keepAliveIntervalId: ReturnType<typeof setInterval> | null = null
  let stopped = false
  let spinnerFrame = 0

  async function send(variant: string): Promise<void> {
    try {
      const result = await sendTelegramDraft(draftId, variant)
      if (!result?.success) return
      lastSentVariant = variant
    } catch {
      // best-effort
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
    if (text === baseText) return
    baseText = text
    if (lastSentVariant === '' && text !== '') {
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
      const result = await sendTelegramReply(finalText)
      if (!result?.success) {
        console.error(
          'telegramAdapter: draft finalize reply returned error:',
          result?.error ?? 'unknown',
        )
      }
    } catch (e) {
      console.error('telegramAdapter: draft finalize reply failed:', e)
    }
  }

  return { update, finalize, cancel }
}

export function createTelegramAdapter(): ChannelAdapter {
  return {
    kind: 'telegram',
    reply: async (text) => {
      const r = await sendTelegramReply(text)
      return { success: r.success, error: r.error, ref: r.success ? { draftId: 0 } : undefined }
    },
    photo: async (imageBase64, caption) => {
      return window.electronAPI.homeAgent.channel.send('telegram', 'photo', {
        photo: imageBase64,
        caption,
      })
    },
    video: async (videoBase64, caption, filename) => {
      return window.electronAPI.homeAgent.channel.send('telegram', 'video', {
        video: videoBase64,
        caption,
        filename,
      })
    },
    voice: async (audioBase64, mime) => {
      return window.electronAPI.homeAgent.channel.send('telegram', 'voice', {
        audio: audioBase64,
        mime,
      })
    },
    document: async (documentBase64, filename, caption) => {
      return window.electronAPI.homeAgent.channel.send('telegram', 'document', {
        document: documentBase64,
        filename,
        caption,
      })
    },
    keyboard: async (text, buttons) => {
      return window.electronAPI.homeAgent.channel.send('telegram', 'keyboard', {
        text,
        parse_mode: PARSE_MODE,
        // Translate the channel-agnostic button matrix to snake_case Telegram-style
        // payload so the Python side does not need to know about camelCase
        // adapter keys.
        buttons: buttons.map((row) =>
          row.map((btn) => ({ text: btn.text, callback_data: btn.callbackData })),
        ),
      })
    },
    startTypingHeartbeat,
    createDraftStream,
    formatMarkdown: markdownToTelegramHtml,
    formatRichSnippet: (s) => s, // Telegram already speaks HTML
    formatDraft,
    formatFinal,
    formatImgGenPhase,
    formatItalic: (t) => `<i>${escapeHtml(t)}</i>`,
    escapeInline: escapeHtml,
  }
}
