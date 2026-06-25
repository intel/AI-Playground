// Channel-agnostic helpers shared by every ChannelAdapter implementation.

import { toolDisplayLabel } from '@/assets/js/tools/toolLabels'

// Tool parts that adapters render richly elsewhere (image/video previews), so
// the generic "used a tool" marker must skip them to avoid duplicate notices.
const TOOL_TYPES_RENDERED_ELSEWHERE = new Set(['tool-comfyUI', 'tool-comfyUiImageEdit'])

/** Render a concise "the model is using / used a tool" marker for any tool part
 *  the adapter doesn't already render specially. Returns null for non-tool parts
 *  and for image tools (handled by renderImageToolPart). `tense` selects the
 *  streaming (draft) vs persisted (final) wording. */
export function renderGenericToolMarker(
  part: { type: string; toolName?: string; state?: string },
  tense: 'using' | 'used',
): string | null {
  const isToolPart = part.type.startsWith('tool-') || part.type === 'dynamic-tool'
  if (!isToolPart) return null
  if (TOOL_TYPES_RENDERED_ELSEWHERE.has(part.type)) return null

  const rawName = part.type === 'dynamic-tool' ? (part.toolName ?? 'tool') : part.type
  const label = toolDisplayLabel(rawName)

  if (part.state === 'output-error') return `⚠️ ${label} failed`
  if (tense === 'using') return `🔧 Using ${label}…`
  return `🔧 Used ${label}`
}

/** Strip every `aipg-media://…` reference from a text part before forwarding
 *  it through a channel adapter. ComfyUI tool results already ship the image
 *  via `output.images` (a separate sendPhoto call); the model has the URL in
 *  its tool-result context and often parrots it back in narration ("You can
 *  view it here: aipg-media://AIPG_Image_…png"). External chat platforms
 *  cannot resolve `aipg-media://` URLs so leaving them in looks like a
 *  broken link next to the actual photo. */

const AIPG_MEDIA_URL_TOKEN_RE = /aipg-media:\/\/[^\s)\]]+/
const AIPG_MEDIA_URL_GLOBAL_RE = /aipg-media:\/\/[^\s)\]]+/g
const AIPG_MEDIA_IMAGE_MD_RE = /!\[[^\]]*]\(aipg-media:\/\/[^)\s]+\)/g
const AIPG_MEDIA_LINK_MD_RE = /\[[^\]]*]\(aipg-media:\/\/[^)\s]+\)/g
const AIPG_MEDIA_PHRASING_RE =
  /(?:[(\[<«]\s*)?(?:(?:you\s+can\s+)?(?:view|see|find|open|download|access|check\s+it\s+out)(?:\s+(?:it|the\s+(?:image|file|photo|result|generated\s+image)))?(?:\s+(?:here|at|out))?|here'?s?\s+(?:the\s+)?(?:image|link|file|url|photo|result|generated\s+image)|available(?:\s+at|\s+here)?|saved\s+(?:to|at)|stored\s+at|link|image|file|url|photo|path|location)\s*[:=]?\s*[(<\[«]?\s*aipg-media:\/\/[^\s)\]>»]+\s*[)\]>»]?/gi

export function stripAipgMediaReferences(input: string): string {
  if (!input || !AIPG_MEDIA_URL_TOKEN_RE.test(input)) return input
  let out = input
    .replace(AIPG_MEDIA_IMAGE_MD_RE, '')
    .replace(AIPG_MEDIA_LINK_MD_RE, '')
    .replace(AIPG_MEDIA_PHRASING_RE, '')
    .replace(AIPG_MEDIA_URL_GLOBAL_RE, '')
  // Tidy up the gaps left behind: empty parens / brackets, doubled spaces,
  // and stranded punctuation that used to lead into the URL.
  out = out
    .replace(/\(\s*\)|\[\s*\]|<\s*>/g, '')
    .replace(/[ \t]+([,.!?;])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

/** Minimal HTML escape for chunks of summary text rendered with parse_mode=HTML. */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

/** Telegram requires a non-zero int draft_id; uniqueness is only needed
 *  across concurrent open drafts in the same chat. Date.now() & 0x7fffffff
 *  gives a stable monotonic 31-bit value that fits Python int and JS safe-int
 *  comfortably. */
export function newDraftId(): number {
  const id = Date.now() & 0x7fffffff
  return id === 0 ? 1 : id
}

/** Sum elapsed reasoning ms across all reasoning parts in a turn. Each
 *  reasoning part carries its own start/finish timestamps via
 *  providerMetadata.aipg (set in openAiCompatibleChat's customFetch onChunk
 *  handler); the SDK can emit several reasoning blocks per turn (e.g. across
 *  tool-call cycles) so we sum per-block elapsed durations rather than
 *  spanning earliest-start → latest-finish — that keeps tool-execution gaps
 *  out of the reported figure. */
export function reasoningElapsedMsFromParts(
  parts: {
    type: string
    providerMetadata?: { aipg?: { reasoningStarted?: number; reasoningFinished?: number } }
  }[],
): number {
  let total = 0
  for (const part of parts) {
    if (part.type !== 'reasoning') continue
    const timing = part.providerMetadata?.aipg
    if (timing?.reasoningStarted && timing?.reasoningFinished) {
      total += Math.max(0, timing.reasoningFinished - timing.reasoningStarted)
    }
  }
  return total
}

/** Draft animation throttle (ms) and Telegram preview keep-alive interval. */
export const DRAFT_THROTTLE_MS = 800
export const DRAFT_KEEPALIVE_MS = 25_000
/** Rotating spinner frames used to differentiate keep-alive draft updates so
 *  the preview window doesn't lapse on identical content. */
export const DRAFT_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
