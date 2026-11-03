import {
  computed,
  effectScope,
  getCurrentScope,
  markRaw,
  ref,
  shallowRef,
  watch,
  type Ref,
} from 'vue'
import { Chat } from '@ai-sdk/vue'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import { chatTemplateKwargs } from '@/lib/samplingDefaults'
import { openAiApiBase } from '@/lib/inferenceApiBase'
import { HYBRID_CLOUD_NAME } from '@/lib/cloudModeName'
import type { ReasoningEffort } from '@/types/shared'
import { extractMessage } from '../errors/appError'
import { getAgentToolSpecs } from '../tools/agentBridge'
import { useDeveloperSettings } from './developerSettings'
import { registerAgentModeIpc } from './agentModeIpc'
import { CLOUD_DEFAULT_MODEL } from './cloudMode'
import type { AgentAnswerOrigin, AgentModeTurnConfig } from '@/types/agentIpc'
import type { CloudForTurn, InferenceForTurn, ToolsForTurn } from '@/lib/storedSessionInference'
import type { AgentTurnSnapshot, AgentTurnState, PauseReason } from '@/types/kernelEvents'

type ActiveTurn = {
  sessionId: string
  turnId: string
  controller: ReadableStreamDefaultController<UIMessageChunk>
  closed: boolean
}

/** Start with the LLM only once the file is on disk, so a missing model still opens the download dialog. */
function readinessEmbeddingModel(
  textInference: InferenceForTurn,
  capabilities: readonly string[],
): string | undefined {
  if (!capabilities.includes('rag')) return undefined
  const name = textInference.activeEmbeddingModel
  if (!name) return undefined
  const downloaded = textInference.llmEmbeddingModels?.some(
    (model) =>
      model.name === name && model.type === textInference.embeddingBackend && model.downloaded,
  )
  return downloaded ? name : undefined
}

/** A user message as the agent receives it: its text parts, joined. */
export function userMessagePrompt(message: UIMessage | undefined): string {
  return (
    message?.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n\n') ?? ''
  )
}

export function buildSamplingParams(textInference: InferenceForTurn): Record<string, unknown> {
  const params: Record<string, unknown> = {
    ...textInference.samplingRequestBody,
    temperature: textInference.temperature,
  }
  const kwargs = chatTemplateKwargs({
    supportsThinkingToggle: textInference.modelSupportsThinkingToggle,
    thinkingEnabled: textInference.thinkingEnabled,
    thinkingActive: textInference.thinkingActive,
    reasoningEffort: textInference.effectiveReasoningEffort as ReasoningEffort | undefined,
  })
  if (Object.keys(kwargs).length > 0) params.chat_template_kwargs = kwargs
  return params
}

function embeddingConfigOf(textInference: InferenceForTurn) {
  const embeddingModel = textInference.activeEmbeddingModel ?? undefined
  // Only meaningful with a model; in Cloud Mode `embeddingBackend` already
  // resolves to a local backend that can serve embeddings.
  return embeddingModel ? { embeddingModel, embeddingBackend: textInference.embeddingBackend } : {}
}

export async function buildTurnConfig(options: {
  sessionId: string
  /** The Session a Harness Session belongs to. */
  sessionRef?: string
  /** A Task Run's Step: main gives it no Session Update and no `session_history`. */
  taskRun?: AgentModeTurnConfig['taskRun']
  workspaceDir: string
  presetName: string
  instructions: string
  capabilities: string[]
  unsandboxed: boolean
  planningThinkingOnly: boolean
  textInference: InferenceForTurn
  cloudMode: CloudForTurn
  /** Tool toggles stored on the session; the live ones when absent. */
  tools?: ToolsForTurn
  answer?: AgentAnswerOrigin
}): Promise<AgentModeTurnConfig> {
  const toolSpecs = getAgentToolSpecs(options.tools)
  const mediaAgent = toolSpecs.some((spec) => spec.name === 'media')
    ? (await import('../agents/mediaAgent')).serializeMediaAgentInner()
    : undefined
  const { textInference, cloudMode } = options
  if (textInference.backend === 'cloud') {
    const upstreamBaseUrl = cloudMode.activeProviderBaseUrl
    if (!upstreamBaseUrl) {
      throw new Error(
        `${HYBRID_CLOUD_NAME} has no provider base URL configured. Set one up in its setup screen.`,
      )
    }
    const model = textInference.activeModel ?? CLOUD_DEFAULT_MODEL
    return {
      sessionId: options.sessionId,
      ...(options.sessionRef ? { sessionRef: options.sessionRef } : {}),
      ...(options.taskRun ? { taskRun: options.taskRun } : {}),
      workspaceDir: options.workspaceDir,
      modelConfig: {
        source: 'cloud',
        model,
        upstreamBaseUrl,
        providerId: cloudMode.selectedProviderId,
        authStyle: cloudMode.activeProviderAuthStyle,
        supportsVision: textInference.modelSupportsVision,
        reasoningAdvertised: cloudMode.capabilitiesFor(model).reasoningAdvertised,
        contextWindow: textInference.maxContextSizeFromModel
          ? textInference.effectiveContextWindow
          : undefined,
      },
      toolSpecs,
      mediaAgent,
      presetName: options.presetName,
      instructions: options.instructions,
      capabilities: options.capabilities,
      unsandboxed: options.unsandboxed,
      keepModelsLoaded: useDeveloperSettings().keepModelsLoaded,
      ...(options.answer ? { answer: options.answer } : {}),
      ...embeddingConfigOf(textInference),
    }
  }
  const servedModelId = textInference.activeModel?.split('/').join('---') ?? ''
  const baseUrl = textInference.localBackendUrl
  if (!baseUrl) {
    throw new Error(
      'No local inference backend is available. Pick a local backend and model in the settings sidebar.',
    )
  }
  const activeModel = textInference.activeModel
  const embeddingModelName = readinessEmbeddingModel(textInference, options.capabilities)
  return {
    sessionId: options.sessionId,
    ...(options.sessionRef ? { sessionRef: options.sessionRef } : {}),
    ...(options.taskRun ? { taskRun: options.taskRun } : {}),
    workspaceDir: options.workspaceDir,
    modelConfig: {
      source: 'local',
      model: servedModelId,
      backend: textInference.backend as 'llamaCPP' | 'openVINO',
      device: textInference.getCurrentDeviceId() ?? undefined,
      deviceName: textInference.getCurrentDeviceName() ?? undefined,
      baseUrl: openAiApiBase(baseUrl),
      contextWindow: textInference.effectiveContextWindow,
      supportsVision: textInference.modelSupportsVision,
      samplingParams: buildSamplingParams(textInference),
    },
    toolSpecs,
    mediaAgent,
    presetName: options.presetName,
    instructions: options.instructions,
    capabilities: options.capabilities,
    unsandboxed: options.unsandboxed,
    keepModelsLoaded: useDeveloperSettings().keepModelsLoaded,
    ...(options.answer ? { answer: options.answer } : {}),
    planningThinkingOnly:
      textInference.modelSupportsThinkingToggle &&
      textInference.thinkingEnabled &&
      options.planningThinkingOnly,
    ...embeddingConfigOf(textInference),
    ...(activeModel
      ? {
          readiness: {
            serviceName:
              textInference.backend === 'openVINO' ? 'openvino-backend' : 'llamacpp-backend',
            llmModelName: activeModel,
            contextSize: textInference.contextSize,
            modelArgs:
              textInference.backend === 'llamaCPP'
                ? textInference.activeLlmModel?.llamaCppArgs
                : undefined,
            ...(embeddingModelName ? { embeddingModelName } : {}),
          },
        }
      : {}),
  }
}

export type TurnMetadata = {
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    costUsd?: number
  }
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }
  lastStep?: { inputTokens: number; outputTokens: number; cacheReadTokens: number }
}

export function latestTurnMetadata<K extends keyof TurnMetadata>(
  messages: UIMessage[],
  key: K,
): TurnMetadata[K] {
  const latest = [...messages]
    .reverse()
    .find((m) => (m.metadata as TurnMetadata | undefined)?.[key])
  return (latest?.metadata as TurnMetadata | undefined)?.[key]
}

type StoreTool = (input: Record<string, unknown>, sessionId: string) => Promise<unknown>

type ErrorSink = { report: (error: unknown, overrides: Record<string, unknown>) => void }

/** The turn machinery of one Agent Session: what Agent Mode renders while that session is open. */
export type AgentSessionRuntime = {
  sessionId: string
  chat: Chat<UIMessage>
  processing: Ref<boolean>
  /** Where the session's turn stands in the Turn Queue; null while it has none. */
  turnState: Ref<AgentTurnState | null>
  /** 1-based place in the Turn Queue while queued; null when unknown or not waiting. */
  queuePosition: Ref<number | null>
  /** What the user is asked while paused; null otherwise. */
  pauseReason: Ref<PauseReason | null>
  toolProgress: Ref<Record<string, string>>
  toolImages: Ref<Record<string, AgentToolImage[]>>
  /** A turn streams into this runtime, or waits to be adopted from the kernel snapshot. */
  hasTurn: () => boolean
  /** Cancel the turn this runtime streams, or whatever main holds open for the session. */
  cancel: () => Promise<void>
}

type SessionRuntime = AgentSessionRuntime & {
  onChunk: (turnId: string, chunk: unknown) => void
  onToolProgress: (turnId: string, toolCallId: string, text: string) => void
  onToolImage: (image: AgentToolImage) => void
  onTurnState: (turnId: string, state: AgentTurnState, pauseReason?: PauseReason) => void
  onTurnDone: (turnId: string) => void
  onQueuePosition: (turnId: string, position: number | undefined) => void
  resume: (turn: AgentTurnSnapshot) => void
  dispose: () => void
}

function createSessionRuntime(options: {
  sessionId: string
  errors: ErrorSink
  initialMessages: UIMessage[]
  finishedTurns: Set<string>
  buildTurnConfig: (sessionId: string) => Promise<AgentModeTurnConfig>
  onTurnSubmitted?: (sessionId: string) => void
  onTurnAdopted?: (sessionId: string) => void
  onTurnSettled?: (sessionId: string) => void
  onAdoptedTurnDone?: (sessionId: string) => void
  onTurnPaused?: (sessionId: string) => void
  quietTurnErrors?: (sessionId: string) => boolean
}): SessionRuntime {
  const { sessionId, finishedTurns } = options
  const scope = effectScope()
  const processing = ref(false)
  const turnState = ref<AgentTurnState | null>(null)
  const queuePosition = ref<number | null>(null)
  const pauseReason = ref<PauseReason | null>(null)
  const toolProgress = ref<Record<string, string>>({})
  const toolImages = ref<Record<string, AgentToolImage[]>>({})
  let activeTurn: ActiveTurn | null = null

  // Resume state: a renderer that (re)connects while main is mid-turn adopts
  // that turn from the kernel snapshot. `pendingResume` holds it between the
  // snapshot install and the transport's reconnectToStream, and buffers any
  // stream chunks that win that race. `adoptedTurnId` marks a turn whose
  // processing flag has no sendMessage finally to clear it; it clears once the
  // resumed stream has been consumed.
  let pendingResume: { turn: AgentTurnSnapshot; chunks: unknown[] } | null = null
  let adoptedTurnId: string | null = null

  const transport: ChatTransport<UIMessage> = {
    sendMessages: async ({ messages, abortSignal }) => {
      const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
      const prompt = userMessagePrompt(lastUserMessage)

      const turnId = crypto.randomUUID()
      // Frozen here: settings edited after Send apply to the next turn.
      const config = await options.buildTurnConfig(sessionId)

      return new ReadableStream<UIMessageChunk>({
        start: (controller) => {
          activeTurn = { sessionId, turnId, controller, closed: false }
          if (abortSignal?.aborted) {
            activeTurn = null
            controller.close()
            return
          }
          abortSignal?.addEventListener('abort', () => {
            window.electronAPI.agentMode.cancel(sessionId, turnId)
          })
          turnState.value = 'queued'
          options.onTurnSubmitted?.(sessionId)
          const fail = (errorText: string) => {
            if (activeTurn?.turnId !== turnId || activeTurn.closed) return
            activeTurn.closed = true
            try {
              controller.enqueue({ type: 'error', errorText })
              controller.close()
            } catch {
              // Stream already closed.
            }
            activeTurn = null
          }
          window.electronAPI.agentMode
            .startTurn(turnId, prompt, config)
            // A refused start emits no done event, so it would otherwise hang open.
            .then((result) => {
              if (!result.success) fail(result.error ?? 'The agent turn could not start.')
            })
            .catch((error) => fail(extractMessage(error)))
        },
        cancel: () => {
          if (activeTurn?.turnId === turnId) {
            activeTurn.closed = true
            activeTurn = null
          }
          window.electronAPI.agentMode.cancel(sessionId, turnId)
        },
      })
    },
    /**
     * A renderer that (re)connected while main was mid-turn: adopt the turn
     * the kernel snapshot named, replaying its accumulated chunks as this
     * stream's opening content. Fresh events (seq above the snapshot) then
     * append through the normal chunk handler.
     */
    reconnectToStream: async () => {
      const pending = pendingResume
      pendingResume = null
      if (!pending || finishedTurns.has(pending.turn.turnId)) return null
      const { turn } = pending
      options.onTurnAdopted?.(sessionId)
      processing.value = true
      adoptedTurnId = turn.turnId
      turnState.value = turn.state
      queuePosition.value = turn.state === 'queued' ? (turn.queuePosition ?? null) : null
      pauseReason.value = turn.state === 'paused' ? (turn.pauseReason ?? null) : null
      toolProgress.value = { ...turn.toolProgress }
      const restoredImages: Record<string, AgentToolImage[]> = {}
      for (const [toolCallId, images] of Object.entries(turn.toolImages)) {
        restoredImages[toolCallId] = [...images]
      }
      toolImages.value = restoredImages
      return new ReadableStream<UIMessageChunk>({
        start: (controller) => {
          activeTurn = { sessionId, turnId: turn.turnId, controller, closed: false }
          // Snapshot chunks first, then any that raced the adoption.
          for (const chunk of [...turn.chunks, ...pending.chunks]) {
            try {
              controller.enqueue(chunk as UIMessageChunk)
            } catch {
              break
            }
          }
        },
        cancel: () => {
          if (activeTurn?.turnId === turn.turnId) {
            activeTurn.closed = true
            activeTurn = null
          }
          window.electronAPI.agentMode.cancel(sessionId, turn.turnId)
        },
      })
    },
  }

  const chat = markRaw(
    new Chat<UIMessage>({
      transport,
      messages: options.initialMessages,
      onError: (error) => {
        options.errors.report(error, {
          category: 'inference',
          code: 'agent/turn-failed',
          userMessage: `Agent turn failed: ${extractMessage(error)}`,
          surface: options.quietTurnErrors?.(sessionId) ? 'silent' : 'toast',
        })
      },
    }),
  )

  scope.run(() => {
    watch(processing, (isProcessing, wasProcessing) => {
      if (isProcessing) return
      turnState.value = null
      queuePosition.value = null
      pauseReason.value = null
      if (wasProcessing) options.onTurnSettled?.(sessionId)
    })
  })

  function onChunk(turnId: string, chunk: unknown): void {
    if (pendingResume && pendingResume.turn.turnId === turnId) {
      pendingResume.chunks.push(chunk)
      return
    }
    if (!activeTurn || activeTurn.turnId !== turnId || activeTurn.closed) return
    try {
      activeTurn.controller.enqueue(chunk as UIMessageChunk)
    } catch {
      // Stream already closed (e.g. user aborted) — drop the chunk.
    }
  }

  function onToolProgress(turnId: string, toolCallId: string, text: string): void {
    if (pendingResume && pendingResume.turn.turnId === turnId) {
      pendingResume.turn.toolProgress = { ...pendingResume.turn.toolProgress, [toolCallId]: text }
      return
    }
    if (!activeTurn || activeTurn.turnId !== turnId) return
    toolProgress.value = { ...toolProgress.value, [toolCallId]: text }
  }

  function onToolImage(image: AgentToolImage): void {
    if (pendingResume && pendingResume.turn.turnId === image.turnId) {
      const pendingShown = pendingResume.turn.toolImages[image.toolCallId] ?? []
      pendingResume.turn.toolImages = {
        ...pendingResume.turn.toolImages,
        [image.toolCallId]: [...pendingShown, { type: 'agent-tool-image', ...image }],
      }
      return
    }
    if (!activeTurn || activeTurn.turnId !== image.turnId) return
    const shown = toolImages.value[image.toolCallId] ?? []
    toolImages.value = { ...toolImages.value, [image.toolCallId]: [...shown, image] }
  }

  function onTurnState(turnId: string, state: AgentTurnState, reason?: PauseReason): void {
    const reasonNow = state === 'paused' ? reason : undefined
    if (pendingResume && pendingResume.turn.turnId === turnId) {
      pendingResume.turn = { ...pendingResume.turn, state, pauseReason: reasonNow }
      return
    }
    if (!activeTurn || activeTurn.turnId !== turnId) return
    const was = turnState.value
    turnState.value = state
    pauseReason.value = reasonNow ?? null
    if (state !== 'queued') queuePosition.value = null
    if (state === 'paused' && was !== 'paused') options.onTurnPaused?.(sessionId)
  }

  function onQueuePosition(turnId: string, position: number | undefined): void {
    if (pendingResume && pendingResume.turn.turnId === turnId) {
      pendingResume.turn = { ...pendingResume.turn, queuePosition: position }
      return
    }
    if (!activeTurn || activeTurn.turnId !== turnId) return
    queuePosition.value = position ?? null
  }

  function onTurnDone(turnId: string): void {
    if (!activeTurn || activeTurn.turnId !== turnId || activeTurn.closed) return
    activeTurn.closed = true
    try {
      activeTurn.controller.close()
    } catch {
      // Already closed.
    }
    activeTurn = null
  }

  function resume(turn: AgentTurnSnapshot): void {
    // Only a runtime with no turn of its own resumes — a turn started here
    // since boot must not be displaced by a snapshot that predates it.
    if (activeTurn || pendingResume || finishedTurns.has(turn.turnId)) return
    pendingResume = { turn, chunks: [] }
    chat
      .resumeStream()
      .catch((error: unknown) => {
        if (pendingResume?.turn.turnId === turn.turnId) pendingResume = null
        if (adoptedTurnId === turn.turnId) {
          adoptedTurnId = null
          processing.value = false
        }
        options.errors.report(error, {
          category: 'inference',
          code: 'agent/resume-failed',
          userMessage: `Could not resume the interrupted agent turn: ${extractMessage(error)}`,
          surface: 'toast',
        })
      })
      .then(() => {
        // resumeStream resolved: whatever it did, a turn left pending was
        // never adopted (reconnectToStream consumed it or bailed).
        if (pendingResume?.turn.turnId === turn.turnId) pendingResume = null
        if (adoptedTurnId !== turn.turnId) return
        // The stream is fully consumed here, so the transcript is complete; it
        // is saved before the turn counts as settled.
        adoptedTurnId = null
        options.onAdoptedTurnDone?.(sessionId)
        processing.value = false
      })
  }

  async function cancel(): Promise<void> {
    if (activeTurn) {
      await window.electronAPI.agentMode.cancel(sessionId, activeTurn.turnId)
    } else if (sessionId) {
      await window.electronAPI.agentMode.cancel(sessionId)
    }
  }

  return markRaw({
    sessionId,
    chat,
    processing,
    turnState,
    queuePosition,
    pauseReason,
    toolProgress,
    toolImages,
    hasTurn: () => processing.value || activeTurn !== null || pendingResume !== null,
    cancel,
    onChunk,
    onToolProgress,
    onToolImage,
    onTurnState,
    onTurnDone,
    onQueuePosition,
    resume,
    dispose: () => scope.stop(),
  })
}

/**
 * One turn runtime per Agent Session, created on demand. Kernel agent events are
 * routed by the session id they carry, so a session's transcript, tool progress
 * and images only ever change for its own turns.
 */
export function createAgentTurnRuntimes(options: {
  errors: ErrorSink
  buildTurnConfig: (sessionId: string) => Promise<AgentModeTurnConfig>
  /** Tools the store implements itself (e.g. offer_game_agent); media tools execute in main. */
  storeTools?: Record<string, StoreTool>
  /** A turn was handed to main; its user message is in the runtime's transcript. */
  onTurnSubmitted?: (sessionId: string) => void
  /** A turn main still holds was adopted from the kernel snapshot. */
  onTurnAdopted?: (sessionId: string) => void
  /** The transcript a newly created runtime starts from (the session record's). */
  initialMessages?: (sessionId: string) => UIMessage[]
  /** A session's turn has ended — completed, failed, stopped or adopted-and-done. */
  onTurnSettled?: (sessionId: string) => void
  /** A turn adopted from the kernel snapshot ended; nothing else saves its transcript. */
  onAdoptedTurnDone?: (sessionId: string) => void
  /** A session's running turn started waiting on the user. */
  onTurnPaused?: (sessionId: string) => void
  /** A failed turn whose caller records the failure itself is not toasted. */
  quietTurnErrors?: (sessionId: string) => boolean
}) {
  const runtimes = shallowRef<Record<string, SessionRuntime>>({})
  const runningTools = new Map<string, { sessionId: string; abort: AbortController }>()
  // Turn ids that finished in this renderer — reconnecting onto one would hang
  // the resumed stream open forever. Bounded by session length, not cleared.
  const finishedTurns = new Set<string>()

  // Runtimes are created lazily, often outside the store's setup, so their
  // watchers are parented to the scope the store was set up in.
  const parentScope = getCurrentScope()

  function ensureRuntime(sessionId: string): SessionRuntime {
    const existing = runtimes.value[sessionId]
    if (existing) return existing
    const create = () =>
      createSessionRuntime({
        sessionId,
        errors: options.errors,
        initialMessages: options.initialMessages?.(sessionId) ?? [],
        finishedTurns,
        buildTurnConfig: options.buildTurnConfig,
        onTurnSubmitted: options.onTurnSubmitted,
        onTurnAdopted: options.onTurnAdopted,
        onTurnSettled: options.onTurnSettled,
        onAdoptedTurnDone: options.onAdoptedTurnDone,
        onTurnPaused: options.onTurnPaused,
        quietTurnErrors: options.quietTurnErrors,
      })
    const created = parentScope ? parentScope.run(create)! : create()
    runtimes.value = { ...runtimes.value, [sessionId]: created }
    return created
  }

  function runtimeFor(sessionId: string): AgentSessionRuntime {
    return ensureRuntime(sessionId)
  }

  function runtimeOf(sessionId: string): AgentSessionRuntime | undefined {
    return runtimes.value[sessionId]
  }

  /** Drop a session's runtime once it holds no turn; its transcript lives on in the record. */
  function release(sessionId: string): void {
    const runtime = runtimes.value[sessionId]
    if (!runtime || runtime.hasTurn()) return
    runtime.dispose()
    const next = { ...runtimes.value }
    delete next[sessionId]
    runtimes.value = next
  }

  const anyTurnOpen = computed(() =>
    Object.values(runtimes.value).some((runtime) => runtime.processing.value),
  )

  registerAgentModeIpc({
    onStreamChunk: ({ sessionId, turnId, chunk }) => {
      runtimes.value[sessionId]?.onChunk(turnId, chunk)
    },
    onToolProgress: ({ sessionId, turnId, toolCallId, text }) => {
      runtimes.value[sessionId]?.onToolProgress(turnId, toolCallId, text)
    },
    onToolImage: (image) => {
      runtimes.value[image.sessionId]?.onToolImage(image)
    },
    onTurnState: ({ sessionId, turnId, state, pauseReason }) => {
      runtimes.value[sessionId]?.onTurnState(turnId, state, pauseReason)
    },
    onTurnDone: ({ sessionId, turnId }) => {
      finishedTurns.add(turnId)
      runtimes.value[sessionId]?.onTurnDone(turnId)
    },
    onQueuePosition: ({ sessionId, turnId, position }) => {
      runtimes.value[sessionId]?.onQueuePosition(turnId, position)
    },
    onExecuteTool: async ({ requestId, sessionId, toolName, input }) => {
      const abort = new AbortController()
      runningTools.set(requestId, { sessionId, abort })
      try {
        const storeTool = options.storeTools?.[toolName]
        if (!storeTool) throw new Error(`Unknown agent tool: ${toolName}`)
        const result = await storeTool(input, sessionId)
        const plainResult: unknown = JSON.parse(JSON.stringify(result ?? null))
        await window.electronAPI.agentMode.submitToolResult(requestId, plainResult)
      } catch (error) {
        options.errors.report(error, {
          category: 'inference',
          code: 'agent/tool-failed',
          userMessage: `Agent tool '${toolName}' failed: ${extractMessage(error)}`,
          surface: 'silent',
        })
        await window.electronAPI.agentMode.submitToolResult(
          requestId,
          undefined,
          extractMessage(error),
        )
      } finally {
        runningTools.delete(requestId)
      }
    },
    onSnapshot: (snapshot) => {
      for (const turn of snapshot.state.agentTurns) {
        if (finishedTurns.has(turn.turnId)) continue
        ensureRuntime(turn.sessionId).resume(turn)
      }
    },
  })

  function abortRunningTools(sessionId: string): void {
    for (const [requestId, tool] of runningTools) {
      if (tool.sessionId !== sessionId) continue
      tool.abort.abort()
      runningTools.delete(requestId)
    }
  }

  return { runtimes, runtimeFor, runtimeOf, release, anyTurnOpen, abortRunningTools }
}
