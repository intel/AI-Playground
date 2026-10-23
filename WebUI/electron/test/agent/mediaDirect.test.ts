import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import type { AgentToolSpec } from '@/types/agentIpc'
import type { ComfyUiPreset } from '@/lib/presetSchemas'
import type { ArtifactRunResult } from '../../artifact/runner'

// The in-process direct media tools (capabilities/mediaDirect.ts) turn a
// model's tool call into an artifact-runner payload: workflow from main's
// catalog, variant preference, size vocabulary → WxH, edit source injection,
// GPU occupancy and queueing. The runner and the GPU swap are mocked at their
// module seams; the catalog provider is set per test with a realistic preset.

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => os.tmpdir()) },
  BrowserWindow: class {},
  net: {},
}))

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../agent/piRuntime.ts', () => ({
  loadPi: async () => ({ defineTool: (definition: unknown) => definition }),
}))

const submitArtifactRunMock =
  vi.fn<(payload: unknown, options?: unknown) => Promise<ArtifactRunResult>>()
const cancelArtifactRunMock = vi.fn<(runId: string) => void>()
vi.mock('../../kernel/orchestrator.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../kernel/orchestrator.ts')>()
  return {
    ...actual,
    submitArtifactRun: submitArtifactRunMock,
    cancelArtifactRun: cancelArtifactRunMock,
  }
})

const { buildDirectMediaTools, setMediaCatalogProvider, resetMediaCatalogProviderForTest } =
  await import('../../agent/capabilities/mediaDirect.ts')

const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-direct-'))

function comfyPresetFixture(overrides: Partial<ComfyUiPreset> & { name: string }): ComfyUiPreset {
  return {
    type: 'comfy',
    backend: 'comfyui',
    category: 'create-images',
    toolCategory: 'create-images',
    settings: [
      {
        type: 'model',
        label: 'Checkpoint',
        nodeTitle: 'CheckpointLoaderSimple',
        nodeInput: 'ckpt_name',
        displayed: true,
        modifiable: true,
        modelType: 'checkpoints',
        optional: true,
      },
      {
        type: 'image',
        label: 'Source',
        nodeTitle: 'LoadImage',
        nodeInput: 'image',
        displayed: true,
        modifiable: true,
        defaultValue: '',
      },
    ],
    comfyUiApiWorkflow: {},
    ...overrides,
  } as unknown as ComfyUiPreset
}

const PRESETS: ComfyUiPreset[] = [
  comfyPresetFixture({
    name: 'Draft Image',
    variants: [
      { name: 'Standard', overrides: { description: 'standard variant' } },
      { name: 'Fast', overrides: { description: 'fast variant' } },
    ],
  }),
  comfyPresetFixture({ name: 'Edit By Prompt', toolCategory: 'edit-images' }),
]

function installCatalog() {
  setMediaCatalogProvider(async () => ({
    comfy: new Map(PRESETS.map((preset) => [preset.name, preset])),
    chat: new Map(),
  }))
}

function hostWith(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-1',
    workspaceDir,
    toolSpecs: [] as AgentToolSpec[],
    agentDir: workspaceDir,
    keepModelsLoaded: false,
    ...overrides,
  }
}

const GENERATE_SPEC: AgentToolSpec = {
  name: 'generateImage',
  description: 'generate an image',
  inputSchema: { type: 'object' },
  defaultWorkflow: 'Draft Image',
}

const EDIT_SPEC: AgentToolSpec = {
  name: 'editImage',
  description: 'edit an image',
  inputSchema: { type: 'object' },
  workspacePathInputs: ['sourceImagePath'],
}

type BuiltTool = {
  name: string
  execute: (id: string, params: unknown, signal: AbortSignal) => Promise<unknown>
}

async function buildTool(spec: AgentToolSpec, host = hostWith()): Promise<BuiltTool> {
  const [tool] = (await buildDirectMediaTools(host, [spec])) as unknown as BuiltTool[]
  return tool
}

function completedResult(payload: Record<string, unknown>): ArtifactRunResult {
  // In-process runs ship no pre-registered items; the runner builds one per
  // batch entry — simulate that here.
  const count = ((payload.items as unknown[]) ?? []).length || 1
  return {
    state: 'completed',
    items: Array.from({ length: count }, (_, i) => ({
      id: `item-${i}`,
      type: 'image',
      imageUrl: `test://item-${i}.png`,
      mode: 'imageGen',
      state: 'done',
      settings: { seed: i },
    })) as ArtifactRunResult['items'],
  }
}

/** The tools answer with jsonResult: a text part carrying the JSON payload. */
function parseOutput(output: unknown): Record<string, unknown> {
  const result = output as { content: Array<{ text: string }> }
  return JSON.parse(result.content[0].text)
}

let lastPayload: Record<string, unknown>

describe('mediaDirect (in-process generateImage / editImage)', () => {
  beforeEach(() => {
    resetMediaCatalogProviderForTest()
    installCatalog()
    lastPayload = {} as Record<string, unknown>
    submitArtifactRunMock.mockReset().mockImplementation(async (payload) => {
      lastPayload = payload as Record<string, unknown>
      return completedResult(payload as Record<string, unknown>)
    })
    cancelArtifactRunMock.mockReset()
  })

  it('falls back to the spec default workflow, and prefers a requested one', async () => {
    const tool = await buildTool(GENERATE_SPEC)
    await tool.execute('call-1', { prompt: 'a castle' }, new AbortController().signal)
    expect((lastPayload.preset as ComfyUiPreset).name).toBe('Draft Image')

    await tool.execute(
      'call-2',
      { workflow: 'Edit By Prompt', prompt: 'x' },
      new AbortController().signal,
    )
    expect((lastPayload.preset as ComfyUiPreset).name).toBe('Edit By Prompt')
  })

  it('prefers the Fast variant unless an explicit valid one is requested', async () => {
    const tool = await buildTool(GENERATE_SPEC)
    await tool.execute('call-1', { prompt: 'a castle' }, new AbortController().signal)
    expect((lastPayload.preset as ComfyUiPreset).description).toBe('fast variant')

    await tool.execute(
      'call-2',
      { prompt: 'a castle', variant: 'Standard' },
      new AbortController().signal,
    )
    expect((lastPayload.preset as ComfyUiPreset).description).toBe('standard variant')
  })

  it('maps the size vocabulary onto concrete dimensions', async () => {
    const tool = await buildTool(GENERATE_SPEC)
    await tool.execute(
      'call-1',
      { prompt: 'x', aspectRatio: '16/9', megapixels: '1.0' },
      new AbortController().signal,
    )
    // The default config's lookup table: the 1.0 MP tier at 16/9 is 1376x768.
    expect(lastPayload.params).toMatchObject({ width: 1376, height: 768 })

    await tool.execute(
      'call-2',
      { prompt: 'x', resolution: '1024x1024' },
      new AbortController().signal,
    )
    expect(lastPayload.params).toMatchObject({ width: 1024, height: 1024 })

    // No size named: the mapping leaves the fallback square default.
    await tool.execute('call-3', { prompt: 'x' }, new AbortController().signal)
    expect(lastPayload.params).toMatchObject({ width: 512, height: 512 })
  })

  it('bypasses an empty optional model input and leaves set ones alone', async () => {
    const tool = await buildTool(GENERATE_SPEC)
    await tool.execute('call-1', { prompt: 'x' }, new AbortController().signal)

    const inputs = lastPayload.inputs as Array<{ nodeTitle: string; current: unknown }>
    const checkpoint = inputs.find((input) => input.nodeTitle === 'CheckpointLoaderSimple')!
    expect(checkpoint.current).toBe('None')
  })

  it('injects the edit source into the first required image input and pins batch 1', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'source.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
    const tool = await buildTool(EDIT_SPEC)

    const output = parseOutput(
      await tool.execute(
        'call-1',
        { workflow: 'Edit By Prompt', prompt: 'make it blue', sourceImagePath: 'source.png' },
        new AbortController().signal,
      ),
    )

    const inputs = lastPayload.inputs as Array<{ nodeTitle: string; current: unknown }>
    const imageInput = inputs.find((input) => input.nodeTitle === 'LoadImage')!
    expect(String(imageInput.current)).toMatch(/^data:image\/png;base64,/)
    expect(lastPayload.source).toMatch(/^data:image\/png;base64,/)
    expect(lastPayload.mode).toBe('imageEdit')
    expect(lastPayload.params).toMatchObject({ batchSize: 1 })
    expect(output.images).toHaveLength(1)
  })

  it('queues behind other runs and carries the host setting on the payload', async () => {
    const host = hostWith({ keepModelsLoaded: true })
    const tool = await buildTool(GENERATE_SPEC, host)
    await tool.execute('call-1', { prompt: 'x' }, new AbortController().signal)

    expect(submitArtifactRunMock).toHaveBeenCalledTimes(1)
    expect(submitArtifactRunMock.mock.calls[0][1]).toEqual({ queue: 'queue' })
    expect(lastPayload.keepModelsLoaded).toBe(true)
    expect(lastPayload.variant).toBe('Fast')
    expect(lastPayload.origin).toBe('agent')
    expect(lastPayload.owner).toEqual({ kind: 'tool', toolCallId: 'call-1' })
    // The awaiting turn occupies the GPU as text under this key; without it the
    // run waits for its own parent and never starts.
    expect(lastPayload.conversationKey).toBe('session-1')
    // In-process runs leave consent to the runner: the flag stays unset.
    expect(lastPayload.modelsConsented).toBeUndefined()
    expect(lastPayload.items).toBeUndefined()
  })

  it('reports an unavailable workflow without submitting', async () => {
    const tool = await buildTool(GENERATE_SPEC)
    const output = parseOutput(
      await tool.execute('call-1', { workflow: 'Nope', prompt: 'x' }, new AbortController().signal),
    )

    expect(output).toMatchObject({
      success: false,
      message: expect.stringContaining('not available'),
    })
    expect(submitArtifactRunMock).not.toHaveBeenCalled()
  })

  it('shapes a failed run as a tool failure message', async () => {
    submitArtifactRunMock.mockResolvedValueOnce({
      state: 'failed',
      items: [],
      error: 'backend died',
    })
    const tool = await buildTool(GENERATE_SPEC)
    const output = parseOutput(
      await tool.execute('call-1', { prompt: 'x' }, new AbortController().signal),
    )
    expect(output).toMatchObject({
      success: false,
      message: expect.stringContaining('backend died'),
      images: [],
    })
  })

  it('cancels by run id when the model aborts mid-run', async () => {
    let resolveRun!: (result: ArtifactRunResult) => void
    submitArtifactRunMock.mockImplementationOnce((payload) => {
      lastPayload = payload as Record<string, unknown>
      return new Promise<ArtifactRunResult>((resolve) => {
        resolveRun = resolve
      })
    })
    const controller = new AbortController()
    const tool = await buildTool(GENERATE_SPEC)
    const pending = tool.execute('call-1', { prompt: 'x' }, controller.signal)
    await vi.waitFor(() => expect(submitArtifactRunMock).toHaveBeenCalled())

    controller.abort()
    expect(cancelArtifactRunMock).toHaveBeenCalledTimes(1)
    expect(cancelArtifactRunMock).toHaveBeenCalledWith(lastPayload.runId)

    resolveRun({ state: 'cancelled', items: [] })
    const output = parseOutput(await pending)
    expect(output).toMatchObject({ success: false, message: 'Generation cancelled.' })
  })

  it('resolves cancelled without submitting when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const tool = await buildTool(GENERATE_SPEC)

    const output = parseOutput(await tool.execute('call-1', { prompt: 'x' }, controller.signal))
    expect(output).toMatchObject({ success: false, message: 'Generation cancelled.' })
    expect(submitArtifactRunMock).not.toHaveBeenCalled()
  })
})
