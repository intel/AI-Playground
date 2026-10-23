import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelMessage } from 'ai'

const runInProcessComfyToolMock = vi.hoisted(() => vi.fn())
vi.mock('../../artifact/inProcessComfy.ts', () => ({
  runInProcessComfyTool: (...args: unknown[]) => runInProcessComfyToolMock(...args),
}))

const { executeChatComfyTool } = await import('../../chat/chatComfyTool')

describe('executeChatComfyTool', () => {
  beforeEach(() => {
    runInProcessComfyToolMock.mockReset()
    runInProcessComfyToolMock.mockResolvedValue({
      images: [{ id: 'i1', type: 'image', imageUrl: 'aipg-media://out.png' }],
    })
  })

  it('runs comfyUI in-process as a renderer-origin Chat generation', async () => {
    const result = await executeChatComfyTool({
      toolName: 'comfyUI',
      input: { workflow: 'Draft Image', prompt: 'cheese' },
      conversationKey: 'conv-1',
      keepModelsLoaded: true,
      defaultWorkflow: 'Draft Image',
    })
    expect(runInProcessComfyToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'create',
        args: { workflow: 'Draft Image', prompt: 'cheese', defaultWorkflow: 'Draft Image' },
        origin: 'renderer',
        conversationKey: 'conv-1',
        keepModelsLoaded: true,
      }),
    )
    expect(result).toMatchObject({
      images: [{ imageUrl: 'aipg-media://out.png' }],
    })
  })

  it('returns a tool error when an edit has no source image', async () => {
    const result = await executeChatComfyTool({
      toolName: 'comfyUiImageEdit',
      input: { workflow: 'Edit By Prompt', prompt: 'make it cheddar' },
      conversationKey: 'conv-1',
      keepModelsLoaded: false,
    })
    expect(runInProcessComfyToolMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      success: false,
      message: expect.stringMatching(/no image found/i),
      images: [],
    })
  })

  it('converts an aipg-media source image before an edit', async () => {
    const readMediaAsDataUri = vi.fn(async () => 'data:image/png;base64,abc')
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'prev',
            toolName: 'comfyUI',
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
    await executeChatComfyTool({
      toolName: 'comfyUiImageEdit',
      input: { workflow: 'Edit By Prompt', prompt: 'cheddar' },
      messages,
      conversationKey: 'conv-1',
      keepModelsLoaded: false,
      readMediaAsDataUri,
    })
    expect(readMediaAsDataUri).toHaveBeenCalledWith('aipg-media://prior.png')
    expect(runInProcessComfyToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'edit',
        source: 'data:image/png;base64,abc',
        origin: 'renderer',
      }),
    )
  })

  it('converts an uploaded aipg-media file part before an edit', async () => {
    const readMediaAsDataUri = vi.fn(async () => 'data:image/png;base64,abc')
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'url', url: new URL('aipg-media://media/input/dino.png') },
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'remove the extra leg' }] },
    ]
    await executeChatComfyTool({
      toolName: 'comfyUiImageEdit',
      input: { workflow: 'Edit By Prompt', prompt: 'remove the extra leg' },
      messages,
      conversationKey: 'conv-1',
      keepModelsLoaded: false,
      readMediaAsDataUri,
    })
    expect(readMediaAsDataUri).toHaveBeenCalledWith('aipg-media://media/input/dino.png')
    expect(runInProcessComfyToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'edit',
        source: 'data:image/png;base64,abc',
      }),
    )
  })

  it('edits the generated image when one exists after the upload', async () => {
    const readMediaAsDataUri = vi.fn(async () => 'data:image/png;base64,red')
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'url', url: new URL('aipg-media://media/input/dino.png') },
          },
          { type: 'text', text: 'make the dino red' },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'edit',
            toolName: 'comfyUiImageEdit',
            output: {
              type: 'json',
              value: {
                images: [{ type: 'image', imageUrl: 'aipg-media://media/AIPG_Image_00046_.png' }],
              },
            },
          },
        ],
      },
    ]
    await executeChatComfyTool({
      toolName: 'comfyUiImageEdit',
      input: { workflow: 'Upscale', prompt: 'none' },
      messages,
      conversationKey: 'conv-1',
      keepModelsLoaded: false,
      readMediaAsDataUri,
    })
    expect(readMediaAsDataUri).toHaveBeenCalledWith('aipg-media://media/AIPG_Image_00046_.png')
    expect(runInProcessComfyToolMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'data:image/png;base64,red' }),
    )
  })

  it('stamps agent origin when there is no parent conversation', async () => {
    await executeChatComfyTool({
      toolName: 'comfyUI',
      input: { workflow: 'W1' },
      keepModelsLoaded: false,
    })
    expect(runInProcessComfyToolMock).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'agent' }),
    )
  })
})
