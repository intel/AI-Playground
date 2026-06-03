import { tool } from 'ai'
import { z } from 'zod'
import { useActivities } from '../store/activities'
import { useWebBrowser } from '../store/webBrowser'
import { useConversations } from '../store/conversations'

// The conversation a tool call belongs to is surfaced via `experimental_context`
// (set in openAiCompatibleChat's streamText call), so the "Browsing the web…"
// activity (and its "Show window" button) anchors to the right chat turn.
function conversationKeyFor(experimentalContext: unknown): string {
  const ctx = experimentalContext as { conversationKey?: string } | undefined
  return ctx?.conversationKey ?? useConversations().activeKey
}

function chatScope(conversationKey: string): { kind: 'chat'; conversationKey: string } {
  return { kind: 'chat', conversationKey }
}

const MAX_LINKS_RETURNED = 40

// The browser window returns structured data; we flatten it to a compact string
// for the model. A string (rather than a nested output schema) keeps the AI
// SDK's `InferUITools` inference shallow — deep tool outputs collapse the whole
// message-type graph to `any` (see tools.ts).
function formatSnapshot(snapshot: WebPageSnapshot): string {
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

export const browseWeb = tool({
  description:
    'Open a web page in AI Playground\'s background browser and read its content. ' +
    'Pass a full URL (e.g. "https://example.com"). To search the web, navigate to a ' +
    'search engine results URL (e.g. "https://duckduckgo.com/html/?q=your+query"). ' +
    'Returns the page title, readable text, and a numbered list of links you can ' +
    'follow with interactWithWebPage. The browser runs in the background; the user ' +
    'can choose to reveal the window.',
  inputSchema: z.object({
    url: z
      .string()
      .describe('The URL of the page to open. A scheme is optional (https:// is assumed).'),
  }),
  execute: async (args: { url: string }, options) => {
    const activities = useActivities()
    const webBrowser = useWebBrowser()
    const conversationKey = conversationKeyFor(options?.experimental_context)
    return await activities.track(
      {
        category: 'browsing',
        label: 'Browsing the web…',
        detail: args.url,
        scope: chatScope(conversationKey),
      },
      async () => await webBrowser.navigate(args.url),
    )
  },
  // The UI reads the structured snapshot (title/url) for the browse-trace
  // element; the model only needs the readable text + numbered links.
  toModelOutput: ({ output }) => ({
    type: 'text',
    value: formatSnapshot(output as WebPageSnapshot),
  }),
})

export const interactWithWebPage = tool({
  description:
    'Interact with the page currently open in the background browser, then read the ' +
    'updated page. Use "click" with a linkIndex (from a previous browseWeb/interact ' +
    'result) to follow a link, "scroll" to load more content, or "back" to return to ' +
    'the previous page. Only use this after browseWeb has opened a page.',
  inputSchema: z.object({
    action: z
      .enum(['click', 'scroll', 'back'])
      .describe('The interaction to perform on the current page.'),
    linkIndex: z
      .number()
      .optional()
      .describe('For "click": the index of the link to follow (from the links list).'),
    selector: z
      .string()
      .optional()
      .describe(
        'For "click"/"scroll": an optional CSS selector to target instead of a linkIndex.',
      ),
  }),
  execute: async (
    args: { action: 'click' | 'scroll' | 'back'; linkIndex?: number; selector?: string },
    options,
  ) => {
    const activities = useActivities()
    const webBrowser = useWebBrowser()
    const conversationKey = conversationKeyFor(options?.experimental_context)
    const interaction: WebBrowserInteraction =
      args.action === 'click'
        ? { action: 'click', linkIndex: args.linkIndex, selector: args.selector }
        : args.action === 'scroll'
          ? { action: 'scroll', selector: args.selector }
          : { action: 'back' }
    return await activities.track(
      {
        category: 'browsing',
        label: 'Browsing the web…',
        detail: webBrowser.currentUrl,
        scope: chatScope(conversationKey),
      },
      async () => await webBrowser.interact(interaction),
    )
  },
  toModelOutput: ({ output }) => ({
    type: 'text',
    value: formatSnapshot(output as WebPageSnapshot),
  }),
})
