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

// Shared guidance appended to the search/browse descriptions so the model digs
// into real pages instead of answering from search snippets (which are often
// incomplete or wrong), while letting it decide how deep to go.
const RESEARCH_DEPTH_GUIDANCE =
  ' Search snippets are often incomplete or even incorrect: after searching, open the ' +
  'most relevant result page(s) with browseWeb and base your answer on their actual ' +
  'content. Judge how many pages to read from the user request — a simple fact may need ' +
  'one page, while a comparison or summary needs several. If doing it thoroughly would ' +
  'require reading more than a few pages, read the most promising ones first, then ask ' +
  'the user whether they want you to dig deeper before continuing.'

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

function formatSearchResults(results: WebSearchResults): string {
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

export const searchWeb = tool({
  description:
    'Search the web and get a clean list of result pages (title, URL, and snippet) for a ' +
    'query. Use this as the entry point for any question that needs current or external ' +
    'information.' +
    RESEARCH_DEPTH_GUIDANCE,
  inputSchema: z.object({
    query: z.string().describe('The search query.'),
    maxResults: z
      .number()
      .optional()
      .describe('Maximum number of results to return (default 8).'),
  }),
  execute: async (args: { query: string; maxResults?: number }, options) => {
    const activities = useActivities()
    const webBrowser = useWebBrowser()
    const conversationKey = conversationKeyFor(options?.experimental_context)
    return await activities.track(
      {
        category: 'browsing',
        label: 'Searching the web…',
        detail: args.query,
        scope: chatScope(conversationKey),
      },
      async () => await webBrowser.search(args.query, args.maxResults),
    )
  },
  toModelOutput: ({ output }) => ({
    type: 'text',
    value: formatSearchResults(output as WebSearchResults),
  }),
})

export const browseWeb = tool({
  description:
    'Open a web page in AI Playground\'s background browser and read its content. ' +
    'Pass a full URL (e.g. "https://example.com") — typically a result URL from searchWeb. ' +
    'Returns the page title, readable text, and a numbered list of links you can ' +
    'follow with interactWithWebPage. The browser runs in the background; the user ' +
    'can choose to reveal the window.' +
    RESEARCH_DEPTH_GUIDANCE,
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

type ScreenshotWebPageOutput = {
  ok: boolean
  message: string
  // data:image/png;base64,... — kept so the chat UI can render the capture and
  // openAiCompatibleChat can inject it as a real vision image for the model.
  dataUri?: string
}

export const screenshotWebPage = tool({
  description:
    'Capture a screenshot of the page currently open in the background browser and return ' +
    'it as an image you can inspect. Only use this when the user explicitly asks for a ' +
    'screenshot or a visual look at the page, or when the page cannot be understood from ' +
    'its text (e.g. charts, diagrams, image-only or heavily visual layouts). For normal ' +
    'pages prefer browseWeb, which returns the readable text. Open a page with browseWeb ' +
    'or searchWeb first.',
  inputSchema: z.object({}),
  execute: async (_args, options): Promise<ScreenshotWebPageOutput> => {
    const activities = useActivities()
    const webBrowser = useWebBrowser()
    const conversationKey = conversationKeyFor(options?.experimental_context)
    return await activities.track(
      {
        category: 'browsing',
        label: 'Capturing the page…',
        detail: webBrowser.currentUrl,
        scope: chatScope(conversationKey),
      },
      async () => {
        try {
          const base64 = await webBrowser.screenshot()
          if (!base64) {
            return { ok: false, message: 'Could not capture the page (no image returned).' }
          }
          return {
            ok: true,
            message: 'Captured the current page.',
            dataUri: `data:image/png;base64,${base64}`,
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { ok: false, message }
        }
      },
    )
  },
  // The image is NOT returned here: the OpenAI-compatible backend JSON-stringifies
  // tool-result content, so base64 would be sent as text. openAiCompatibleChat's
  // request post-processing detects this tool's result and injects the capture as
  // a real image message (mirrors captureScreenshot).
  toModelOutput: ({ output }) => {
    const value = output as ScreenshotWebPageOutput
    if (!value.ok) return { type: 'error-text', value: value.message }
    return { type: 'text', value: value.message }
  },
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
