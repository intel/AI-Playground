import { markRaw, ref } from 'vue'
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
import type { AgentModeTurnConfig } from '@/types/agentIpc'
import type { AgentTurnSnapshot } from '@/types/kernelEvents'

type ActiveTurn = {
  turnId: string
  controller: ReadableStreamDefaultController<UIMessageChunk>
  closed: boolean
}

type InferenceForTurn = {
  samplingRequestBody: Record<string, unknown>
  temperature: number
  modelSupportsThinkingToggle: boolean
  thinkingEnabled: boolean
  thinkingActive: boolean
  effectiveReasoningEffort?: string
  backend: string
  activeModel?: string | null
  localBackendUrl?: string | null
  modelSupportsVision: boolean
  effectiveContextWindow: number
  maxContextSizeFromModel?: unknown
  getCurrentDeviceId: () => string | null | undefined
  getCurrentDeviceName: () => string | null | undefined
  contextSize?: number
  activeLlmModel?: { llamaCppArgs?: string } | null
  /** Downloaded embedding model + the local backend that serves it (rag capability). */
  embeddingBackend: 'llamaCPP' | 'openVINO'
  activeEmbeddingModel?: string | null
  llmEmbeddingModels?: readonly { name: string; type: string; downloaded: boolean }[]
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

type CloudForTurn = {
  activeProviderBaseUrl?: string | null
  selectedProviderId: string
  activeProviderAuthStyle: string
  capabilitiesFor: (name: string) => { reasoningAdvertised: boolean }
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
  workspaceDir: string
  presetName: string
  instructions: string
  capabilities: string[]
  unsandboxed: boolean
  planningThinkingOnly: boolean
  textInference: InferenceForTurn
  cloudMode: CloudForTurn
}): Promise<AgentModeTurnConfig> {
  const toolSpecs = getAgentToolSpecs()
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
      ...embeddingConfigOf(textInference),
    }
  }
  const servedModelId = textInference.activeModel?.split('/').join('---') ?? ''
  const baseUrl = textInference.localBackendUrl
  if (!baseUrl) {
    throw new Error(
      'No local inference backend is available. Pick a local backend and model in Agent Settings.',
    )
  }
  const activeModel = textInference.activeModel
  const embeddingModelName = readinessEmbeddingModel(textInference, options.capabilities)
  return {
    sessionId: options.sessionId,
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

export function createAgentTurnRuntime(options: {
  errors: { report: (error: unknown, overrides: Record<string, unknown>) => void }
  buildTurnConfig: () => Promise<AgentModeTurnConfig>
  /**
   * Tools the store implements itself (e.g. offer_game_agent). Media tools
   * execute in main; anything else arriving here is unknown.
   */
  storeTools?: Record<string, (input: Record<string, unknown>) => Promise<unknown>>
}) {
  const processing = ref(false)
  const toolProgress = ref<Record<string, string>>({})
  const toolImages = ref<Record<string, AgentToolImage[]>>({})
  const runningTools = new Map<string, AbortController>()
  let turnCounter = 0
  let activeTurn: ActiveTurn | null = null

  // Resume state: a renderer that (re)connects while main is mid-turn adopts
  // that turn from the kernel snapshot. `pendingResume` holds it between the
  // snapshot install and the transport's reconnectToStream, and buffers any
  // stream chunks that win that race. `adoptedTurnId` marks a turn whose
  // processing flag has no sendMessage finally to clear it.
  let pendingResume: { turn: AgentTurnSnapshot; chunks: unknown[] } | null = null
  let adoptedTurnId: string | null = null
  // Turn ids that finished in this renderer — reconnecting onto one would hang
  // the resumed stream open forever. Bounded by session length, not cleared.
  const finishedTurns = new Set<string>()

  const transport: ChatTransport<UIMessage> = {
    sendMessages: async ({ messages, abortSignal }) => {
      const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
      const prompt =
        lastUserMessage?.parts
          ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('\n\n') ?? ''

      const turnId = `turn-${++turnCounter}`
      const config = await options.buildTurnConfig()

      return new ReadableStream<UIMessageChunk>({
        start: (controller) => {
          activeTurn = { turnId, controller, closed: false }
          abortSignal?.addEventListener('abort', () => {
            window.electronAPI.agentMode.cancel()
          })
          window.electronAPI.agentMode.startTurn(turnId, prompt, config).catch((error) => {
            if (activeTurn?.turnId === turnId && !activeTurn.closed) {
              activeTurn.closed = true
              try {
                controller.enqueue({ type: 'error', errorText: extractMessage(error) })
                controller.close()
              } catch {
                // Stream already closed.
              }
              activeTurn = null
            }
          })
        },
        cancel: () => {
          if (activeTurn?.turnId === turnId) {
            activeTurn.closed = true
            activeTurn = null
          }
          window.electronAPI.agentMode.cancel()
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
      // This fresh renderer's counter must never mint an id the running turn
      // already has — the next sendMessages would collide with the live turnId.
      const asNumber = Number(turn.turnId.replace(/^turn-/, ''))
      if (Number.isFinite(asNumber) && asNumber > turnCounter) turnCounter = asNumber
      processing.value = true
      adoptedTurnId = turn.turnId
      toolProgress.value = { ...turn.toolProgress }
      const restoredImages: typeof toolImages.value = {}
      for (const [toolCallId, images] of Object.entries(turn.toolImages)) {
        restoredImages[toolCallId] = [...images]
      }
      toolImages.value = restoredImages
      return new ReadableStream<UIMessageChunk>({
        start: (controller) => {
          activeTurn = { turnId: turn.turnId, controller, closed: false }
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
          window.electronAPI.agentMode.cancel()
        },
      })
    },
  }

  const chat = markRaw(
    new Chat<UIMessage>({
      transport,
      onError: (error) => {
        options.errors.report(error, {
          category: 'inference',
          code: 'agent/turn-failed',
          userMessage: `Agent turn failed: ${extractMessage(error)}`,
          surface: 'toast',
        })
      },
    }),
  )

  registerAgentModeIpc({
    onStreamChunk: ({ turnId, chunk }) => {
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
    },
    onToolProgress: ({ turnId, toolCallId, text }) => {
      if (pendingResume && pendingResume.turn.turnId === turnId) {
        pendingResume.turn.toolProgress = {
          ...pendingResume.turn.toolProgress,
          [toolCallId]: text,
        }
        return
      }
      if (!activeTurn || activeTurn.turnId !== turnId) return
      toolProgress.value = { ...toolProgress.value, [toolCallId]: text }
    },
    onToolImage: (image) => {
      const shown = toolImages.value[image.toolCallId] ?? []
      toolImages.value = { ...toolImages.value, [image.toolCallId]: [...shown, image] }
    },
    onTurnDone: ({ turnId }) => {
      finishedTurns.add(turnId)
      if (adoptedTurnId === turnId) {
        processing.value = false
        adoptedTurnId = null
      }
      if (!activeTurn || activeTurn.turnId !== turnId || activeTurn.closed) return
      activeTurn.closed = true
      try {
        activeTurn.controller.close()
      } catch {
        // Already closed.
      }
      activeTurn = null
    },
    onExecuteTool: async ({ requestId, toolName, input }) => {
      const abort = new AbortController()
      runningTools.set(requestId, abort)
      try {
        const storeTool = options.storeTools?.[toolName]
        if (!storeTool) throw new Error(`Unknown agent tool: ${toolName}`)
        const result = await storeTool(input)
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
      const turn = snapshot.state.activeTurn
      // Only a renderer with no turn of its own resumes — a turn started here
      // since boot must not be displaced by a snapshot that predates it.
      if (!turn || activeTurn || finishedTurns.has(turn.turnId)) return
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
        })
    },
  })

  function abortRunningTools(): void {
    for (const abort of runningTools.values()) abort.abort()
    runningTools.clear()
  }

  return {
    chat,
    processing,
    toolProgress,
    toolImages,
    abortRunningTools,
  }
}
