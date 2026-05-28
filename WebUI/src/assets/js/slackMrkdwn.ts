import { Marked, type Token, type Tokens } from 'marked'

const lexer = new Marked({ pedantic: false, gfm: true, breaks: true, async: false })

// Slack's per-message text limit is 40k chars, but Block Kit text blocks cap at
// 3000. Stay under the section-block ceiling so the same converted output can
// be reused inside Block Kit when needed.
const SLACK_MAX_CHARS = 3000

function escapeSpecial(s: string): string {
  // Only Slack's three "control" chars need escaping inside mrkdwn so they
  // don't accidentally start a link/user-mention/channel-mention.
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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
      out += tt.tokens ? renderInline(tt.tokens) : escapeSpecial(tt.text)
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
  return rows.map((r) => r.map((c) => escapeSpecial(c)).join(' | ')).join('\n')
}

function renderToken(t: Token): string {
  switch (t.type) {
    case 'text': {
      const tt = t as Tokens.Text
      if (tt.tokens && tt.tokens.length > 0) return renderInline(tt.tokens)
      return escapeSpecial(tt.text)
    }
    case 'escape':
      return escapeSpecial((t as Tokens.Escape).text)
    case 'strong':
      return `*${renderInline((t as Tokens.Strong).tokens)}*`
    case 'em':
      return `_${renderInline((t as Tokens.Em).tokens)}_`
    case 'del':
      return `~${renderInline((t as Tokens.Del).tokens)}~`
    case 'codespan':
      return '`' + escapeSpecial((t as Tokens.Codespan).text) + '`'
    case 'br':
      return '\n'
    case 'link': {
      const lt = t as Tokens.Link
      const href = lt.href || ''
      const inner = renderInline(lt.tokens)
      if (/^(https?|mailto|slack):/i.test(href)) {
        // Slack link syntax: <url|label>. The label must not contain `|` or `>`.
        const safeLabel = inner.replace(/[|>]/g, ' ')
        return `<${href}|${safeLabel}>`
      }
      return inner
    }
    case 'image': {
      // Slack mrkdwn doesn't support inline images here (we ship images
      // separately via files.upload_v2). Show alt/title text as a fallback.
      const it = t as Tokens.Image
      return escapeSpecial(it.text || it.title || '')
    }
    case 'paragraph':
      return renderInline((t as Tokens.Paragraph).tokens) + '\n\n'
    case 'heading':
      return `*${renderInline((t as Tokens.Heading).tokens)}*\n\n`
    case 'code': {
      const ct = t as Tokens.Code
      // Slack code blocks use triple backticks; language hint is dropped.
      return '```\n' + ct.text + '\n```\n'
    }
    case 'blockquote': {
      const bt = t as Tokens.Blockquote
      const inner = renderBlocks(bt.tokens).trim()
      // Slack quotes prefix every line with `> `.
      return (
        inner
          .split('\n')
          .map((l) => (l ? `> ${l}` : '>'))
          .join('\n') + '\n\n'
      )
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
      const ht = t as Tokens.HTML | Tokens.Tag
      return escapeSpecial((ht.raw as string | undefined) ?? ht.text ?? '')
    }
    case 'table':
      return renderTable(t as Tokens.Table) + '\n'
    default: {
      const anyT = t as { tokens?: Token[]; text?: string }
      if (anyT.tokens) return renderInline(anyT.tokens)
      return anyT.text ? escapeSpecial(anyT.text) : ''
    }
  }
}

function renderBlocks(tokens: Token[]): string {
  let out = ''
  for (const t of tokens) out += renderToken(t)
  return out
}

/**
 * Convert GitHub-flavored Markdown to Slack mrkdwn.
 *
 * Slack mrkdwn is a lighter-weight markup than the source GFM:
 *   - `*bold*`, `_italic_`, `~strike~`, `` `code` ``, ```` ```code blocks``` ````
 *   - links use `<url|label>` syntax
 *   - blockquotes prefix every line with `>`
 *   - headings render as bold standalone lines
 *
 * Output is truncated to a section-block-safe length (3000 chars).
 */
export function markdownToSlackMrkdwn(md: string): string {
  if (!md) return ''
  let text: string
  try {
    const tokens = lexer.lexer(md)
    text = renderBlocks(tokens)
  } catch (e) {
    console.error('markdownToSlackMrkdwn: lexer/render failed, falling back to plain text', e)
    text = escapeSpecial(md)
  }
  text = text.replace(/\n{3,}/g, '\n\n').trim()
  if (text.length > SLACK_MAX_CHARS) {
    text = text.slice(0, SLACK_MAX_CHARS - 1) + '…'
  }
  return text
}
