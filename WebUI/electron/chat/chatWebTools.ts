import {
  getState,
  interact,
  navigate,
  screenshot,
  search,
  type WebBrowserInteraction,
  type WebPageSnapshot,
  type WebSearchResults,
} from '../adapters/webBrowserManager'
import { trackChatToolActivity } from './chatToolActivity'

// ── Chat web tools, in main (docs/architecture-target.md §8) ─────────────────
//
// `searchWeb` / `browseWeb` / `interactWithWebPage` / `screenshotWebPage` drive
// the dedicated `BrowserWindow` the manager owns, which has always lived in
// main — the renderer hop was Pinia `activities.track` plus an IPC forward.
// The formatters below moved with them: the tool set crosses to main as JSON
// Schema, so a renderer `toModelOutput` would never reach the model.

export const CHAT_WEB_TOOLS = new Set([
  'searchWeb',
  'browseWeb',
  'interactWithWebPage',
  'screenshotWebPage',
])

const MAX_LINKS_RETURNED = 40

export type ScreenshotWebPageOutput = {
  ok: boolean
  message: string
  /** data:image/png;base64,… — the UI renders it and the engine injects it as vision. */
  dataUri?: string
}

// The browser window returns structured data; we flatten it to a compact string
// for the model. A string (rather than a nested output schema) keeps the AI
// SDK's `InferUITools` inference shallow — deep tool outputs collapse the whole
// message-type graph to `any` (see tools.ts).
export function formatSnapshot(snapshot: WebPageSnapshot): string {
  const lines: string[] = []
  lines.push(`Title: ${snapshot.title || '(untitled)'}`)
  lines.push(`URL: ${snapshot.url}`)
  lines.push('')
  lines.push('Page content:')
  lines.push(snapshot.text || '(no readable text on this page)')
  if (snapshot.links.length > 0) {
    lines.push('')
    lines.push('Links (use interactWithWebPage with the linkIndex to follow one):')
    for (const link of snapshot.links.slice(0, MAX_LINKS_RETURNED)) {
      lines.push(`[${link.index}] ${link.text} — ${link.href}`)
    }
  }
  return lines.join('\n')
}

export function formatSearchResults(results: WebSearchResults): string {
  if (results.results.length === 0) {
    return (
      `No search results found for "${results.query}". Try a different query, or open a ` +
      `specific URL with browseWeb.`
    )
  }
  const lines: string[] = [`Search results for "${results.query}":`]
  results.results.forEach((r, index) => {
    lines.push(`[${index}] ${r.title} — ${r.url}`)
    if (r.snippet) lines.push(`    ${r.snippet}`)
  })
  return lines.join('\n')
}

export async function executeChatWebTool(options: {
  toolName: string
  input: unknown
  conversationKey?: string
}): Promise<unknown> {
  const args = (options.input ?? {}) as Record<string, unknown>
  const conversationKey = options.conversationKey
  switch (options.toolName) {
    case 'searchWeb': {
      const query = typeof args.query === 'string' ? args.query : ''
      return await trackChatToolActivity(
        { category: 'browsing', label: 'Searching the web…', detail: query, conversationKey },
        () => search(query, typeof args.maxResults === 'number' ? args.maxResults : undefined),
      )
    }
    case 'browseWeb': {
      const url = typeof args.url === 'string' ? args.url : ''
      return await trackChatToolActivity(
        { category: 'browsing', label: 'Browsing the web…', detail: url, conversationKey },
        () => navigate(url),
      )
    }
    case 'interactWithWebPage': {
      const action = args.action as 'click' | 'scroll' | 'back'
      const linkIndex = typeof args.linkIndex === 'number' ? args.linkIndex : undefined
      const selector = typeof args.selector === 'string' ? args.selector : undefined
      const interaction: WebBrowserInteraction =
        action === 'click'
          ? { action: 'click', linkIndex, selector }
          : action === 'scroll'
            ? { action: 'scroll', selector }
            : { action: 'back' }
      return await trackChatToolActivity(
        {
          category: 'browsing',
          label: 'Browsing the web…',
          detail: getState().currentUrl,
          conversationKey,
        },
        () => interact(interaction),
      )
    }
    case 'screenshotWebPage': {
      return await trackChatToolActivity(
        {
          category: 'browsing',
          label: 'Capturing the page…',
          detail: getState().currentUrl,
          conversationKey,
        },
        async (): Promise<ScreenshotWebPageOutput> => {
          try {
            const base64 = await screenshot()
            if (!base64) {
              return { ok: false, message: 'Could not capture the page (no image returned).' }
            }
            return {
              ok: true,
              message: 'Captured the current page.',
              dataUri: `data:image/png;base64,${base64}`,
            }
          } catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error) }
          }
        },
      )
    }
    default:
      throw new Error(`Unknown web tool: ${options.toolName}`)
  }
}
