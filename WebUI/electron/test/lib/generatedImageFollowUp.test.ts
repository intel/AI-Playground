import type { ModelMessage } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { attachGeneratedImageFollowUps } from '@/lib/generatedImageFollowUp'

const RESULT = {
  images: [
    {
      id: 'i1',
      type: 'image',
      imageUrl: 'aipg-media://red.png',
      mode: 'imageGen',
      settings: { preset: 'Edit by Prompt 2', width: 512, height: 512, resolution: '512x512' },
    },
  ],
}

function toolMessage(): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'comfyUiImageEdit',
        output: { type: 'json', value: RESULT },
      },
    ],
  }
}

describe('attachGeneratedImageFollowUps', () => {
  it('attaches the result image for a vision model and drops the placeholder size', async () => {
    const read = vi.fn(async () => 'data:image/png;base64,red')
    const messages = await attachGeneratedImageFollowUps([toolMessage()], {
      read,
      vision: true,
    })

    expect(read).toHaveBeenCalledWith('aipg-media://red.png')
    const serialized = JSON.stringify(messages)
    expect(serialized).toContain('data:image/png;base64,red')
    expect(serialized).toContain('attached in the following message')
    expect(serialized).toContain('Edit by Prompt 2')
    expect(serialized).not.toContain('512')
    expect(serialized).not.toContain('resolution')
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1)
  })

  it('does not attach a file part when the model has no vision', async () => {
    const read = vi.fn(async () => 'data:image/png;base64,red')
    const messages = await attachGeneratedImageFollowUps([toolMessage()], {
      read,
      vision: false,
    })

    expect(read).not.toHaveBeenCalled()
    const serialized = JSON.stringify(messages)
    expect(serialized).toContain('aipg-media://red.png')
    expect(serialized).toContain('Image generated with Edit by Prompt 2.')
    expect(serialized).not.toContain('512')
    expect(serialized).not.toContain('data:image')
    expect(serialized).not.toContain('attached in the following message')
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(0)
  })
})
