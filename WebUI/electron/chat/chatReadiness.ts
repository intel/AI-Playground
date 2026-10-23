import { randomUUID } from 'node:crypto'
import { appLoggerInstance } from '../observability/logger'
import type { ChatModelConfig } from '@/types/chatIpc'
import { emitActivity, emitFailure, setInferenceProfileSnapshot } from '../kernel/kernelBus'

// ── Last-load memory for chat backends (kernel-owned inference policy) ────────
//
// Until this module, which LLM to put back after a GPU swap was a Pinia read:
// the orchestrator asked the renderer (`reload-chat-backend`) and textInference
// re-ran ensureBackendReadiness. A hidden-window CLI cannot answer that RPC.
//
// Successful loads remember their args here. Swap-back reloads that snapshot
// in-process. Which model to load still arrives as data (IPC args or the turn's
// `readiness`); download consent stays renderer-side.
//
// Transient loads (Home Agent summarizer) pass remember: false so they cannot
// overwrite the snapshot a later swap-back would restore. Cloud disarms the
// snapshot without forgetting it (`setLastChatBackendLoadActive`) so Image Gen
// while on cloud does not bring a local LLM back, and switching back to local
// can still reload the last one.

const appLogger = appLoggerInstance

export type ChatReadinessArgs = NonNullable<ChatModelConfig['readiness']>

export type EnsureChatBackendReadyOptions = {
  skipGpuAdmission?: boolean
  abortSignal?: AbortSignal
  remember?: boolean
  conversationKey?: string
  activityLabel?: string
}

export type ChatBackendHandle = {
  ensureBackendReadiness(
    llmModelName: string,
    embeddingModelName?: string,
    contextSize?: number,
    modelArgs?: string,
  ): Promise<void>
  readonly baseUrl?: string | null
}

export type ChatReadinessDeps = {
  getService: (serviceName: string) => ChatBackendHandle | undefined
  awaitChatWindow: (signal?: AbortSignal) => Promise<void>
  stopOvmsImageServer: () => Promise<void>
  notifyHomeAgentUpstreamReady: (baseUrl: string) => void
  /** Stop+restart the previous local chat backend after a switch (was renderer lastUsed). */
  resetIdleChatBackend?: (serviceName: string) => Promise<void>
}

let deps: ChatReadinessDeps | null = null
let lastLoad: ChatReadinessArgs | null = null
let lastLoadActive = true
/** Last service `ensureChatBackendReady` actually loaded (not the dropdown snapshot). */
let lastEnsuredServiceName: string | null = null

export function setChatReadinessDeps(next: ChatReadinessDeps): void {
  deps = next
}

export function resetChatReadinessForTest(): void {
  deps = null
  lastLoad = null
  lastLoadActive = true
  lastEnsuredServiceName = null
}

export function lastChatBackendLoadForTest(): ChatReadinessArgs | null {
  return lastLoad
}

export function lastChatBackendLoadActiveForTest(): boolean {
  return lastLoadActive
}

export function setLastChatBackendLoadActive(active: boolean): void {
  lastLoadActive = active
  publishInferenceProfile()
}

/** Note the dropdown selection as last-load without starting a backend. */
export function rememberChatBackendLoad(args: ChatReadinessArgs): void {
  if (!isChatInferenceService(args.serviceName) || !args.llmModelName) return
  lastLoad = { ...args }
  lastLoadActive = true
  publishInferenceProfile()
}

function publishInferenceProfile(): void {
  if (!lastLoad) {
    setInferenceProfileSnapshot(null)
    return
  }
  setInferenceProfileSnapshot({ ...lastLoad, active: lastLoadActive })
}

function requireDeps(): ChatReadinessDeps {
  if (!deps) throw new Error('Chat readiness deps not wired')
  return deps
}

function isChatInferenceService(serviceName: string): boolean {
  return serviceName === 'llamacpp-backend' || serviceName === 'openvino-backend'
}

export async function ensureChatBackendReady(
  args: ChatReadinessArgs,
  options?: EnsureChatBackendReadyOptions,
): Promise<void> {
  const d = requireDeps()
  const service = d.getService(args.serviceName)
  if (!service) throw new Error(`Service ${args.serviceName} not found`)

  const activity = {
    id: `backend-load-${randomUUID()}`,
    category: 'backend' as const,
    label: options?.activityLabel ?? `Loading ${args.llmModelName}…`,
    scope: options?.conversationKey
      ? { kind: 'chat' as const, conversationKey: options.conversationKey }
      : { kind: 'global' as const },
    state: 'active' as const,
  }
  emitActivity('begin', activity)
  let failed = false

  appLogger.info(
    `Ensuring backend readiness for service: ${args.serviceName}, LLM: ${args.llmModelName}, ` +
      `Embedding: ${args.embeddingModelName || 'none'}, Context Size: ${
        args.contextSize ?? 'undefined'
      }, Model args: ${args.modelArgs || 'none'}`,
    'electron-backend',
  )

  try {
    if (!options?.skipGpuAdmission && isChatInferenceService(args.serviceName)) {
      await d.awaitChatWindow(options?.abortSignal)
    }
    if (isChatInferenceService(args.serviceName)) {
      try {
        await d.stopOvmsImageServer()
      } catch (error) {
        appLogger.warn(
          `Stopping the OVMS image server failed: ${String(error)}`,
          'electron-backend',
        )
      }
    }

    await service.ensureBackendReadiness(
      args.llmModelName,
      args.embeddingModelName,
      args.contextSize,
      args.modelArgs,
    )
    if (options?.remember !== false) {
      lastLoad = { ...args }
      lastLoadActive = true
      const previousService = lastEnsuredServiceName
      lastEnsuredServiceName = args.serviceName
      if (previousService && previousService !== args.serviceName && d.resetIdleChatBackend) {
        try {
          await d.resetIdleChatBackend(previousService)
        } catch (error) {
          appLogger.warn(
            `Resetting idle chat backend ${previousService} failed: ${String(error)}`,
            'electron-backend',
          )
        }
      }
      publishInferenceProfile()
    }
    d.notifyHomeAgentUpstreamReady(service.baseUrl ?? '')
    appLogger.info(
      `Backend ${args.serviceName} ready for LLM: ${args.llmModelName}, ` +
        `Embedding: ${args.embeddingModelName || 'none'}`,
      'electron-backend',
    )
  } catch (error) {
    failed = true
    emitFailure({
      category: 'backend',
      code: 'backend/not-ready',
      userMessage: `Could not load ${args.llmModelName}.`,
      technicalMessage: error instanceof Error ? error.message : String(error),
      surface: 'silent',
      context: { serviceName: args.serviceName, conversationKey: options?.conversationKey },
    })
    throw error
  } finally {
    emitActivity('end', { ...activity, state: failed ? 'failed' : 'done' })
  }
}

export async function reloadLastChatBackend(): Promise<void> {
  if (!lastLoad || !lastLoadActive) return
  // Swap-back already set gpuWindow to 'chat' and is running inside
  // swapBackInFlight; awaiting the window here deadlocks.
  await ensureChatBackendReady(lastLoad, {
    skipGpuAdmission: true,
    activityLabel: 'Reloading chat model…',
  })
}
