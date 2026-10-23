import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { findSourceImage } from '@/lib/findSourceImage'

const DATA_URI = 'data:image/png;base64,aGk='
const MEDIA_URL = 'aipg-media://generated/castle.png'

function userFile(data: string): ModelMessage {
  return {
    role: 'user',
    content: [{ type: 'file', mediaType: 'image/png', data }],
  }
}

function toolResult(toolName: string, output: unknown): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolName, output }],
  } as ModelMessage
}

describe('findSourceImage', () => {
  it('prefers a generated image that arrived after the prompt image', () => {
    const messages: ModelMessage[] = [
      userFile(DATA_URI),
      toolResult('comfyUiImageEdit', {
        type: 'json',
        value: { images: [{ type: 'image', imageUrl: MEDIA_URL }] },
      }),
    ]
    expect(findSourceImage(messages)).toBe(MEDIA_URL)
  })

  it('prefers an image on the current prompt over earlier conversation images', () => {
    const messages: ModelMessage[] = [
      toolResult('comfyUI', { images: [{ type: 'image', imageUrl: MEDIA_URL }] }),
      userFile(DATA_URI),
    ]
    expect(findSourceImage(messages)).toBe(DATA_URI)
  })

  it('reads an aipg-media URL from a comfyUI tool result', () => {
    expect(
      findSourceImage([
        toolResult('comfyUI', { images: [{ type: 'image', imageUrl: MEDIA_URL }] }),
      ]),
    ).toBe(MEDIA_URL)
  })

  it('unwraps a json tool-output envelope', () => {
    expect(
      findSourceImage([
        toolResult('comfyUiImageEdit', {
          type: 'json',
          value: { images: [{ type: 'image', imageUrl: MEDIA_URL }] },
        }),
      ]),
    ).toBe(MEDIA_URL)
  })

  it('reads unwrapped { images } from a media tool result', () => {
    expect(
      findSourceImage([toolResult('media', { images: [{ type: 'image', imageUrl: MEDIA_URL }] })]),
    ).toBe(MEDIA_URL)
  })

  it('reads an aipg-media string from an uploaded file part', () => {
    expect(findSourceImage([userFile(MEDIA_URL)])).toBe(MEDIA_URL)
  })

  it('unwraps an aipg-media url object from an uploaded file part', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'url', url: new URL(MEDIA_URL) },
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'remove the extra leg' }] },
    ]
    expect(findSourceImage(messages)).toBe(MEDIA_URL)
  })

  it('unwraps a data-url object left after attachment conversion', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'url', url: new URL(DATA_URI) },
          },
        ],
      },
    ]
    expect(findSourceImage(messages)).toBe(DATA_URI)
  })

  it('skips an unreadable file part and keeps an earlier generated image', () => {
    const messages: ModelMessage[] = [
      toolResult('comfyUI', { images: [{ type: 'image', imageUrl: MEDIA_URL }] }),
      {
        role: 'user',
        content: [
          { type: 'text', text: 'edit this' },
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'not-a-url' } },
        ],
      },
    ]
    expect(findSourceImage(messages)).toBe(MEDIA_URL)
  })

  it('ignores non-image media and unknown tools', () => {
    expect(
      findSourceImage([
        toolResult('bash', { images: [{ type: 'image', imageUrl: MEDIA_URL }] }),
        toolResult('comfyUI', { images: [{ type: 'video', videoUrl: 'aipg-media://v.mp4' }] }),
      ]),
    ).toBeNull()
  })
})
