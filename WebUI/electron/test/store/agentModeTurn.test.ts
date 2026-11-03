import { describe, expect, it, vi } from 'vitest'
import { registerAgentModeIpc } from '@/assets/js/store/agentModeIpc'
import { buildTurnConfig, createAgentTurnRuntimes } from '@/assets/js/store/agentModeTurn'
import type { AgentTurnSnapshot } from '@/types/kernelEvents'

const chatResume = vi.hoisted(() => {
  const state: { resolve: (() => void) | null; promise: Promise<void> } = {
    resolve: null,
    promise: Promise.resolve(),
  }
  return {
    hold() {
      state.promise = new Promise<void>((resolve) => {
        state.resolve = resolve
      })
    },
    release() {
      state.resolve?.()
      state.resolve = null
    },
    get promise() {
      return state.promise
    },
  }
})

vi.mock('@/assets/js/tools/agentBridge', () => ({
  getAgentToolSpecs: () => [],
}))

vi.mock('@/assets/js/store/developerSettings', () => ({
  useDeveloperSettings: () => ({ keepModelsLoaded: false }),
}))

vi.mock('@/assets/js/store/agentModeIpc', () => ({
  registerAgentModeIpc: vi.fn(),
}))

vi.mock('@ai-sdk/vue', () => ({
  Chat: class {
    transport: { reconnectToStream: () => Promise<unknown> }
    constructor(options: { transport: { reconnectToStream: () => Promise<unknown> } }) {
      this.transport = options.transport
    }
    // Like the SDK, settles only once the resumed stream has been read to its end.
    async resumeStream() {
      await chatResume.promise
      const stream = (await this.transport.reconnectToStream()) as ReadableStream | null
      const reader = stream?.getReader()
      while (reader && !(await reader.read()).done) {
        // Drain.
      }
    }
  },
}))

function localInference(overrides: Record<string, unknown> = {}) {
  return {
    samplingRequestBody: {},
    temperature: 0.7,
    modelSupportsThinkingToggle: false,
    thinkingEnabled: false,
    thinkingActive: false,
    backend: 'llamaCPP',
    activeModel: 'Qwen3-9B',
    localBackendUrl: 'http://127.0.0.1:39000',
    modelSupportsVision: false,
    effectiveContextWindow: 32768,
    getCurrentDeviceId: () => 'GPU.0',
    getCurrentDeviceName: () => 'Intel Arc',
    contextSize: 8192,
    activeLlmModel: { llamaCppArgs: '--jinja' },
    ...overrides,
  }
}

describe('buildTurnConfig readiness (step 15)', () => {
  it('ships local backend load facts so main can occupy and load', async () => {
    const config = await buildTurnConfig({
      sessionId: 'aipg-agent-1',
      workspaceDir: '/tmp/ws',
      presetName: 'Agent',
      instructions: 'Be helpful.',
      capabilities: [],
      unsandboxed: false,
      planningThinkingOnly: false,
      textInference: localInference() as never,
      cloudMode: {
        selectedProviderId: 'openai',
        activeProviderAuthStyle: 'bearer',
        capabilitiesFor: () => ({ reasoningAdvertised: false }),
      },
    })
    expect(config.readiness).toEqual({
      serviceName: 'llamacpp-backend',
      llmModelName: 'Qwen3-9B',
      contextSize: 8192,
      modelArgs: '--jinja',
    })
  })

  it('names the Session the turn belongs to, so main files its History Entry there', async () => {
    const config = await buildTurnConfig({
      sessionId: 'aipg-agent-1',
      sessionRef: 'session-1',
      workspaceDir: '/games/plum',
      presetName: 'Game Agent',
      instructions: '',
      capabilities: [],
      unsandboxed: false,
      planningThinkingOnly: false,
      textInference: localInference() as never,
      cloudMode: {
        selectedProviderId: 'openai',
        activeProviderAuthStyle: 'bearer',
        capabilitiesFor: () => ({ reasoningAdvertised: false }),
      },
    })
    expect(config.sessionRef).toBe('session-1')
  })

  it('omits readiness when no local model is selected', async () => {
    const config = await buildTurnConfig({
      sessionId: 'aipg-agent-1',
      workspaceDir: '/tmp/ws',
      presetName: 'Agent',
      instructions: '',
      capabilities: [],
      unsandboxed: false,
      planningThinkingOnly: false,
      textInference: localInference({ activeModel: null }) as never,
      cloudMode: {
        selectedProviderId: 'openai',
        activeProviderAuthStyle: 'bearer',
        capabilitiesFor: () => ({ reasoningAdvertised: false }),
      },
    })
    expect(config.readiness).toBeUndefined()
  })

  it('does not ship readiness for a cloud turn', async () => {
    const config = await buildTurnConfig({
      sessionId: 'aipg-agent-1',
      workspaceDir: '/tmp/ws',
      presetName: 'Agent',
      instructions: '',
      capabilities: [],
      unsandboxed: false,
      planningThinkingOnly: false,
      textInference: localInference({
        backend: 'cloud',
        activeModel: 'gpt-test',
        localBackendUrl: null,
      }) as never,
      cloudMode: {
        activeProviderBaseUrl: 'https://api.openai.com',
        selectedProviderId: 'openai',
        activeProviderAuthStyle: 'bearer',
        capabilitiesFor: () => ({ reasoningAdvertised: false }),
      },
    })
    expect(config.modelConfig.source).toBe('cloud')
    expect(config.readiness).toBeUndefined()
  })

  it('starts the embedding server with the LLM when rag is on and the model is downloaded', async () => {
    const config = await buildTurnConfig({
      sessionId: 'aipg-agent-1',
      workspaceDir: '/tmp/ws',
      presetName: 'Agent',
      instructions: '',
      capabilities: ['rag'],
      unsandboxed: false,
      planningThinkingOnly: false,
      textInference: localInference({
        embeddingBackend: 'llamaCPP',
        activeEmbeddingModel: 'bge-small',
        llmEmbeddingModels: [{ name: 'bge-small', type: 'llamaCPP', downloaded: true }],
      }) as never,
      cloudMode: {
        selectedProviderId: 'openai',
        activeProviderAuthStyle: 'bearer',
        capabilitiesFor: () => ({ reasoningAdvertised: false }),
      },
    })
    expect(config.readiness?.embeddingModelName).toBe('bge-small')
  })

  it('leaves the embedding server for the tool when the model is not on disk', async () => {
    const config = await buildTurnConfig({
      sessionId: 'aipg-agent-1',
      workspaceDir: '/tmp/ws',
      presetName: 'Agent',
      instructions: '',
      capabilities: ['rag'],
      unsandboxed: false,
      planningThinkingOnly: false,
      textInference: localInference({
        embeddingBackend: 'llamaCPP',
        activeEmbeddingModel: 'bge-small',
        llmEmbeddingModels: [{ name: 'bge-small', type: 'llamaCPP', downloaded: false }],
      }) as never,
      cloudMode: {
        selectedProviderId: 'openai',
        activeProviderAuthStyle: 'bearer',
        capabilitiesFor: () => ({ reasoningAdvertised: false }),
      },
    })
    expect(config.readiness?.embeddingModelName).toBeUndefined()
  })

  it('does not start an embedding server when rag is off', async () => {
    const config = await buildTurnConfig({
      sessionId: 'aipg-agent-1',
      workspaceDir: '/tmp/ws',
      presetName: 'Agent',
      instructions: '',
      capabilities: ['media'],
      unsandboxed: false,
      planningThinkingOnly: false,
      textInference: localInference({
        embeddingBackend: 'llamaCPP',
        activeEmbeddingModel: 'bge-small',
        llmEmbeddingModels: [{ name: 'bge-small', type: 'llamaCPP', downloaded: true }],
      }) as never,
      cloudMode: {
        selectedProviderId: 'openai',
        activeProviderAuthStyle: 'bearer',
        capabilitiesFor: () => ({ reasoningAdvertised: false }),
      },
    })
    expect(config.readiness?.embeddingModelName).toBeUndefined()
  })
})

function snapshotOf(turns: AgentTurnSnapshot[]) {
  return {
    scope: { kind: 'global' as const },
    sequence: 1,
    state: {
      services: [],
      agentTurns: turns,
      activeArtifactRun: null,
      chatTurns: [],
      activities: [],
      inferenceProfile: null,
    },
  }
}

function freshRuntimes() {
  const runtimes = createAgentTurnRuntimes({
    errors: { report: vi.fn() },
    buildTurnConfig: async () => ({}) as never,
  })
  const handlers = vi.mocked(registerAgentModeIpc).mock.calls.at(-1)?.[0]
  if (!handlers) throw new Error('expected registerAgentModeIpc')
  return { runtimes, handlers }
}

describe('pendingResume tool progress', () => {
  it('buffers onToolProgress onto the snapshot until reconnect adopts it', async () => {
    chatResume.hold()
    const { runtimes, handlers } = freshRuntimes()

    const turn: AgentTurnSnapshot = {
      sessionId: 'aipg-agent-1',
      turnId: 'turn-1',
      state: 'running',
      chunks: [],
      toolProgress: { 'call-1': 'start' },
      toolImages: {},
    }
    handlers.onSnapshot(snapshotOf([turn]))
    handlers.onToolProgress({
      sessionId: 'aipg-agent-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'browser',
      text: 'halfway',
    })
    const runtime = runtimes.runtimeOf('aipg-agent-1')!
    expect(runtime.toolProgress.value).toEqual({})

    chatResume.release()
    await vi.waitFor(() => expect(runtime.toolProgress.value).toEqual({ 'call-1': 'halfway' }))
  })
})

describe('routing kernel events by session', () => {
  const turnOf = (sessionId: string, turnId: string): AgentTurnSnapshot => ({
    sessionId,
    turnId,
    state: 'running',
    chunks: [],
    toolProgress: {},
    toolImages: {},
  })

  it('adopts every open turn into its own session runtime', async () => {
    chatResume.hold()
    const { runtimes, handlers } = freshRuntimes()
    handlers.onSnapshot(snapshotOf([turnOf('session-a', 'turn-a'), turnOf('session-b', 'turn-b')]))
    chatResume.release()

    const a = runtimes.runtimeOf('session-a')!
    const b = runtimes.runtimeOf('session-b')!
    await vi.waitFor(() => expect(a.processing.value && b.processing.value).toBe(true))

    handlers.onToolProgress({
      sessionId: 'session-b',
      turnId: 'turn-b',
      toolCallId: 'call-1',
      toolName: 'bash',
      text: 'only B',
    })
    handlers.onToolImage({
      sessionId: 'session-a',
      turnId: 'turn-a',
      toolCallId: 'call-2',
      dataUri: 'data:image/png;base64,',
      label: 'only A',
    })

    expect(b.toolProgress.value).toEqual({ 'call-1': 'only B' })
    expect(a.toolProgress.value).toEqual({})
    expect(a.toolImages.value['call-2']).toHaveLength(1)
    expect(b.toolImages.value).toEqual({})
  })

  it('ignores events whose session id does not own the turn', async () => {
    chatResume.hold()
    const { runtimes, handlers } = freshRuntimes()
    handlers.onSnapshot(snapshotOf([turnOf('session-a', 'turn-a')]))
    chatResume.release()
    const a = runtimes.runtimeOf('session-a')!
    await vi.waitFor(() => expect(a.processing.value).toBe(true))

    handlers.onToolProgress({
      sessionId: 'session-z',
      turnId: 'turn-a',
      toolCallId: 'call-1',
      toolName: 'bash',
      text: 'stray',
    })

    expect(a.toolProgress.value).toEqual({})
    expect(runtimes.runtimeOf('session-z')).toBeUndefined()
  })

  it('hands store tools the session that called them', async () => {
    const offer = vi.fn(async () => ({ accepted: true }))
    const submitToolResult = vi.fn(async () => {})
    globalThis.window = {
      electronAPI: { agentMode: { submitToolResult } },
    } as unknown as Window & typeof globalThis
    createAgentTurnRuntimes({
      errors: { report: vi.fn() },
      buildTurnConfig: async () => ({}) as never,
      storeTools: { offerGameAgent: offer },
    })
    const handlers = vi.mocked(registerAgentModeIpc).mock.calls.at(-1)![0]

    await handlers.onExecuteTool({
      requestId: 'req-1',
      sessionId: 'session-b',
      toolCallId: 'call-1',
      toolName: 'offerGameAgent',
      input: { reason: 'boss' },
    })

    expect(offer).toHaveBeenCalledWith({ reason: 'boss' }, 'session-b')
    expect(submitToolResult).toHaveBeenCalledWith('req-1', { accepted: true })
  })
})
