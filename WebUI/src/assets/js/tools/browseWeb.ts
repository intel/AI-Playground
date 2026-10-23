import { tool } from 'ai'
import { z } from 'zod'
import { ToolConversationContextSchema } from './toolContext'

// Schema + description only. The bodies run in main against the browser window
// the manager already owned (`electron/chat/chatWebTools.ts`), which is also
// where the model-facing formatters live — a `toModelOutput` declared here
// would never reach the model, since the tool set crosses to main as JSON
// Schema.

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

// What main returns, so the browse-trace element stays typed. The model never
// sees this shape — `chatWebTools.ts` flattens it to text.
const WebPageSnapshotSchema = z.object({
  title: z.string(),
  url: z.string(),
  text: z.string(),
  links: z.array(z.object({ index: z.number(), text: z.string(), href: z.string() })),
})

export const searchWeb = tool({
  description:
    'Search the web and get a clean list of result pages (title, URL, and snippet) for a ' +
    'query. Use this as the entry point for any question that needs current or external ' +
    'information.' +
    RESEARCH_DEPTH_GUIDANCE,
  inputSchema: z.object({
    query: z.string().describe('The search query.'),
    maxResults: z.number().optional().describe('Maximum number of results to return (default 8).'),
  }),
  contextSchema: ToolConversationContextSchema,
})

export const browseWeb = tool({
  description:
    "Open a web page in AI Playground's background browser and read its content. " +
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
  outputSchema: WebPageSnapshotSchema,
  contextSchema: ToolConversationContextSchema,
})

export const screenshotWebPage = tool({
  description:
    'Capture a screenshot of the page currently open in the background browser and return ' +
    'it as an image you can inspect. Only use this when the user explicitly asks for a ' +
    'screenshot or a visual look at the page, or when the page cannot be understood from ' +
    'its text (e.g. charts, diagrams, image-only or heavily visual layouts). For normal ' +
    'pages prefer browseWeb, which returns the readable text. Open a page with browseWeb ' +
    'or searchWeb first.',
  inputSchema: z.object({}),
  contextSchema: ToolConversationContextSchema,
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
      .describe('For "click"/"scroll": an optional CSS selector to target instead of a linkIndex.'),
  }),
  outputSchema: WebPageSnapshotSchema,
  contextSchema: ToolConversationContextSchema,
})
