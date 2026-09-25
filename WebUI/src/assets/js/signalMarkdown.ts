// Signal has no rich-text send API over signal-cli JSON-RPC — messages are
// plain text. Convert assistant markdown into readable plain text: drop the
// syntax that would otherwise show up as literal characters, keep the content.

export function markdownToSignalText(md: string): string {
  if (!md) return ''
  let out = md
  // Fenced code blocks → keep the inner code, drop the fences.
  out = out.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => String(code).trimEnd())
  // Images: drop entirely (the media is sent as a separate attachment).
  out = out.replace(/!\[[^\]]*]\([^)]*\)/g, '')
  // Links [text](url) → "text (url)".
  out = out.replace(/\[([^\]]+)]\(([^)\s]+)[^)]*\)/g, '$1 ($2)')
  // Inline code, bold, italic, strikethrough markers → keep the inner text.
  out = out.replace(/`([^`]+)`/g, '$1')
  out = out.replace(/(\*\*|__)(.*?)\1/g, '$2')
  out = out.replace(/(\*|_)(.*?)\1/g, '$2')
  out = out.replace(/~~(.*?)~~/g, '$2')
  // Headings / blockquote markers at line starts.
  out = out.replace(/^#{1,6}\s+/gm, '')
  out = out.replace(/^\s*>\s?/gm, '')
  // Collapse the whitespace left behind.
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n')
  return out.trim()
}

/** Reduce one of our hand-authored HTML snippets (HELP_MESSAGE, banners) to
 *  plain text for Signal. Strips tags and unescapes the few entities we emit. */
export function htmlSnippetToSignalText(html: string): string {
  if (!html) return ''
  return html
    .replace(/<\/(p|div|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>(?!\n)/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
