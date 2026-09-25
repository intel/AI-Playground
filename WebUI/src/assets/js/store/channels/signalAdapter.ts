// Signal ChannelAdapter — wraps the generic channel:send IPC. Signal messages
// are plain text (no HTML/mrkdwn), and Signal has no interactive buttons, so
// keyboards are rendered as a numbered text list by the Python channel.

import { markdownToSignalText, htmlSnippetToSignalText } from '../../signalMarkdown'
import type { ChannelAdapter, DraftStream, ImgGenPhaseInput, RawPart } from './adapter'
import { reasoningElapsedMsFromParts } from '@/lib/reasoningTimings'
import { renderGenericToolMarker, stripAipgMediaReferences } from './adapterHelpers'

function sendSignalReply(text: string): Promise<{ success: boolean; error?: string }> {
  return window.electronAPI.homeAgent.channel.send('signal', 'reply', { text })
}

/** Render one image tool part as plain text (present or past tense). */
function renderImageToolPart(part: RawPart, verb: 'Generating' | 'Generated'): string | null {
  const { workflow, prompt } = part.input ?? {}
  if (!workflow && !prompt) return null
  const phase = part.state === 'output-available' ? '✅' : '🎨'
  const lines = [workflow ? `${phase} ${verb} using preset ${workflow}` : `${phase} ${verb} image`]
  if (prompt) lines.push(prompt)
  return lines.join('\n')
}

function renderParts(parts: RawPart[], tense: 'using' | 'used'): string {
  const verb = tense === 'using' ? 'Generating' : 'Generated'
  const lines: string[] = []
  for (const part of parts) {
    if (part.type === 'reasoning') {
      const txt = (part.text ?? '').trim()
      if (txt) lines.push(`💭 ${txt}`)
    } else if (part.type === 'text') {
      const cleaned = stripAipgMediaReferences(part.text ?? '').trim()
      if (cleaned) lines.push(markdownToSignalText(cleaned))
    } else if (part.type === 'tool-comfyUI' || part.type === 'tool-comfyUiImageEdit') {
      const marker = renderImageToolPart(part, verb)
      if (marker) lines.push(marker)
    } else {
      const marker = renderGenericToolMarker(part, tense)
      if (marker) lines.push(marker)
    }
  }
  return lines.join('\n\n')
}

function formatFinal(parts: RawPart[]): string {
  const reasoning = parts
    .filter((p) => p.type === 'reasoning')
    .map((p) => (p.text ?? '').trim())
    .filter(Boolean)
  const lines: string[] = []
  if (reasoning.length > 0) {
    const seconds = (reasoningElapsedMsFromParts(parts) / 1000).toFixed(1)
    lines.push(`💭 Thought for ${seconds} seconds`)
  }
  const body = renderParts(
    parts.filter((p) => p.type !== 'reasoning'),
    'used',
  )
  if (body) lines.push(body)
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
      return step ? `✨ ${step}` : '✨ Generating…'
    case 'image_out':
      return '🖼 Finalizing image…'
    default:
      return `🎬 Preparing ${presetName}…`
  }
}

/** Signal typing indicator. signal-cli typing lasts ~15 s, so refresh on a
 *  slower cadence than Telegram's 4 s chat action. */
function startTypingHeartbeat(action: string = 'typing'): () => void {
  let stopped = false
  const send = (a: string) =>
    void window.electronAPI.homeAgent.channel.send('signal', 'typing', { action: a })
  send(action)
  const intervalId = setInterval(() => {
    if (!stopped) send(action)
  }, 10000)
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(intervalId)
    send('stop')
  }
}

/** Signal has no ephemeral draft: skip live updates and post the final reply
 *  once. The typing indicator covers the "working" state. */
function createDraftStream(): DraftStream {
  let stopped = false
  return {
    update: () => {},
    cancel: () => {
      stopped = true
    },
    finalize: async (finalText: string) => {
      if (stopped || !finalText) return
      try {
        const result = await sendSignalReply(finalText)
        if (!result?.success) {
          console.error('signalAdapter: finalize reply error:', result?.error ?? 'unknown')
        }
      } catch (e) {
        console.error('signalAdapter: finalize reply failed:', e)
      }
    },
  }
}

export function createSignalAdapter(): ChannelAdapter {
  return {
    kind: 'signal',
    reply: async (text) => {
      const r = await sendSignalReply(text)
      return { success: r.success, error: r.error, ref: r.success ? {} : undefined }
    },
    photo: async (imageBase64, caption) =>
      window.electronAPI.homeAgent.channel.send('signal', 'photo', {
        photo: imageBase64,
        caption,
      }),
    video: async (videoBase64, caption, filename) =>
      window.electronAPI.homeAgent.channel.send('signal', 'video', {
        video: videoBase64,
        caption,
        filename,
      }),
    voice: async (audioBase64, mime) =>
      window.electronAPI.homeAgent.channel.send('signal', 'voice', {
        audio: audioBase64,
        mime,
      }),
    document: async (documentBase64, filename, caption) =>
      window.electronAPI.homeAgent.channel.send('signal', 'document', {
        document: documentBase64,
        filename,
        caption,
      }),
    keyboard: async (text, buttons) => {
      const r = await window.electronAPI.homeAgent.channel.send('signal', 'keyboard', {
        text,
        buttons: buttons.map((row) =>
          row.map((btn) => ({ text: btn.text, callback_data: btn.callbackData })),
        ),
      })
      // Signal buttons are plain numbered text; the ref is only used to "settle"
      // the prompt, which for Signal is just another message.
      return { success: r.success, error: r.error, ref: r.success ? { messageId: 0 } : undefined }
    },
    editKeyboardMessage: async (_ref, text) => {
      const r = await window.electronAPI.homeAgent.channel.send('signal', 'editMessage', { text })
      return { success: r.success, error: r.error }
    },
    startTypingHeartbeat,
    createDraftStream,
    formatMarkdown: markdownToSignalText,
    formatRichSnippet: htmlSnippetToSignalText,
    formatDraft: (parts) => renderParts(parts, 'using'),
    formatFinal,
    formatImgGenPhase,
    // Signal messages are plain text; emphasis markers would show literally.
    formatItalic: (t) => t,
    escapeInline: (t) => t,
  }
}
