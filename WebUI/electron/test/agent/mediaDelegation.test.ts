import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import type { AgentToolSpec } from '@/types/agentIpc'
import type { ChatModelConfig } from '@/types/chatIpc'

// The `media` tool runs the nested specialist in-process (step 12). Main
// still resolves workspace paths to data URIs on the way in and saves
// generated media into the workspace on the way out.

const runMediaAgentInMainMock =
  vi.fn<(request: unknown, signal?: AbortSignal) => Promise<unknown>>()
const saveMediaMock = vi.fn<(result: unknown, workspaceDir: string) => Promise<unknown>>()

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../agent/piRuntime.ts', () => ({
  loadPi: async () => ({ defineTool: (definition: unknown) => definition }),
}))

vi.mock('../../chat/mediaAgentRunner.ts', () => ({
  runMediaAgentInMain: (request: unknown, signal?: AbortSignal) =>
    runMediaAgentInMainMock(request, signal),
}))

vi.mock('../../agent/piCustomTools.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent/piCustomTools.ts')>()
  return {
    ...actual,
    saveGeneratedMediaToWorkspace: saveMediaMock,
    jsonResult: (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] }),
  }
})

const { buildDelegatedMediaTool, resetMediaSpecialistTurnForTest } =
  await import('../../agent/capabilities/mediaDelegation.ts')

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-delegation-'))

const MEDIA_SPEC: AgentToolSpec = {
  name: 'media',
  description: 'create or transform media',
  inputSchema: { type: 'object' },
  workspacePathInputs: ['sourceImagePath'],
}

const CHAT_MODEL: ChatModelConfig = {
  backend: 'llamaCPP',
  modelId: 'test-model',
  baseUrl: 'http://127.0.0.1:39101',
}

const MEDIA_AGENT = {
  system: 'You are the media specialist.',
  toolSpecs: [{ name: 'comfyUI', description: 'create', inputSchema: { type: 'object' } }],
  repairData: { comfyUI: { names: ['W1'], defaultWorkflow: 'W1' } },
}

function hostWith(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    workspaceDir,
    toolSpecs: [MEDIA_SPEC],
    agentDir: workspaceDir,
    keepModelsLoaded: false,
    mediaAgent: MEDIA_AGENT,
    chatModel: CHAT_MODEL,
    ...overrides,
  }
}

function specialistResult(images: unknown[] = []) {
  return {
    text: 'Made it.',
    steps: [{ toolName: 'comfyUI', input: { workflow: 'W1' }, output: { images } }],
  }
}

describe('mediaDelegation (in-process media tool)', () => {
  beforeEach(() => {
    resetMediaSpecialistTurnForTest()
    runMediaAgentInMainMock.mockReset()
    saveMediaMock.mockReset().mockImplementation(async (result) => result)
  })

  it('runs the specialist in main and saves the condensed result', async () => {
    runMediaAgentInMainMock.mockResolvedValueOnce(
      specialistResult([{ id: '1', type: 'image', imageUrl: 'aipg-media://castle.png' }]),
    )
    const tool = (await buildDelegatedMediaTool(hostWith(), MEDIA_SPEC)) as unknown as {
      name: string
      execute: (id: string, params: unknown, signal: AbortSignal) => Promise<unknown>
    }
    const controller = new AbortController()

    await tool.execute('call-1', { request: 'a castle' }, controller.signal)

    expect(tool.name).toBe('media')
    expect(runMediaAgentInMainMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runKey: 'call-1',
        request: 'a castle',
        system: MEDIA_AGENT.system,
        model: CHAT_MODEL,
        toolSpecs: MEDIA_AGENT.toolSpecs,
        keepModelsLoaded: false,
        origin: 'agent',
        // The awaiting turn occupies the GPU as text under this key; without it
        // the nested run waits for its own parent and never starts.
        conversationKey: 'session-1',
      }),
      controller.signal,
    )
    expect(saveMediaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'Made it.',
        images: [{ id: '1', type: 'image', imageUrl: 'aipg-media://castle.png' }],
      }),
      workspaceDir,
    )
  })

  it('resolves a workspace source path to a data URI before the specialist run', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
    runMediaAgentInMainMock.mockResolvedValueOnce(specialistResult())
    const tool = (await buildDelegatedMediaTool(hostWith(), MEDIA_SPEC)) as unknown as {
      execute: (id: string, params: unknown, signal: AbortSignal) => Promise<unknown>
    }

    await tool.execute(
      'call-1',
      { request: 'edit this', sourceImagePath: 'shot.png' },
      new AbortController().signal,
    )

    const request = runMediaAgentInMainMock.mock.calls[0][0] as { sourceImage?: string }
    expect(request.sourceImage).toMatch(/^data:image\/png;base64,/)
  })

  it('forwards the abort signal to the in-process run', async () => {
    runMediaAgentInMainMock.mockResolvedValueOnce(specialistResult())
    const tool = (await buildDelegatedMediaTool(hostWith(), MEDIA_SPEC)) as unknown as {
      execute: (id: string, params: unknown, signal: AbortSignal) => Promise<unknown>
    }
    const controller = new AbortController()

    await tool.execute('call-1', { request: 'x' }, controller.signal)

    expect(runMediaAgentInMainMock.mock.calls[0][1]).toBe(controller.signal)
  })

  it('fails clearly when the turn did not ship a specialist catalog', async () => {
    const tool = (await buildDelegatedMediaTool(
      hostWith({ mediaAgent: undefined, chatModel: undefined }),
      MEDIA_SPEC,
    )) as unknown as {
      execute: (id: string, params: unknown, signal: AbortSignal) => Promise<unknown>
    }

    await expect(
      tool.execute('call-1', { request: 'x' }, new AbortController().signal),
    ).rejects.toThrow(/not configured/)
    expect(runMediaAgentInMainMock).not.toHaveBeenCalled()
  })
})
