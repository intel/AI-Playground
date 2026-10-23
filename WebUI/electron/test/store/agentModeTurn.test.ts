import { describe, expect, it, vi } from 'vitest'
import { registerAgentModeIpc } from '@/assets/js/store/agentModeIpc'
import { buildTurnConfig, createAgentTurnRuntime } from '@/assets/js/store/agentModeTurn'
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
    async resumeStream() {
      await chatResume.promise
      return this.transport.reconnectToStream()
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

describe('pendingResume tool progress', () => {
  it('buffers onToolProgress onto the snapshot until reconnect adopts it', async () => {
    chatResume.hold()
    const runtime = createAgentTurnRuntime({
      errors: { report: vi.fn() },
      buildTurnConfig: async () => ({}) as never,
    })
    const handlers = vi.mocked(registerAgentModeIpc).mock.calls.at(-1)?.[0]
    if (!handlers) throw new Error('expected registerAgentModeIpc')

    const turn: AgentTurnSnapshot = {
      turnId: 'turn-1',
      chunks: [],
      toolProgress: { 'call-1': 'start' },
      toolImages: {},
    }
    handlers.onSnapshot({
      scope: { kind: 'global' },
      sequence: 1,
      state: {
        services: [],
        activeTurn: turn,
        activeArtifactRun: null,
        chatTurns: [],
        activities: [],
        inferenceProfile: null,
      },
    })
    handlers.onToolProgress({
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'browser',
      text: 'halfway',
    })
    expect(runtime.toolProgress.value).toEqual({})

    chatResume.release()
    await vi.waitFor(() => expect(runtime.toolProgress.value).toEqual({ 'call-1': 'halfway' }))
  })
})
