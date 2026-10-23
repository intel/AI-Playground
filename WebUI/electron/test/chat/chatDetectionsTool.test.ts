import { describe, expect, it, vi } from 'vitest'

// A 2x2 bitmap stands in for a decoded image: nativeImage is Electron's, and
// the overlay only needs a size and a BGRA buffer to write into.
const bitmap = Buffer.alloc(4 * 4, 0)
const toPNGMock = vi.fn(() => Buffer.from('PNGBYTES'))
const createFromBitmapMock = vi.fn(() => ({ toPNG: toPNGMock }))
let decodedEmpty = false
vi.mock('electron', () => ({
  nativeImage: {
    createFromDataURL: () => ({
      isEmpty: () => decodedEmpty,
      getSize: () => ({ width: 2, height: 2 }),
      toBitmap: () => bitmap,
    }),
    createFromBitmap: (...args: unknown[]) => createFromBitmapMock(...(args as [])),
  },
}))
vi.mock('../../kernel/kernelBus', () => ({ emitActivity: vi.fn() }))

const { executeChatDetectionsTool, validateDetections } =
  await import('../../chat/chatDetectionsTool')
const { textWidth } = await import('../../chat/detectionOverlay')

const readMediaAsDataUri = vi.fn(async () => 'data:image/png;base64,QQ==')

const imageTurn = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'what is in this?' },
      { type: 'file', mediaType: 'image/png', data: new Uint8Array([65]) },
    ],
  },
] as never

describe('validateDetections', () => {
  it('rejects an empty list', () => {
    expect(() => validateDetections({ detections: [] })).toThrow(/At least one detection/)
  })

  it('rejects a box that is not four numbers', () => {
    expect(() =>
      validateDetections({ detections: [{ label: 'cat', location: [1, 2, 3] }] }),
    ).toThrow(/4 numbers/)
  })

  it('keeps a well-formed detection', () => {
    expect(
      validateDetections({ detections: [{ label: 'cat', location: [0, 0, 500, 500] }] }),
    ).toEqual([{ label: 'cat', location: [0, 0, 500, 500] }])
  })
})

describe('textWidth', () => {
  it('measures the bitmap font without a DOM', () => {
    // Three 5px glyphs plus two 1px gaps, at scale 2.
    expect(textWidth('cat', 2)).toBe(34)
    expect(textWidth('', 3)).toBe(0)
  })
})

describe('executeChatDetectionsTool', () => {
  it('annotates the turn image and returns a PNG data URL', async () => {
    decodedEmpty = false
    const result = await executeChatDetectionsTool({
      input: { detections: [{ label: 'cat', location: [100, 100, 900, 900] }] },
      conversationKey: 'conv-1',
      messages: imageTurn,
      readMediaAsDataUri,
    })

    expect(createFromBitmapMock).toHaveBeenCalledWith(expect.any(Buffer), { width: 2, height: 2 })
    expect(result.annotatedImageUrl).toBe(
      `data:image/png;base64,${Buffer.from('PNGBYTES').toString('base64')}`,
    )
  })

  it('throws when the conversation has no image', async () => {
    await expect(
      executeChatDetectionsTool({
        input: { detections: [{ label: 'cat', location: [0, 0, 1, 1] }] },
        conversationKey: 'conv-1',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] as never,
        readMediaAsDataUri,
      }),
    ).rejects.toThrow(/no image found in conversation/)
  })

  it('reports an undecodable image instead of writing past the buffer', async () => {
    decodedEmpty = true
    await expect(
      executeChatDetectionsTool({
        input: { detections: [{ label: 'cat', location: [0, 0, 1, 1] }] },
        conversationKey: 'conv-1',
        messages: imageTurn,
        readMediaAsDataUri,
      }),
    ).rejects.toThrow(/could not be decoded/)
    decodedEmpty = false
  })
})
