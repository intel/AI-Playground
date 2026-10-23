import { describe, expect, it } from 'vitest'
import { condenseMediaAgentRun, slimCondensedMedia } from '@/lib/mediaAgentResult'

describe('condenseMediaAgentRun', () => {
  it('flattens inner tool images and keeps the specialist summary', () => {
    const result = condenseMediaAgentRun({
      text: 'Made a castle.',
      steps: [
        {
          toolName: 'comfyUI',
          input: { workflow: 'Draft Image' },
          output: {
            images: [{ id: '1', type: 'image', imageUrl: 'aipg-media://a.png', mode: 'imageGen' }],
          },
        },
      ],
    })
    expect(result.summary).toBe('Made a castle.')
    expect(result.images).toHaveLength(1)
    expect(result.steps[0]).toContain('Draft Image')
    expect(slimCondensedMedia(result).images).toEqual([
      { id: '1', type: 'image', imageUrl: 'aipg-media://a.png' },
    ])
  })

  it('reports the last inner failure when nothing was produced', () => {
    const result = condenseMediaAgentRun({
      text: '',
      steps: [
        {
          toolName: 'comfyUI',
          input: { workflow: 'W1' },
          output: { success: false, message: 'backend died', images: [] },
        },
      ],
    })
    expect(result).toMatchObject({
      success: false,
      message: 'backend died',
      images: [],
    })
  })

  it('unwraps a nested tool-result envelope', () => {
    const result = condenseMediaAgentRun({
      text: '',
      steps: [
        {
          toolName: 'comfyUI',
          input: { workflow: 'Draft Image' },
          output: {
            type: 'tool-result',
            output: {
              images: [
                { id: '1', type: 'image', imageUrl: 'aipg-media://a.png', mode: 'imageGen' },
              ],
            },
          },
        },
      ],
    })
    expect(result.images).toHaveLength(1)
    expect(result.success).toBeUndefined()
  })

  it('unwraps a json tool-output envelope', () => {
    const result = condenseMediaAgentRun({
      text: '',
      steps: [
        {
          toolName: 'comfyUI',
          input: { workflow: 'Draft Image' },
          output: {
            type: 'json',
            value: {
              images: [
                { id: '1', type: 'image', imageUrl: 'aipg-media://a.png', mode: 'imageGen' },
              ],
            },
          },
        },
      ],
    })
    expect(result.images).toHaveLength(1)
  })
})
