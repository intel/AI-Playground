import path from 'node:path'
import fs from 'node:fs'
import type { AgentSession, ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { appLoggerInstance } from '../logging/logger.ts'
import { loadPi } from './piRuntime.ts'
import {
  buildSkillsPromptSection,
  rejectAllPendingToolCalls,
  writeAgentSkills,
} from './piCustomTools.ts'
import { resolveCapabilities, type CapabilityHost } from './capabilities/index.ts'
import { enabledCapabilityIds } from '@/types/agentCapabilities'
import { createAgentToolAccess } from './piToolOperations.ts'
import { buildWorkspaceInstructions, ensureWorkspaceRuntime } from './piWorkspaceRuntime.ts'
import { createSamplingExtension } from './piSampling.ts'
import { laminarPiExtensionPath } from '../laminar.ts'
import { withLiveEndpoint } from './piLocalEndpoint.ts'
import {
  clearAgentRunIdentity,
  clearAgentTraceContext,
  setAgentTraceContext,
} from '../laminarAttributes.ts'
import type { AgentModeModelConfig, AgentModeTurnConfig } from '@/types/agentIpc'
import { piAgentDir, piSessionDir, loadSessionFilePath, savePointer } from './piSessionStore.ts'
import { compactionSettingsForWindow } from './piCompaction.ts'
import {
  copySamplingParams,
  ensureModelRuntime,
  modelContextWindow,
  registerModel,
  traceContext,
} from './piModelRuntime.ts'
import { briefly, LOG_SOURCE } from './piAgentLog.ts'
import {
  active,
  currentTurn,
  setActive,
  setLastSessionId,
  type ActiveSession,
} from './piAgentState.ts'

const logger = appLoggerInstance

function configKeyOf(config: AgentModeTurnConfig): string {
  // The tool set is fixed at session construction, so a changed tool set needs a
  // rebuild — including the enabled capabilities, which decide what tools,
  // skills and extensions the session gets. The session id is part of the key
  // too: switching conversations in the renderer must rebuild even when
  // everything else matches.
  return JSON.stringify([
    config.sessionId,
    config.workspaceDir,
    modelKeyOf(config.modelConfig),
    config.toolSpecs ?? [],
    // Part of the system prompt, which is fixed once the session exists: editing
    // the preset's instructions (or switching preset) has to rebuild.
    config.instructions ?? '',
    enabledCapabilityIds(config),
    config.unsandboxed ?? false,
    config.planningThinkingOnly ?? false,
  ])
}

/**
 * The model half of that key, minus the local endpoint: the port a backend
 * listens on moves whenever its server is relaunched, and the session dials
 * whichever one is current per request (`withLiveEndpoint`). A moved port is
 * not a different model, so it must not throw away a live session.
 */
function modelKeyOf(config: AgentModeModelConfig): unknown {
  if (config.source !== 'local') return config
  const { baseUrl: _endpoint, ...rest } = config
  return rest
}

export async function endActiveSession(): Promise<void> {
  const current = active
  setActive(null)
  clearAgentTraceContext()
  clearAgentRunIdentity()
  rejectAllPendingToolCalls('Agent session ended.')
  if (!current) return
  current.unsubscribe()
  await shutdownSessionExtensions(current.session)
  try {
    current.session.dispose()
  } catch (error) {
    logger.warn(`failed to dispose agent session: ${error}`, LOG_SOURCE)
  }
  await current.access.dispose()
}

/**
 * Give extensions their `session_shutdown` before the session goes away. Pi's own
 * front-ends do this from `AgentSessionRuntime.dispose()`, which we do not use
 * (we own the session directly), and `AgentSession.dispose()` alone does not
 * emit it — without this, persistent memory would never flush what it learned
 * and its SQLite handle would be left behind.
 */
async function shutdownSessionExtensions(session: AgentSession): Promise<void> {
  try {
    if (!session.extensionRunner.hasHandlers('session_shutdown')) return
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
  } catch (error) {
    logger.warn(`extension shutdown failed: ${briefly(error)}`, LOG_SOURCE)
  }
}

async function createSession(config: AgentModeTurnConfig): Promise<ActiveSession> {
  if (!fs.existsSync(config.workspaceDir) || !fs.statSync(config.workspaceDir).isDirectory()) {
    throw new Error(`Workspace folder does not exist: ${config.workspaceDir}`)
  }
  // Resolve symlinks (e.g. macOS /tmp -> /private/tmp): the sandbox's ReadWriteFs
  // rejects paths whose realpath escapes its root.
  const workspaceDir = fs.realpathSync(path.resolve(config.workspaceDir))
  const sessionId = config.sessionId
  const unsandboxed = config.unsandboxed === true
  setLastSessionId(sessionId)

  const pi = await loadPi()
  const { provider, modelId } = await registerModel(config.modelConfig)
  const models = await ensureModelRuntime()
  const registered = models.getModel(provider, modelId)
  if (!registered) {
    throw new Error(`Model '${modelId}' could not be registered with Pi.`)
  }
  // The sampling for every request of this session. Pi's agent path reads no
  // sampling from the model, so it is merged into each request body by the
  // extension in piSampling.ts, which reads this bag live. It is copied because
  // the planning phase mutates it (planningPhase.ts) and the turn config it came
  // from is what session reuse is keyed on.
  const samplingParams =
    config.modelConfig.source === 'local'
      ? copySamplingParams(config.modelConfig.samplingParams, config.modelConfig.backend)
      : undefined
  setAgentTraceContext(traceContext(config.modelConfig, () => samplingParams))
  // The model still carries it as well, since that is where pi-ai's own request
  // builders would look if the agent path ever grew support for it.
  const withSampling = samplingParams ? { ...registered, samplingParams } : registered
  const model =
    config.modelConfig.source === 'local'
      ? withLiveEndpoint(withSampling, config.modelConfig)
      : withSampling

  // Everything optional the agent can do is a capability the user enabled for
  // this session (capabilities/index.ts): its tools, skills and Pi extensions.
  const capabilityHost: CapabilityHost = {
    sessionId,
    workspaceDir,
    toolSpecs: config.toolSpecs ?? [],
    agentDir: piAgentDir(),
    contextWindow: config.modelConfig.contextWindow,
  }
  const capabilities = await resolveCapabilities(capabilityHost, enabledCapabilityIds(config))
  logger.info(
    `capabilities: ${capabilities.resolved.map(({ capability }) => capability.id).join(', ') || 'none'}` +
      (capabilities.dormantIds.length > 0
        ? ` (dormant: ${capabilities.dormantIds.join(', ')})`
        : ''),
    LOG_SOURCE,
  )

  // Skills are progressive disclosure: only name + description sit in the system
  // prompt until the model reads one, so a capability's workflow instructions
  // cost almost nothing per step.
  const skillsDir = path.join(piAgentDir(), 'skills')
  const skills = writeAgentSkills(skillsDir, capabilities.skillSources)

  const access = await createAgentToolAccess({
    workspaceDir,
    unsandboxed,
    skillsDir,
    skills,
    ...(capabilities.ownSession
      ? {
          baseTools: capabilities.ownSession.baseTools,
          ...(capabilities.ownSession.writableFiles
            ? { writableFiles: capabilities.ownSession.writableFiles }
            : {}),
        }
      : {}),
  })

  // Serve the workspace over localhost so the agent can preview/debug pages over
  // HTTP instead of file://. The runtime is keyed by session so the port stays
  // stable for the whole conversation.
  const runtime = await ensureWorkspaceRuntime(sessionId, workspaceDir)

  const instructions = buildWorkspaceInstructions({
    cwd: access.cwd,
    workspaceDir,
    baseUrl: runtime.baseUrl,
    unsandboxed,
  })

  const sessionFilePath = loadSessionFilePath(sessionId, workspaceDir)
  const sessionManager = sessionFilePath
    ? pi.SessionManager.open(sessionFilePath, piSessionDir(), access.cwd)
    : pi.SessionManager.create(access.cwd, piSessionDir())
  if (sessionFilePath) {
    logger.info(`resumed Pi session ${sessionId} (${workspaceDir})`, LOG_SOURCE)
  }

  const announcedSkills = skills.filter((skill) =>
    capabilities.announcedSkillNames.includes(skill.name),
  )
  // A capability that owns the session speaks for the whole prompt: Pi's
  // coding-agent instructions, the workspace orientation, the skills index and
  // any AGENTS.md are replaced by the preset's own text, which is the point of
  // such a session. The orientation is the fallback for a preset whose
  // instructions the user emptied, so the prompt is never blank.
  const ownPrompt = capabilities.ownSession
    ? (config.instructions ?? '').trim() || instructions
    : undefined
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir: piAgentDir(),
    // `noExtensions` only suppresses auto-discovery of the user's own extensions;
    // the capability factories and bundled package paths below still load. No
    // themes or prompt templates in the host app, and no skill loading either:
    // Pi would advertise the skills at their host path, which the sandboxed read
    // tool cannot open. They are announced below with a location that matches
    // the active mode instead.
    noExtensions: true,
    noThemes: true,
    noPromptTemplates: true,
    noSkills: true,
    // `noSkills` only stops path discovery: an extension can still contribute
    // skill directories through `resources_discover` (persistent memory
    // contributes the ones it wrote itself), and Pi would then announce them at
    // their host path. Those skills reach the model through the capability's
    // `buildSkills` instead, so Pi's own skill list stays empty in every mode.
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    extensionFactories: [
      ...capabilities.extensionFactories,
      // Pi's agent path ignores `Model.samplingParams`, so the turn's sampling
      // is merged into each request here instead (piSampling.ts).
      createSamplingExtension(() => samplingParams),
    ],
    // Laminar's own Pi extension traces the run (one trace per agent run, LLM
    // and tool spans). Nothing when no developer opted into tracing, and never
    // a capability: it is not something the user picks per session.
    additionalExtensionPaths: [
      ...capabilities.extensionPaths,
      ...[laminarPiExtensionPath()].filter((entry): entry is string => entry !== undefined),
    ],
    ...(ownPrompt
      ? {
          systemPromptOverride: () => ownPrompt,
          appendSystemPromptOverride: () => [],
          noContextFiles: true,
        }
      : {}),
    // The workspace orientation the model would otherwise have to guess. Built
    // fresh on every session build, so it always carries the live preview URL.
    appendSystemPrompt: [
      instructions,
      // The preset's own instructions come last so they read as the task the app
      // was opened for, after the environment it is working in.
      buildSkillsPromptSection(announcedSkills, access.skillsRoot),
      capabilities.dormantPromptSection,
      (config.instructions ?? '').trim(),
    ].filter((section) => section !== ''),
  })
  await resourceLoader.reload()

  const { session } = await pi.createAgentSession({
    cwd: access.cwd,
    agentDir: piAgentDir(),
    model,
    modelRuntime: models,
    sessionManager,
    // Pi's 16k/20k compaction defaults overflow a 32k window (keep already
    // exceeds the trigger). Scale both to the live window so compact frees n_ctx.
    settingsManager: pi.SettingsManager.inMemory({
      compaction: compactionSettingsForWindow(modelContextWindow(config.modelConfig)),
    }),
    // Pi's own file/shell tools are replaced by the mode-specific ones built in
    // piToolOperations.ts, so its builtins are switched off entirely. Capability
    // tools arrive through their extensions, not here.
    noTools: 'builtin',
    customTools: access.definitions,
    resourceLoader,
  })

  // createAgentSession loads extensions but does not start them: `session_start`
  // and `resources_discover` only fire from bindExtensions, and third-party
  // extensions (persistent memory) do all their work there.
  await bindSessionExtensions(session)
  hideDormantTools(session, capabilities.dormantToolNames)

  const unsubscribe = session.subscribe((event) => currentTurn?.onEvent(event))
  savePointer({
    sessionId,
    workspaceDir,
    sessionFilePath: session.getSessionStats().sessionFile ?? '',
    updatedAt: Date.now(),
  })

  return {
    configKey: configKeyOf(config),
    sessionId,
    workspaceDir,
    session,
    access,
    instructedBaseUrl: runtime.baseUrl,
    unsubscribe,
    samplingParams,
    // Whether thinking stops early is the user's setting; what counts as the end
    // of planning belongs to the capability running the session.
    planningEnd: config.planningThinkingOnly === true ? (capabilities.planningEnd ?? null) : null,
    planHandoff: capabilities.planHandoff ?? null,
    // Splitting the turn is the capability's shape, not the user's setting, so it
    // happens whether or not thinking stops early — but only on a session that
    // starts empty. A resumed one is past the point where a plan is what is
    // wanted, and the request it reopens with is a change to a finished game.
    planPending: Boolean(capabilities.planHandoff) && !sessionFilePath,
  }
}

/**
 * Start the session's extensions. Pi's own front-ends do this after building a
 * session; the bindings are what an extension's `ctx` can reach, so the ones
 * that make no sense without a terminal UI (forking, session switching, tree
 * navigation) are refused with a clear message instead of pretending to work.
 */
async function bindSessionExtensions(session: AgentSession): Promise<void> {
  const unsupported = (action: string) => async () => {
    throw new Error(`'${action}' is not available in AI Playground's agent mode.`)
  }
  await session.bindExtensions({
    // Not an interactive terminal: no UI prompts, and output is a message
    // stream the renderer consumes.
    mode: 'rpc',
    uiContext: extensionUiContext(),
    commandContextActions: {
      waitForIdle: () => session.agent.waitForIdle(),
      reload: () => session.reload(),
      newSession: unsupported('new session'),
      fork: unsupported('fork'),
      navigateTree: unsupported('navigate tree'),
      switchSession: unsupported('switch session'),
    },
    abortHandler: () => session.abort(),
    shutdownHandler: async () => {
      logger.info('extension requested shutdown; ending the agent session', LOG_SOURCE)
      await endActiveSession()
    },
    onError: (error) => logger.warn(`extension error: ${briefly(error)}`, LOG_SOURCE),
  })
}

/**
 * What an extension's `ctx.ui` can do here. Pi's default in `rpc` mode is a
 * silent no-op, which would swallow the output of every slash command (memory's
 * `/memory-insights` writes its whole report through `notify`), so notifications
 * are routed into the running turn's transcript instead. Everything interactive
 * stays unavailable — there is no terminal to prompt in, and an extension asking
 * for input must fall back rather than hang.
 */
function extensionUiContext(): ExtensionUIContext {
  const surface = (message: string, type?: 'info' | 'warning' | 'error') => {
    if (type === 'error') logger.warn(`extension notice: ${briefly(message)}`, LOG_SOURCE)
    else logger.info(`extension notice: ${briefly(message)}`, LOG_SOURCE)
    currentTurn?.notice?.(message)
  }
  const context = {
    notify: surface,
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    custom: async () => undefined,
    onTerminalInput: () => () => {},
    setStatus: (_key: string, text: string | undefined) => {
      if (text) surface(text)
    },
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => '',
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'Agent mode has no theme support.' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  }
  // The TUI-only members (`theme`, component factories) have no meaning outside
  // a terminal; the cast keeps the stub to what an extension can usefully call.
  return context as unknown as ExtensionUIContext
}

/**
 * Hide the tools of capabilities that start dormant. Everything Pi registered is
 * active by default, which is the fast path, so this narrows rather than pins the
 * set — tools a third-party extension registered for itself stay untouched.
 */
function hideDormantTools(session: AgentSession, dormantToolNames: string[]): void {
  if (dormantToolNames.length === 0) return
  const dormant = new Set(dormantToolNames)
  session.setActiveToolsByName(session.getActiveToolNames().filter((name) => !dormant.has(name)))
}

export async function ensureSession(config: AgentModeTurnConfig): Promise<ActiveSession> {
  const configKey = configKeyOf(config)
  if (active && active.configKey === configKey) {
    await reassertPreviewUrl(active)
    return active
  }
  await endActiveSession()
  const next = await createSession(config)
  setActive(next)
  return next
}

/**
 * The preview port is allocated per app launch, so a session built before a
 * restart of the preview server carries a dead URL in its system prompt. Tell
 * the model about the new one instead of letting it conclude it must start its
 * own server.
 */
async function reassertPreviewUrl(current: ActiveSession): Promise<void> {
  const runtime = await ensureWorkspaceRuntime(current.sessionId, current.workspaceDir)
  if (runtime.baseUrl === current.instructedBaseUrl) return
  current.instructedBaseUrl = runtime.baseUrl
  if (!runtime.baseUrl) return
  try {
    await current.session.sendCustomMessage(
      {
        customType: 'workspace-preview',
        content:
          `The workspace preview server now runs at ${runtime.baseUrl}. Use this base URL ` +
          '(or just a bare file name) from now on; earlier URLs in this conversation are dead.',
        display: false,
      },
      { deliverAs: 'nextTurn' },
    )
  } catch (error) {
    logger.warn(`failed to re-assert preview URL: ${error}`, LOG_SOURCE)
  }
}
