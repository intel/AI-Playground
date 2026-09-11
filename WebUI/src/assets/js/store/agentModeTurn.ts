import { markRaw, ref } from 'vue'
import { Chat } from '@ai-sdk/vue'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import { chatTemplateKwargs } from '@/lib/samplingDefaults'
import { openAiApiBase } from '@/lib/inferenceApiBase'
import { HYBRID_CLOUD_NAME } from '@/lib/cloudModeName'
import type { ReasoningEffort } from '@/types/shared'
import { extractMessage } from '../errors/appError'
import { executeAgentTool, getAgentToolSpecs } from '../tools/agentBridge'
import { registerAgentModeIpc } from './agentModeIpc'
import { CLOUD_DEFAULT_MODEL } from './cloudMode'
import type { AgentModeTurnConfig } from '@/types/agentIpc'

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
}

type CloudForTurn = {
  activeProviderBaseUrl?: string | null
  ensureProxyUrl: () => Promise<string>
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
  const { textInference, cloudMode } = options
  if (textInference.backend === 'cloud') {
    const upstreamBaseUrl = cloudMode.activeProviderBaseUrl
    if (!upstreamBaseUrl) {
      throw new Error(
        `${HYBRID_CLOUD_NAME} has no provider base URL configured. Set one up in its setup screen.`,
      )
    }
    const proxyBaseUrl = await cloudMode.ensureProxyUrl()
    const model = textInference.activeModel ?? CLOUD_DEFAULT_MODEL
    return {
      sessionId: options.sessionId,
      workspaceDir: options.workspaceDir,
      modelConfig: {
        source: 'cloud',
        model,
        proxyBaseUrl,
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
      presetName: options.presetName,
      instructions: options.instructions,
      capabilities: options.capabilities,
      unsandboxed: options.unsandboxed,
    }
  }
  const servedModelId = textInference.activeModel?.split('/').join('---') ?? ''
  const baseUrl = textInference.localBackendUrl
  if (!baseUrl) {
    throw new Error(
      'No local inference backend is available. Pick a local backend and model in Agent Settings.',
    )
  }
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
    presetName: options.presetName,
    instructions: options.instructions,
    capabilities: options.capabilities,
    unsandboxed: options.unsandboxed,
    planningThinkingOnly:
      textInference.modelSupportsThinkingToggle &&
      textInference.thinkingEnabled &&
      options.planningThinkingOnly,
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
   * Tools the store implements itself, dispatched by name ahead of the media
   * bridge. They are how a tool call can reach state the bridge must not import:
   * `tools/agentBridge` is part of this module's own import graph, so reaching
   * back into the Agent Mode store from there would close a cycle and drag the
   * whole store graph into every module the bridge is loaded from.
   */
  storeTools?: Record<string, (input: Record<string, unknown>) => Promise<unknown>>
}) {
  const processing = ref(false)
  const toolProgress = ref<Record<string, string>>({})
  const toolImages = ref<Record<string, AgentToolImage[]>>({})
  const runningTools = new Map<string, AbortController>()
  let turnCounter = 0
  let activeTurn: ActiveTurn | null = null

  registerAgentModeIpc({
    onStreamChunk: ({ turnId, chunk }) => {
      if (!activeTurn || activeTurn.turnId !== turnId || activeTurn.closed) return
      try {
        activeTurn.controller.enqueue(chunk as UIMessageChunk)
      } catch {
        // Stream already closed (e.g. user aborted) — drop the chunk.
      }
    },
    onToolProgress: ({ turnId, toolCallId, text }) => {
      if (!activeTurn || activeTurn.turnId !== turnId) return
      toolProgress.value = { ...toolProgress.value, [toolCallId]: text }
    },
    onToolImage: (image) => {
      const shown = toolImages.value[image.toolCallId] ?? []
      toolImages.value = { ...toolImages.value, [image.toolCallId]: [...shown, image] }
    },
    onTurnDone: ({ turnId }) => {
      if (!activeTurn || activeTurn.turnId !== turnId || activeTurn.closed) return
      activeTurn.closed = true
      try {
        activeTurn.controller.close()
      } catch {
        // Already closed.
      }
      activeTurn = null
    },
    onExecuteTool: async ({ requestId, toolCallId, toolName, input }) => {
      const abort = new AbortController()
      runningTools.set(requestId, abort)
      try {
        const storeTool = options.storeTools?.[toolName]
        const result = storeTool
          ? await storeTool(input)
          : await executeAgentTool(toolName, input, toolCallId, abort.signal)
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
  })

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
    reconnectToStream: async () => null,
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
