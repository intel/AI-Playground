import { Marked, type Token, type Tokens } from 'marked'

// Dedicated lexer instance so options never collide with the rendering parser
// in markdownParser.ts. We only ever call `.lexer()` (no HTML rendering).
const lexer = new Marked({ gfm: true, breaks: true, pedantic: false, async: false })

/**
 * Convert markdown to readable plain text for text-to-speech.
 *
 * Assistant replies are markdown, but a synthesizer reads literal `**`, `#`,
 * link URLs, and code fences aloud. This walks the lexed token tree and emits
 * clean prose: emphasis/links/headings are unwrapped, list bullets dropped,
 * and fenced code blocks omitted entirely (reading code aloud is noise).
 */
export function markdownToSpeechText(md: string): string {
  if (!md) return ''
  try {
    const tokens = lexer.lexer(md)
    const text = renderTokens(tokens)
    return collapse(text)
  } catch (error) {
    console.error('markdownToSpeechText: lexing failed, using regex fallback', error)
    return regexFallback(md)
  }
}

/** Render a list of block-level tokens, separating blocks with blank lines. */
function renderTokens(tokens: Token[]): string {
  const blocks: string[] = []
  for (const token of tokens) {
    const rendered = renderBlock(token)
    if (rendered.trim()) blocks.push(rendered.trim())
  }
  return blocks.join('\n\n')
}

function renderBlock(token: Token): string {
  switch (token.type) {
    case 'heading':
    case 'paragraph': {
      const t = token as Tokens.Heading | Tokens.Paragraph
      return renderInline(t.tokens ?? [])
    }
    case 'text': {
      const t = token as Tokens.Text
      return t.tokens ? renderInline(t.tokens) : (t.text ?? '')
    }
    case 'blockquote': {
      const t = token as Tokens.Blockquote
      return renderTokens(t.tokens ?? [])
    }
    case 'list': {
      const t = token as Tokens.List
      return t.items.map((item) => renderBlock(item)).join('\n')
    }
    case 'list_item': {
      const t = token as Tokens.ListItem
      return renderTokens(t.tokens ?? [])
    }
    case 'table': {
      const t = token as Tokens.Table
      const rows: string[] = []
      rows.push(t.header.map((cell) => renderInline(cell.tokens ?? [])).join(', '))
      for (const row of t.rows) {
        rows.push(row.map((cell) => renderInline(cell.tokens ?? [])).join(', '))
      }
      return rows.join('\n')
    }
    // Reading code aloud is noise; drop fenced blocks and horizontal rules.
    case 'code':
    case 'hr':
    case 'space':
    case 'html':
      return ''
    default:
      // Unknown block: fall back to any inline tokens, else raw text.
      return renderInline((token as { tokens?: Token[] }).tokens ?? [])
  }
}

/** Render inline tokens to plain text (unwrap emphasis, links, code spans). */
function renderInline(tokens: Token[]): string {
  let out = ''
  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text
        out += t.tokens ? renderInline(t.tokens) : (t.text ?? '')
        break
      }
      case 'strong':
      case 'em':
      case 'del': {
        const t = token as Tokens.Strong | Tokens.Em | Tokens.Del
        out += t.tokens ? renderInline(t.tokens) : (t.text ?? '')
        break
      }
      case 'codespan': {
        out += (token as Tokens.Codespan).text ?? ''
        break
      }
      case 'link': {
        // Read the link text only, never the URL.
        const t = token as Tokens.Link
        out += t.tokens ? renderInline(t.tokens) : (t.text ?? '')
        break
      }
      case 'image': {
        // Speak the alt text if any; drop the source (e.g. aipg-media:// tokens).
        out += (token as Tokens.Image).text ?? ''
        break
      }
      case 'br': {
        out += '\n'
        break
      }
      case 'escape': {
        out += (token as Tokens.Escape).text ?? ''
        break
      }
      case 'html': {
        // Inline raw HTML is not spoken.
        break
      }
      default: {
        const t = token as { tokens?: Token[]; text?: string }
        out += t.tokens ? renderInline(t.tokens) : (t.text ?? '')
      }
    }
  }
  return out
}

/** Normalize whitespace: collapse runs of blank lines and trim. */
function collapse(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Minimal best-effort stripper used only if the lexer throws. */
function regexFallback(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1') // links -> text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s{0,3}>\s?/gm, '') // blockquotes
    .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '') // list markers
    .replace(/[*_~]/g, '') // emphasis markers
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
