import { isToolUIPart } from 'ai'
import * as toast from '@/assets/js/toast'

// Inline ![alt](aipg-media://…) tokens also render as a media card, so they are
// stripped from the text to avoid showing the image twice.
const INLINE_MEDIA = /!\[[^\]]*]\(aipg-media:\/\/[^)]+\)/g

export function stripInlineMedia(text: string): string {
  return text.replace(INLINE_MEDIA, '').trim()
}

type TextBearing = { parts?: readonly { type: string; text?: string }[] }

/** The text a message shows, which is also what Copy and Speak use. */
export function messageText(message: TextBearing): string {
  return (message.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => stripInlineMedia(part.text ?? ''))
    .filter((text) => text.length > 0)
    .join('\n\n')
}

/** Streamed text, reasoning or a tool card: something is on screen already. */
export function messageHasVisibleContent(message: TextBearing): boolean {
  return (
    message.parts?.some((part) => {
      if (part.type === 'text') return stripInlineMedia(part.text ?? '').length > 0
      if (part.type === 'reasoning') return true
      return isToolUIPart(part as Parameters<typeof isToolUIPart>[0])
    }) ?? false
  )
}

export function copyToClipboard(text: string, successTip: string): void {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success(successTip))
    .catch((e) => console.error('Error while copying text to clipboard', e))
}
