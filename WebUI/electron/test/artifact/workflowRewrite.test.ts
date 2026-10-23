import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  nativeImage: {
    // Decodes and re-encodes through Chromium; the fake emits a fixed PNG body
    // so hash naming is deterministic.
    createFromDataURL: vi.fn(() => ({ isEmpty: () => false, toPNG: () => Buffer.from('PNG') })),
  },
}))

import {
  modifyDynamicSettingsInWorkflow,
  reencodeImageTo8BitPng,
  rewriteWorkflowForRun,
  validateRequiredImageInputs,
  type ArtifactRunInput,
} from '../../artifact/workflowRewrite'
import type { ComfyUiPreset } from '@/lib/presetSchemas'

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/** zod fills displayed/modifiable with defaults; input literals here do the same. */
function input(
  overrides: Partial<ArtifactRunInput> &
    Pick<ArtifactRunInput, 'type' | 'label' | 'nodeTitle' | 'nodeInput' | 'current'>,
): ArtifactRunInput {
  return { displayed: true, modifiable: true, ...overrides } as ArtifactRunInput
}

function trackingDeps() {
  const uploads: { name: string; blob: Blob; subfolder?: string }[] = []
  return {
    uploads,
    deps: {
      readMediaAsDataUri: vi.fn(async () => PNG_1PX),
      uploadInputFile: vi.fn(async (file: { name: string; blob: Blob }) => {
        uploads.push(file)
      }),
    },
  }
}

function testPreset(): ComfyUiPreset {
  return JSON.parse(
    JSON.stringify({
      type: 'comfy',
      name: 'Rewrite Test',
      backend: 'comfyui',
      category: 'create-images',
      toolCategory: 'create-images',
      mediaType: 'image',
      requiredCustomNodes: [],
      requiredPythonPackages: [],
      requiredModels: [],
      settings: [],
      comfyUiApiWorkflow: {
        '1': {
          class_type: 'EmptyImage',
          inputs: { width: 512, height: 512, batch_size: 1, color: 1 },
          _meta: { title: 'Empty Image' },
        },
        '2': {
          class_type: 'SaveImage',
          inputs: { filename_prefix: 'AIPG', images: ['1', 0] },
          _meta: { title: 'Save Image' },
        },
      },
    }),
  )
}

describe('validateRequiredImageInputs', () => {
  const imageInput = (overrides: Partial<ArtifactRunInput>): ArtifactRunInput =>
    input({
      type: 'image',
      label: 'Reference Image',
      nodeTitle: 'Load Image',
      nodeInput: 'image',
      defaultValue: '',
      current: '',
      ...overrides,
    })

  it('flags required image inputs without a value', () => {
    expect(validateRequiredImageInputs([imageInput({})])).toEqual(['Reference Image'])
  })

  it('accepts a valid image url, optional empties, and hidden or defaulted inputs', () => {
    expect(
      validateRequiredImageInputs([
        imageInput({ current: 'aipg-media://media/x.png' }),
        imageInput({ optional: true }),
        imageInput({ displayed: false }),
        imageInput({ defaultValue: 'aipg-media://media/y.png' }),
      ]),
    ).toEqual([])
  })
})

describe('modifyDynamicSettingsInWorkflow', () => {
  it('substitutes scalar and model values into the node inputs', async () => {
    const workflow = testPreset().comfyUiApiWorkflow
    const inputs: ArtifactRunInput[] = [
      input({
        type: 'number',
        label: 'Colour',
        nodeTitle: 'Empty Image',
        nodeInput: 'color',
        current: 42,
      }),
      input({
        type: 'model',
        label: 'Model',
        nodeTitle: 'Empty Image',
        nodeInput: 'color',
        current: 'models/flux/schnell.gguf',
      }),
    ]
    await modifyDynamicSettingsInWorkflow(workflow, 'win32', inputs, trackingDeps().deps)
    // Model names are converted to the platform separator for the ComfyUI API.
    expect(workflow['1']!.inputs!.color).toBe('models\\flux\\schnell.gguf')
  })

  it('uploads image inputs under their content hash and rewrites the node input', async () => {
    const workflow = testPreset().comfyUiApiWorkflow
    const { deps, uploads } = trackingDeps()
    const inputs: ArtifactRunInput[] = [
      input({
        type: 'image',
        label: 'Ref',
        nodeTitle: 'Empty Image',
        nodeInput: 'color',
        current: PNG_1PX,
      }),
    ]
    await modifyDynamicSettingsInWorkflow(workflow, 'darwin', inputs, deps)
    expect(uploads).toHaveLength(1)
    expect(uploads[0].name.endsWith('.png')).toBe(true)
    // The re-encoded PNG body is deterministic, so is its hash name.
    const expectedName = `${createHash('sha256').update('data:image/png;base64,UE5H', 'utf-8').digest('hex')}.png`
    expect(uploads[0].name).toBe(expectedName)
    expect(workflow['1']!.inputs!.color).toBe(expectedName)
  })

  it('resolves aipg-media input values through the media reader and skips None models', async () => {
    const workflow = testPreset().comfyUiApiWorkflow
    const { deps, uploads } = trackingDeps()
    const inputs: ArtifactRunInput[] = [
      input({
        type: 'image',
        label: 'Ref',
        nodeTitle: 'Empty Image',
        nodeInput: 'color',
        current: 'aipg-media://media/source.png',
      }),
      input({
        type: 'model',
        label: 'LoRA',
        nodeTitle: 'Empty Image',
        nodeInput: 'color',
        optional: true,
        current: 'None',
      }),
    ]
    await modifyDynamicSettingsInWorkflow(workflow, 'darwin', inputs, deps)
    expect(deps.readMediaAsDataUri).toHaveBeenCalledWith('aipg-media://media/source.png')
    expect(uploads).toHaveLength(1)
  })

  it('uploads video inputs named by hash and source mime extension', async () => {
    const workflow = testPreset().comfyUiApiWorkflow
    const { deps, uploads } = trackingDeps()
    const videoUri = 'data:video/mp4;base64,AAAA'
    await modifyDynamicSettingsInWorkflow(
      workflow,
      'darwin',
      [
        input({
          type: 'video',
          label: 'Clip',
          nodeTitle: 'Empty Image',
          nodeInput: 'color',
          current: videoUri,
        }),
      ],
      deps,
    )
    expect(uploads).toHaveLength(1)
    expect(uploads[0].name.endsWith('.mp4')).toBe(true)
  })
})

describe('rewriteWorkflowForRun', () => {
  it('applies scalar settings, clones the preset workflow, and bypasses a None LoRA', async () => {
    const preset = testPreset()
    preset.comfyUiApiWorkflow['3'] = {
      class_type: 'LoraLoader',
      inputs: { model: ['1', 0], clip: ['1', 1] },
      _meta: { title: 'Optional LoRA' },
    }
    preset.comfyUiApiWorkflow['4'] = {
      class_type: 'EmptyImage',
      inputs: { width: 1, height: 1, batch_size: 1, color: 1 },
      _meta: { title: 'After' },
    }
    // Route SaveImage through the LoRA so the bypass has a link to rewire.
    preset.comfyUiApiWorkflow['2'].inputs!.images = ['3', 0]

    const { deps } = trackingDeps()
    const workflow = await rewriteWorkflowForRun(
      preset,
      { prompt: 'a cat', negativePrompt: 'nsfw', inferenceSteps: 8, width: 640, height: 480 },
      [
        input({
          type: 'model',
          label: 'LoRA',
          nodeTitle: 'Optional LoRA',
          nodeInput: 'lora',
          optional: true,
          current: 'None',
        }),
      ],
      'darwin',
      null,
      deps,
    )

    expect(workflow['1']!.inputs!.width).toBe(640)
    expect(workflow['1']!.inputs!.height).toBe(480)
    // The LoRA node is gone and SaveImage now points at its upstream.
    expect(workflow['3']).toBeUndefined()
    expect(workflow['2']!.inputs!.images).toEqual(['1', 0])
    // The preset's own workflow object is untouched.
    expect(preset.comfyUiApiWorkflow['1'].inputs!.width).toBe(512)
    expect(preset.comfyUiApiWorkflow['2'].inputs!.images).toEqual(['3', 0])
  })
})

describe('reencodeImageTo8BitPng', () => {
  it('returns the original data uri when the image cannot be decoded', async () => {
    const { nativeImage } = await import('electron')
    vi.mocked(nativeImage.createFromDataURL).mockReturnValueOnce({ isEmpty: () => true } as never)
    expect(reencodeImageTo8BitPng(PNG_1PX)).toBe(PNG_1PX)
  })
})
