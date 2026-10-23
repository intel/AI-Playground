import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from 'ai'
import type { MediaAgentCatalog, ChatModelConfig } from '@/types/chatIpc'

const runMediaAgentInMainMock = vi.hoisted(() => vi.fn())
vi.mock('../../chat/mediaAgentRunner.ts', () => ({
  runMediaAgentInMain: (...args: unknown[]) => runMediaAgentInMainMock(...args),
}))

const { executeChatMediaTool } = await import('../../chat/chatMediaTool')

const catalog: MediaAgentCatalog = {
  system: 'You are the media specialist.',
  toolSpecs: [{ name: 'comfyUI', description: 'Create images', inputSchema: {} }],
}

const model: ChatModelConfig = {
  backend: 'llamaCPP',
  modelId: 'test-model',
  baseUrl: 'http://127.0.0.1:39101',
}

describe('executeChatMediaTool', () => {
  beforeEach(() => {
    runMediaAgentInMainMock.mockReset()
  })
  it('condenses the in-process specialist result for the parent tool', async () => {
    runMediaAgentInMainMock.mockResolvedValueOnce({
      text: 'Made cheese.',
      steps: [
        {
          toolName: 'comfyUI',
          input: { workflow: 'Draft Image' },
          output: {
            images: [
              { id: 'i1', type: 'image', imageUrl: 'aipg-media://cheese.png', mode: 'imageGen' },
            ],
          },
        },
      ],
    })
    const result = await executeChatMediaTool({
      input: { request: 'an image of cheese' },
      toolCallId: 'call_1',
      conversationKey: 'conv-1',
      catalog,
      model,
      keepModelsLoaded: false,
      readMediaAsDataUri: async (url) => url,
    })
    expect(runMediaAgentInMainMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runKey: 'call_1',
        conversationKey: 'conv-1',
        request: 'an image of cheese',
      }),
      undefined,
    )
    expect(result).toMatchObject({
      summary: 'Made cheese.',
      images: [{ id: 'i1', type: 'image', imageUrl: 'aipg-media://cheese.png' }],
    })
    expect(result).not.toHaveProperty('success')
  })

  it('converts an aipg-media source image before the nested run', async () => {
    runMediaAgentInMainMock.mockResolvedValueOnce({ text: '', steps: [] })
    const readMediaAsDataUri = vi.fn(async () => 'data:image/png;base64,abc')
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'prev',
            toolName: 'media',
            output: {
              type: 'json',
              value: {
                images: [{ type: 'image', imageUrl: 'aipg-media://prior.png' }],
              },
            },
          },
        ],
      },
    ]
    await executeChatMediaTool({
      input: { request: 'make it cheddar' },
      toolCallId: 'call_2',
      conversationKey: 'conv-1',
      messages,
      catalog,
      model,
      keepModelsLoaded: true,
      readMediaAsDataUri,
    })
    expect(readMediaAsDataUri).toHaveBeenCalledWith('aipg-media://prior.png')
    expect(runMediaAgentInMainMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceImage: 'data:image/png;base64,abc',
        keepModelsLoaded: true,
      }),
      undefined,
    )
  })
})
