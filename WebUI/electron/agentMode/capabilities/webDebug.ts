import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { runBrowserAction } from '../../subprocesses/agentBrowser.ts'
import {
  jsonSchemaParameters,
  sendToolImage,
  textResult,
  workspaceFileToDataUri,
  type SkillSource,
} from '../piCustomTools.ts'
import { resolvePreviewUrl } from '../piWorkspaceRuntime.ts'
import { loadPi } from '../piRuntime.ts'
import { appLoggerInstance } from '../../logging/logger.ts'
import type { AgentCapability, CapabilityHost } from './types.ts'

const logger = appLoggerInstance
const LOG_SOURCE = 'webDebugCapability'

// ── web-debug capability ─────────────────────────────────────────────────────
//
// One `browser` tool driving Electron's own bundled Chromium, instead of the 29
// schemas a browser MCP server would add, plus the skill that teaches the
// open → probe → fix → reload loop.
//
// `probe` is the play-test: it calls the script the preview server injects
// (agentMode/previewProbe.ts) and reports what it found as text. It exists
// because the alternative — screenshot, then look at it — asks a mid-size model
// to judge a picture, at an image decode per check.

const BROWSER_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['open', 'console', 'eval', 'probe', 'screenshot'],
      description:
        'open: navigate to `url` (clears previous logs); console: read console ' +
        'messages and uncaught errors since the last open; eval: run `script` in the ' +
        'page and return its result; probe: play-test the page and report errors, ' +
        'whether the animation loop runs, whether the canvas is drawn on and whether ' +
        'it reacts to keys; screenshot: save a PNG of the page into the workspace and ' +
        'return its path (for the user to look at — do not read it back).',
    },
    url: {
      type: 'string',
      description:
        'Page to open (action=open): either a workspace-relative path like "index.html" ' +
        '(resolved against the workspace preview server) or a full http URL.',
    },
    script: { type: 'string', description: 'JavaScript to evaluate (action=eval).' },
  },
  required: ['action'],
}

const BROWSER_DEBUGGING_SKILL: SkillSource = {
  name: 'browser-debugging',
  description:
    'Preview and debug a web page you built in the workspace: open it, probe it for errors ' +
    'and signs of life, fix the file, reload.',
  body: [
    'Your workspace is already served over HTTP by the app; the browser tool resolves a bare',
    'file name against that server, so you never need a port and never a file:// path. A',
    'connection error means you used a stale URL — retry with just the file name.',
    '',
    "Use the `browser` tool (it drives the app's built-in Chromium):",
    '1. browser {"action":"open","url":"index.html"} — navigate; clears old logs. The reply',
    '   says how many errors the page has already thrown.',
    '2. browser {"action":"probe"} — the play-test. One call reports uncaught errors, whether',
    '   an animation loop is running, how much of the canvas is actually drawn on, which input',
    '   events the page listens for, what pressing a key changes, and `window.__game` when the',
    '   page exposes it. It ends with a verdict naming the one thing to fix next.',
    '3. browser {"action":"console"} — the raw log, when the probe\'s first few errors are not',
    '   enough.',
    '4. Edit the workspace file (relative path, e.g. "game.js") to fix the root cause, then',
    '   open + probe again. Repeat until the verdict is clean.',
    '5. browser {"action":"eval","script":"document.title"} — run JS to inspect page state;',
    '   either an expression or statements ending in `return`. A script that throws comes back',
    '   with its own error message, so read that instead of guessing another script.',
    '6. browser {"action":"screenshot"} — save a PNG into the workspace and get its path. It is',
    '   shown to the user; do NOT read it back as an image, the probe already told you what is',
    '   on the page in words.',
  ].join('\n'),
}

async function buildBrowserTool(host: CapabilityHost): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  return [
    pi.defineTool({
      name: 'browser',
      label: 'browser',
      description:
        "Drive a headless browser (the app's built-in Chromium) to preview and debug web " +
        'pages you created in the workspace. Open pages via the workspace HTTP preview URL ' +
        '(from your instructions), never file:// paths.',
      parameters: jsonSchemaParameters(BROWSER_INPUT_SCHEMA),
      execute: async (toolCallId, params) => {
        const action = params as Parameters<typeof runBrowserAction>[2]
        const url = resolvePreviewUrl(action.url)
        const result = await runBrowserAction(host.sessionId, host.workspaceDir, { ...action, url })
        // The model gets the path (an inlined PNG would swamp its context); the
        // user gets to see what the agent saw.
        if (result.screenshotPath) {
          try {
            sendToolImage(
              toolCallId,
              workspaceFileToDataUri(host.workspaceDir, result.screenshotPath),
              result.screenshotPath,
            )
          } catch (error) {
            logger.warn(`could not show screenshot in chat: ${error}`, LOG_SOURCE)
          }
        }
        return textResult(result.text)
      },
    }) as ToolDefinition,
  ]
}

export const webDebugCapability: AgentCapability = {
  id: 'web-debug',
  label: 'Web debugging',
  summary:
    'Open pages from the workspace in a real browser, play-test them and read their console ' +
    'output to debug them.',
  skills: [BROWSER_DEBUGGING_SKILL],
  buildTools: buildBrowserTool,
  lazyEligible: true,
}
