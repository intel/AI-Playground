/**
 * Pi integration smoke test — run after bumping `@earendil-works/pi-coding-agent`
 * or `pi-hermes-memory`:
 *
 *   cd WebUI && node --experimental-strip-types scripts/verify/piIntegration.mts
 *
 * Builds a session the way piAgentManager.createSession does (runtime-registered
 * provider, inline capability extension, bundled memory extension, bindExtensions,
 * dormant-tool narrowing) and asserts the pieces the app depends on: session_start
 * fires, capability and extension tools register, narrowing the active set works,
 * appended prompt text survives, and the memory extension's tools, commands and
 * SQLite store come up against the config the app writes.
 *
 * No model is called: the provider points at a dead port on purpose, so this runs
 * anywhere in a couple of seconds. It runs on Node, not Electron, so it does NOT
 * prove better-sqlite3 is built for Electron's ABI — that needs the packaged app.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const HERMES_ENTRY = 'pi-hermes-memory/src/index.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-pi-verify-'))
const workspaceDir = path.join(root, 'workspace')
const agentDir = path.join(root, 'agent')
fs.mkdirSync(workspaceDir, { recursive: true })
fs.mkdirSync(agentDir, { recursive: true })

// Mirrors capabilities/memory.ts: the extension resolves its root from this env
// var once, at import time, and reads this config file on load.
process.env.PI_CODING_AGENT_DIR = agentDir
const memoryDir = path.join(agentDir, 'pi-hermes-memory')
fs.mkdirSync(memoryDir, { recursive: true })
fs.writeFileSync(
  path.join(agentDir, 'hermes-memory-config.json'),
  JSON.stringify({ memoryDir, reviewTransport: 'direct', memoryMode: 'policy-only' }, null, 2),
)

// fileURLToPath, not URL.pathname: on Windows the latter yields a leading-slash
// '/C:/...' that path.normalize turns into the non-existent '\C:\...'.
const hermesEntry = import.meta.resolve ? fileURLToPath(import.meta.resolve(HERMES_ENTRY)) : ''
if (!fs.existsSync(hermesEntry)) throw new Error(`cannot resolve ${HERMES_ENTRY}`)

const models = await ModelRuntime.create({
  authPath: path.join(agentDir, 'auth.json'),
  modelsPath: null,
})
models.registerProvider('verify', {
  name: 'verify',
  baseUrl: 'http://127.0.0.1:1/v1',
  api: 'openai-completions',
  apiKey: 'unused',
  models: [
    {
      id: 'verify-model',
      name: 'verify-model',
      reasoning: false,
      input: ['text'],
      contextWindow: 8192,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
})
await models.setRuntimeApiKey('verify', 'unused')
const model = models.getModel('verify', 'verify-model')
if (!model) throw new Error('model registration failed')

const mediaTool = defineTool({
  name: 'media',
  label: 'media',
  description: 'generate media',
  parameters: Type.Object({ prompt: Type.String() }),
  execute: async () => ({ output: [{ type: 'text' as const, text: 'ok' }], isError: false }),
})

let sessionStarted = false
const resourceLoader = new DefaultResourceLoader({
  cwd: workspaceDir,
  agentDir,
  noExtensions: true,
  noThemes: true,
  noPromptTemplates: true,
  noSkills: true,
  skillsOverride: () => ({ skills: [], diagnostics: [] }),
  extensionFactories: [
    (pi) => {
      pi.registerTool(mediaTool)
      pi.on('session_start', () => {
        sessionStarted = true
      })
    },
  ],
  additionalExtensionPaths: [hermesEntry],
  appendSystemPrompt: ['workspace instructions from the app'],
})
await resourceLoader.reload()

const { session, extensionsResult } = await createAgentSession({
  cwd: workspaceDir,
  agentDir,
  model,
  modelRuntime: models,
  sessionManager: SessionManager.inMemory(workspaceDir),
  settingsManager: SettingsManager.inMemory(),
  noTools: 'builtin',
  customTools: [],
  resourceLoader,
})

const notices: string[] = []
await session.bindExtensions({
  mode: 'rpc',
  uiContext: { notify: (message: string) => notices.push(message) } as never,
  commandContextActions: {
    waitForIdle: () => session.agent.waitForIdle(),
    reload: () => session.reload(),
    newSession: async () => {},
    fork: async () => {},
    navigateTree: async () => {},
    switchSession: async () => {},
  },
  abortHandler: () => session.abort(),
  shutdownHandler: async () => {},
  onError: (error: unknown) => console.error('extension error:', error),
})

const registered = session.getAllTools().map((tool: { name: string }) => tool.name)
const activeBefore = session.getActiveToolNames()
session.setActiveToolsByName(activeBefore.filter((name) => name !== 'media'))
const activeAfter = session.getActiveToolNames()

// The memory extension answers its slash commands through prompt(), which is how
// the app's capability-command buttons reach it.
await session.prompt('/memory-insights')

const report = {
  sessionStarted,
  extensionErrors: extensionsResult.errors,
  registeredTools: registered,
  memoryToolsPresent: registered.some((name) => name.startsWith('memory')),
  activeBefore,
  activeAfter,
  promptHasAppendedText: session.agent.state.systemPrompt.includes(
    'workspace instructions from the app',
  ),
  promptHasMemoryPolicy: /memory/i.test(session.agent.state.systemPrompt),
  noticeCount: notices.length,
  noticePreview: notices[0]?.split('\n').slice(0, 4).join(' | '),
  sqliteFiles: fs.readdirSync(memoryDir),
}
console.log(JSON.stringify(report, null, 2))

const failures: string[] = []
if (!report.sessionStarted) failures.push('session_start did not fire')
if (report.extensionErrors.length > 0) failures.push('extension load errors')
if (!report.memoryToolsPresent) failures.push('memory tools missing')
if (report.activeAfter.includes('media')) failures.push('tool narrowing had no effect')
if (!report.promptHasAppendedText) failures.push('appended system prompt missing')
if (report.noticeCount === 0) failures.push('slash command produced no output')

await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
session.dispose()
fs.rmSync(root, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('OK')
