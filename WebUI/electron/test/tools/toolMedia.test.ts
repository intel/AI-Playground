import { describe, it, expect } from 'vitest'
import { extractToolMedia, MEDIA_TOOL_TYPES } from '@/assets/js/tools/toolMedia'

describe('extractToolMedia', () => {
  it('returns nothing until the tool part has produced output', () => {
    expect(
      extractToolMedia({
        type: 'tool-comfyUI',
        state: 'input-available',
        output: { images: [{ type: 'image', imageUrl: 'aipg-media://a.png' }] },
      }),
    ).toEqual([])
  })

  it('ignores non-media tools', () => {
    expect(
      extractToolMedia({
        type: 'tool-configureHomeAgent',
        state: 'output-available',
        output: { ok: true },
      }),
    ).toEqual([])
  })

  it('extracts ComfyUI image/video/model3d from output.images', () => {
    const items = extractToolMedia({
      type: 'tool-comfyUI',
      state: 'output-available',
      output: {
        images: [
          { type: 'image', imageUrl: 'aipg-media://a.png' },
          { type: 'video', videoUrl: 'aipg-media://b.mp4' },
          { type: 'model3d', model3dUrl: 'aipg-media://c.glb' },
        ],
      },
    })
    expect(items).toEqual([
      { kind: 'image', url: 'aipg-media://a.png' },
      { kind: 'video', url: 'aipg-media://b.mp4' },
      { kind: 'model3d', url: 'aipg-media://c.glb' },
    ])
  })

  it('handles the ComfyUI image-edit tool the same way', () => {
    expect(
      extractToolMedia({
        type: 'tool-comfyUiImageEdit',
        state: 'output-available',
        output: { images: [{ type: 'image', imageUrl: 'aipg-media://edited.png' }] },
      }),
    ).toEqual([{ kind: 'image', url: 'aipg-media://edited.png' }])
  })

  it('skips ComfyUI media entries missing their url', () => {
    expect(
      extractToolMedia({
        type: 'tool-comfyUI',
        state: 'output-available',
        output: { images: [{ type: 'image' }, { type: 'image', imageUrl: '  ' }] },
      }),
    ).toEqual([])
  })

  it('extracts the captured window image from captureScreenshot', () => {
    expect(
      extractToolMedia({
        type: 'tool-captureScreenshot',
        state: 'output-available',
        output: { ok: true, message: 'done', dataUri: 'data:image/png;base64,AAA' },
      }),
    ).toEqual([{ kind: 'image', url: 'data:image/png;base64,AAA' }])
  })

  it('does not ship a failed captureScreenshot', () => {
    expect(
      extractToolMedia({
        type: 'tool-captureScreenshot',
        state: 'output-available',
        output: { ok: false, message: 'no window selected' },
      }),
    ).toEqual([])
  })

  it('extracts the page capture from screenshotWebPage', () => {
    expect(
      extractToolMedia({
        type: 'tool-screenshotWebPage',
        state: 'output-available',
        output: { ok: true, message: 'done', dataUri: 'data:image/png;base64,BBB' },
      }),
    ).toEqual([{ kind: 'image', url: 'data:image/png;base64,BBB' }])
  })

  it('extracts the annotated image from visualizeObjectDetections', () => {
    expect(
      extractToolMedia({
        type: 'tool-visualizeObjectDetections',
        state: 'output-available',
        output: { annotatedImageUrl: 'data:image/png;base64,CCC' },
      }),
    ).toEqual([{ kind: 'image', url: 'data:image/png;base64,CCC' }])
  })

  it('exposes the set of media-producing tool types', () => {
    expect(MEDIA_TOOL_TYPES.has('tool-visualizeObjectDetections')).toBe(true)
    expect(MEDIA_TOOL_TYPES.has('tool-screenshotWebPage')).toBe(true)
    expect(MEDIA_TOOL_TYPES.has('tool-comfyUI')).toBe(true)
    expect(MEDIA_TOOL_TYPES.has('tool-browseWeb')).toBe(false)
  })
})
