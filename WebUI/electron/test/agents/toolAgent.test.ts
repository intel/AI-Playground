import { describe, expect, it } from 'vitest'
import { tool, type ModelMessage } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { simulateReadableStream } from 'ai'
import { z } from 'zod'
import { createToolAgent, type ToolAgentEvent } from '@/assets/js/agents/toolAgent'

// Unit tests for the nested tool-agent factory (streamText tool loop).
// A scripted mock model drives the loop; the assertions cover the properties
// the media agent relies on: step collection, the step cap, history-based
// chaining (a later tool sees earlier tool results in its message history),
// prior-message injection (the parent-provided source image), the progress
// events the UI timeline is built on, and error propagation.

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

type StreamPart = Record<string, unknown>

function stream(...parts: StreamPart[]) {
  return {
    stream: simulateReadableStream({
      chunks: [{ type: 'stream-start', warnings: [] }, ...parts] as never[],
      chunkDelayInMs: 0,
    }),
  }
}

function toolCallResponse(toolName: string, input: Record<string, unknown>, id: string) {
  return stream(
    { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
  )
}

function textResponse(text: string, reasoning?: string) {
  return stream(
    ...(reasoning
      ? [
          { type: 'reasoning-start', id: 'r0' },
          { type: 'reasoning-delta', id: 'r0', delta: reasoning },
          { type: 'reasoning-end', id: 'r0' },
        ]
      : []),
    { type: 'text-start', id: 't0' },
    { type: 'text-delta', id: 't0', delta: text },
    { type: 'text-end', id: 't0' },
    { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
  )
}

describe('createToolAgent', () => {
  it('executes tools and returns the final text plus collected steps', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++
        if (call === 1) return toolCallResponse('makeImage', { prompt: 'a castle' }, 'c1')
        return textResponse('Done: generated one image of a castle.')
      },
    })
    const makeImage = tool({
      inputSchema: z.object({ prompt: z.string() }),
      execute: async ({ prompt }) => ({
        images: [{ id: 'img1', type: 'image', imageUrl: 'aipg-media://castle.png', prompt }],
      }),
    })

    const agent = createToolAgent({
      name: 'testAgent',
      system: () => 'You are a test agent.',
      tools: () => ({ makeImage }),
    })
    const result = await agent.run({ model, request: 'make a castle image' })

    expect(result.text).toBe('Done: generated one image of a castle.')
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].toolName).toBe('makeImage')
    expect(result.steps[0].input).toEqual({ prompt: 'a castle' })
    expect(result.steps[0].output).toMatchObject({
      images: [{ imageUrl: 'aipg-media://castle.png' }],
    })
  })

  it('stops at the configured step cap without throwing', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => toolCallResponse('makeImage', { prompt: 'again' }, `c${++call}`),
    })
    const makeImage = tool({
      inputSchema: z.object({ prompt: z.string() }),
      execute: async () => ({ images: [] }),
    })

    const agent = createToolAgent({
      name: 'cappedAgent',
      system: () => 'sys',
      tools: () => ({ makeImage }),
      maxSteps: 3,
    })
    const result = await agent.run({ model, request: 'loop forever' })

    expect(result.steps).toHaveLength(3)
    expect(result.text).toBe('')
  })

  it('lets a later tool discover an earlier tool result in its message history (chaining)', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++
        if (call === 1) return toolCallResponse('generate', { prompt: 'a castle' }, 'c1')
        if (call === 2) return toolCallResponse('convertTo3d', {}, 'c2')
        return textResponse('Generated a castle image and converted it to a 3D model.')
      },
    })

    const generate = tool({
      inputSchema: z.object({ prompt: z.string() }),
      execute: async () => ({
        images: [{ id: 'g1', type: 'image', imageUrl: 'aipg-media://gen.png' }],
      }),
    })
    const editHistories: ModelMessage[][] = []
    const convertTo3d = tool({
      inputSchema: z.object({}),
      execute: async (_input, options) => {
        editHistories.push([...((options?.messages ?? []) as ModelMessage[])])
        return { images: [{ id: 'e1', type: 'model3d', model3dUrl: 'aipg-media://model.glb' }] }
      },
    })

    const agent = createToolAgent({
      name: 'chainAgent',
      system: () => 'sys',
      tools: () => ({ generate, convertTo3d }),
    })
    const result = await agent.run({ model, request: 'castle image, then 3D model' })

    expect(result.steps.map((s) => s.toolName)).toEqual(['generate', 'convertTo3d'])
    // The second tool's history must contain the first tool's result — this is
    // the mechanism the media agent's source-image discovery relies on.
    expect(editHistories).toHaveLength(1)
    const toolMessages = editHistories[0].filter((m) => m.role === 'tool')
    expect(JSON.stringify(toolMessages)).toContain('aipg-media://gen.png')
    expect(result.text).toContain('3D model')
  })

  it('places priorMessages (e.g. a source image) before the request', async () => {
    const prompts: unknown[] = []
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(options.prompt)
        return textResponse('ok')
      },
    })
    const agent = createToolAgent({
      name: 'sourceAgent',
      system: () => 'sys',
      tools: () => ({}),
    })
    const sourceMessage: ModelMessage = {
      role: 'user',
      content: [{ type: 'file', mediaType: 'image/png', data: 'data:image/png;base64,AAA=' }],
    }
    await agent.run({ model, request: 'edit the image', priorMessages: [sourceMessage] })

    expect(prompts).toHaveLength(1)
    const prompt = prompts[0] as Array<{ role: string; content: unknown }>
    const userMessages = prompt.filter((m) => m.role === 'user')
    expect(userMessages).toHaveLength(2)
    expect(JSON.stringify(userMessages[0].content)).toContain('image/png')
    expect(JSON.stringify(userMessages[1].content)).toContain('edit the image')
  })

  it('emits phase, narration and tool events while it runs', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++
        if (call === 1) return toolCallResponse('makeImage', { prompt: 'a castle' }, 'c1')
        return textResponse('All done.', 'Let me pick a workflow.')
      },
    })
    const makeImage = tool({
      inputSchema: z.object({ prompt: z.string() }),
      execute: async () => ({ images: [{ id: 'i1', type: 'image', imageUrl: 'x' }] }),
    })

    const events: ToolAgentEvent[] = []
    const agent = createToolAgent({
      name: 'eventAgent',
      system: () => 'sys',
      tools: () => ({ makeImage }),
    })
    await agent.run({ model, request: 'castle', onEvent: (event) => events.push(event) })

    const start = events.find((e) => e.type === 'tool-start')
    expect(start).toMatchObject({ toolCallId: 'c1', toolName: 'makeImage' })
    expect(start).toHaveProperty('input', { prompt: 'a castle' })
    expect(events.find((e) => e.type === 'tool-finish')).toMatchObject({
      toolCallId: 'c1',
      output: { images: [{ id: 'i1' }] },
    })
    // A tool call must be announced as running before its result arrives.
    expect(events.findIndex((e) => e.type === 'tool-start')).toBeLessThan(
      events.findIndex((e) => e.type === 'tool-finish'),
    )
    expect(events.filter((e) => e.type === 'phase').map((e) => e.phase)).toContain('running-tool')
    expect(
      events
        .filter((e) => e.type === 'narration-delta')
        .map((e) => e.text)
        .join(''),
    ).toContain('Let me pick a workflow.')
  })

  it('reports a failed tool call without throwing', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++
        if (call === 1) return toolCallResponse('makeImage', { prompt: 'boom' }, 'c1')
        return textResponse('Could not create the image.')
      },
    })
    const makeImage = tool({
      inputSchema: z.object({ prompt: z.string() }),
      // Annotated because an always-throwing execute infers `Promise<never>`,
      // which does not match the tool() overloads.
      execute: async (): Promise<{ images: unknown[] }> => {
        throw new Error('workflow exploded')
      },
    })

    const events: ToolAgentEvent[] = []
    const agent = createToolAgent({
      name: 'toolErrorAgent',
      system: () => 'sys',
      tools: () => ({ makeImage }),
    })
    const result = await agent.run({
      model,
      request: 'boom',
      onEvent: (event) => events.push(event),
    })

    expect(result.text).toBe('Could not create the image.')
    expect(events.find((e) => e.type === 'tool-finish')).toMatchObject({
      error: 'workflow exploded',
    })
  })

  it('lets a running tool see the abort, so it can stop work it started elsewhere', async () => {
    // The generation tools hand their work to ComfyUI and then wait. Cancelling
    // a turn only stops that render if the abort reaches the tool while it is
    // waiting — otherwise the backend keeps rendering for nobody.
    const stopButton = new AbortController()
    let interrupted = false
    const model = new MockLanguageModelV3({
      doStream: async () => toolCallResponse('makeImage', { prompt: 'a castle' }, 'c1'),
    })
    const makeImage = tool({
      inputSchema: z.object({ prompt: z.string() }),
      execute: async (_args, { abortSignal }): Promise<{ images: unknown[] }> =>
        await new Promise((resolve) => {
          abortSignal?.addEventListener('abort', () => {
            interrupted = true
            resolve({ images: [] })
          })
          setTimeout(() => stopButton.abort(), 0)
        }),
    })

    const agent = createToolAgent({
      name: 'abortAgent',
      system: () => 'sys',
      tools: () => ({ makeImage }),
    })
    await agent
      .run({ model, request: 'make a castle image', abortSignal: stopButton.signal })
      .catch(() => undefined)

    expect(interrupted).toBe(true)
  })

  it('rethrows a stream error instead of resolving empty', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => stream({ type: 'error', error: new Error('context overflow') }),
    })
    const agent = createToolAgent({
      name: 'errorAgent',
      system: () => 'sys',
      tools: () => ({}),
    })

    await expect(agent.run({ model, request: 'anything' })).rejects.toThrow('context overflow')
  })
})
