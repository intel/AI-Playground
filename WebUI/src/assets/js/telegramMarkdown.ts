import { Marked, type Token, type Tokens } from 'marked'

const lexer = new Marked({ pedantic: false, gfm: true, breaks: true, async: false })

const TELEGRAM_MAX_CHARS = 4096

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;')
}

function renderInline(tokens: Token[] | undefined): string {
  if (!tokens) return ''
  let out = ''
  for (const t of tokens) out += renderToken(t)
  return out
}

function renderListItem(item: Tokens.ListItem): string {
  let out = ''
  for (const tok of item.tokens) {
    if (tok.type === 'text') {
      const tt = tok as Tokens.Text
      out += tt.tokens ? renderInline(tt.tokens) : escapeText(tt.text)
    } else if (tok.type === 'paragraph') {
      out += renderInline((tok as Tokens.Paragraph).tokens)
    } else if (tok.type === 'list') {
      const nested = renderToken(tok).trimEnd()
      out +=
        '\n' +
        nested
          .split('\n')
          .map((l) => (l ? '  ' + l : l))
          .join('\n')
    } else {
      out += renderToken(tok).trimEnd()
    }
  }
  return out.trim()
}

function renderTable(t: Tokens.Table): string {
  const rows: string[][] = []
  rows.push(t.header.map((c) => c.text))
  for (const row of t.rows) rows.push(row.map((c) => c.text))
  return rows.map((r) => r.map((c) => escapeText(c)).join(' | ')).join('\n')
}

function renderToken(t: Token): string {
  switch (t.type) {
    case 'text': {
      const tt = t as Tokens.Text
      if (tt.tokens && tt.tokens.length > 0) return renderInline(tt.tokens)
      return escapeText(tt.text)
    }
    case 'escape':
      return escapeText((t as Tokens.Escape).text)
    case 'strong':
      return `<b>${renderInline((t as Tokens.Strong).tokens)}</b>`
    case 'em':
      return `<i>${renderInline((t as Tokens.Em).tokens)}</i>`
    case 'del':
      return `<s>${renderInline((t as Tokens.Del).tokens)}</s>`
    case 'codespan':
      return `<code>${escapeText((t as Tokens.Codespan).text)}</code>`
    case 'br':
      return '\n'
    case 'link': {
      const lt = t as Tokens.Link
      // Only emit anchor for http(s)/tg/mailto; otherwise show inner text only.
      const href = lt.href || ''
      if (/^(https?|tg|mailto):/i.test(href)) {
        return `<a href="${escapeAttr(href)}">${renderInline(lt.tokens)}</a>`
      }
      return renderInline(lt.tokens)
    }
    case 'image': {
      // Telegram HTML mode does not support inline images; show alt text only.
      const it = t as Tokens.Image
      return escapeText(it.text || it.title || '')
    }
    case 'paragraph':
      return renderInline((t as Tokens.Paragraph).tokens) + '\n\n'
    case 'heading':
      return `<b>${renderInline((t as Tokens.Heading).tokens)}</b>\n\n`
    case 'code': {
      const ct = t as Tokens.Code
      const langRaw = (ct.lang || '').split(/\s+/)[0]
      const lang = langRaw ? ` class="language-${escapeAttr(langRaw)}"` : ''
      return `<pre><code${lang}>${escapeText(ct.text)}</code></pre>\n`
    }
    case 'blockquote': {
      const bt = t as Tokens.Blockquote
      const inner = renderBlocks(bt.tokens).trim()
      return `<blockquote>${inner}</blockquote>\n\n`
    }
    case 'list': {
      const lt = t as Tokens.List
      let out = ''
      let n = typeof lt.start === 'number' && lt.start ? lt.start : 1
      for (const item of lt.items) {
        const prefix = lt.ordered ? `${n}. ` : '• '
        out += prefix + renderListItem(item) + '\n'
        n++
      }
      return out + '\n'
    }
    case 'hr':
      return '\n———\n\n'
    case 'space':
      return '\n'
    case 'html': {
      // Strip raw HTML — emit it as escaped text so nothing leaks unescaped.
      const ht = t as Tokens.HTML | Tokens.Tag
      return escapeText((ht.raw as string | undefined) ?? ht.text ?? '')
    }
    case 'table':
      return renderTable(t as Tokens.Table) + '\n'
    default: {
      const anyT = t as { tokens?: Token[]; text?: string }
      if (anyT.tokens) return renderInline(anyT.tokens)
      return anyT.text ? escapeText(anyT.text) : ''
    }
  }
}

function renderBlocks(tokens: Token[]): string {
  let out = ''
  for (const t of tokens) out += renderToken(t)
  return out
}

/**
 * Convert GitHub-flavored Markdown to Telegram-flavored HTML.
 *
 * Telegram HTML mode only supports a small set of tags
 * (b/strong, i/em, u/ins, s/strike/del, a, code, pre, blockquote, tg-spoiler).
 * Headings and lists are rendered as bold lines and bulleted lines respectively.
 * Raw HTML in the source is escaped so it can never produce unsupported tags.
 *
 * Output is truncated to Telegram's 4096-char per-message limit.
 */
export function markdownToTelegramHtml(md: string): string {
  if (!md) return ''
  let html: string
  try {
    const tokens = lexer.lexer(md)
    html = renderBlocks(tokens)
  } catch (e) {
    console.error('markdownToTelegramHtml: lexer/render failed, falling back to plain text', e)
    html = escapeText(md)
  }
  // Collapse 3+ newlines and trim.
  html = html.replace(/\n{3,}/g, '\n\n').trim()
  if (html.length > TELEGRAM_MAX_CHARS) {
    html = html.slice(0, TELEGRAM_MAX_CHARS - 1) + '…'
  }
  return html
}
