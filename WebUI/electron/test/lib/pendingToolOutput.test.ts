import { describe, expect, it } from 'vitest'
import type { UIMessageChunk } from 'ai'
import { fillToolResultOutput, patchUiToolOutputs, settleToolOutput } from '@/lib/pendingToolOutput'

describe('settleToolOutput', () => {
  it('returns a present output without waiting', async () => {
    const pending = new Map<string, Promise<unknown>>([['c1', Promise.resolve({ images: [1] })]])
    await expect(settleToolOutput(pending, 'c1', { images: [0] })).resolves.toEqual({
      images: [0],
    })
  })

  it('awaits the pending execute when the SDK recorded null', async () => {
    const pending = new Map<string, Promise<unknown>>([
      ['c1', new Promise((resolve) => setTimeout(() => resolve({ images: [1] }), 40))],
    ])
    await expect(settleToolOutput(pending, 'c1', null)).resolves.toEqual({ images: [1] })
  })
})

describe('fillToolResultOutput', () => {
  it('mutates a tool-result so the next model step sees the real output', async () => {
    const pending = new Map<string, Promise<unknown>>([
      ['c1', Promise.resolve({ images: [{ id: 'i1' }] })],
    ])
    const toolOutput = { type: 'tool-result', output: undefined as unknown }
    await fillToolResultOutput(pending, 'c1', toolOutput)
    expect(toolOutput.output).toEqual({ images: [{ id: 'i1' }] })
  })
})

describe('patchUiToolOutputs', () => {
  it('replaces a null tool-output-available chunk after execute settles', async () => {
    const pending = new Map<string, Promise<unknown>>([
      ['c1', new Promise((resolve) => setTimeout(() => resolve({ images: [1] }), 40))],
    ])
    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        controller.enqueue({
          type: 'tool-output-available',
          toolCallId: 'c1',
          output: null,
        } as UIMessageChunk)
        controller.close()
      },
    })
    const chunks: UIMessageChunk[] = []
    for await (const chunk of patchUiToolOutputs(stream, pending)) chunks.push(chunk)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      type: 'tool-output-available',
      toolCallId: 'c1',
      output: { images: [1] },
    })
  })
})
