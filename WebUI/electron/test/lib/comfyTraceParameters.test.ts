import { describe, expect, it } from 'vitest'

import { comfyTraceParameters, type ComfyRun } from '@/lib/comfyTraceParameters'

const IMAGE_DATA_URI = `data:image/png;base64,${'A'.repeat(400_000)}`

function run(overrides: Partial<ComfyRun> = {}): ComfyRun {
  return {
    preset: 'Line Art',
    mode: 'image-generation',
    mediaType: 'image',
    settings: {
      preset: 'Line Art',
      variant: 'fast',
      prompt: 'a lighthouse',
      negativePrompt: 'blurry',
      seed: 4711,
      inferenceSteps: 8,
      width: 1024,
      height: 1024,
      resolution: '1024x1024',
    },
    seed: 4711,
    batchSize: 2,
    keepModelsLoaded: false,
    ...overrides,
  }
}

describe('comfyTraceParameters', () => {
  it('keeps the curated attributes scalar, which is what Laminar can group by', () => {
    const { attributes } = comfyTraceParameters(run())
    for (const [key, value] of Object.entries(attributes)) {
      expect(['string', 'number', 'boolean'], key).toContain(typeof value)
    }
    expect(attributes).toMatchObject({
      'aipg.preset': 'Line Art',
      'aipg.variant': 'fast',
      'aipg.mode': 'image-generation',
      'aipg.media_type': 'image',
      'aipg.seed': 4711,
      'aipg.steps': 8,
      'aipg.width': 1024,
      'aipg.height': 1024,
      'aipg.resolution': '1024x1024',
      'aipg.batch_size': 2,
      'aipg.keep_models_loaded': false,
    })
  })

  it('reports the resolved seed, not the wildcard the user left in the settings', () => {
    const { attributes, input } = comfyTraceParameters(
      run({ settings: { ...run().settings, seed: -1 }, seed: 90210 }),
    )
    expect(attributes['aipg.seed']).toBe(90210)
    expect(input.seed).toBe(90210)
  })

  it('omits settings the preset filtered out instead of naming them empty', () => {
    const { attributes, input } = comfyTraceParameters(
      run({ settings: { preset: 'Colorize', prompt: '' } }),
    )
    expect(Object.keys(attributes)).not.toContain('aipg.steps')
    expect(Object.keys(attributes)).not.toContain('aipg.resolution')
    expect('negativePrompt' in input).toBe(false)
    // An empty prompt is a value, not a missing one.
    expect(input.prompt).toBe('')
  })

  it('describes an image input rather than shipping its bytes', () => {
    const traced = comfyTraceParameters(
      run({
        inputs: [
          { nodeTitle: 'Load Image', nodeInput: 'image', type: 'image', value: IMAGE_DATA_URI },
          { nodeTitle: 'Mask', nodeInput: 'mask', type: 'inpaintMask', value: '' },
        ],
      }),
    )
    const serialized = JSON.stringify(traced)
    expect(serialized).not.toContain('AAAA')
    expect(serialized.length).toBeLessThan(4000)
    const inputs = traced.input.inputs as Record<string, unknown>
    expect(inputs['Load Image.image']).toBe('<image/png, 293 KB>')
    expect(inputs['Mask.mask']).toBe('<none>')
  })

  it('keeps a short image reference verbatim, since that is what names the source', () => {
    const traced = comfyTraceParameters(
      run({
        hasSourceImage: true,
        inputs: [
          {
            nodeTitle: 'Load Image',
            nodeInput: 'image',
            type: 'image',
            value: 'aipg-media://AIPG_00042_.png',
          },
        ],
      }),
    )
    expect(traced.attributes['aipg.source_image']).toBe(true)
    expect((traced.input.inputs as Record<string, unknown>)['Load Image.image']).toBe(
      'aipg-media://AIPG_00042_.png',
    )
  })

  it('lists the model files the workflow was pointed at, ignoring an unset optional one', () => {
    const traced = comfyTraceParameters(
      run({
        inputs: [
          {
            nodeTitle: 'Checkpoint',
            nodeInput: 'ckpt_name',
            type: 'model',
            value: 'sdxl.safetensors',
          },
          { nodeTitle: 'LoRA', nodeInput: 'lora_name', type: 'model', value: 'None' },
          { nodeTitle: 'CLIP', nodeInput: 'clip_name', type: 'model', value: 'clip_l.gguf' },
        ],
      }),
    )
    expect(traced.attributes['aipg.models']).toBe('sdxl.safetensors, clip_l.gguf')
    // The unset one still shows in the full picture, where it means something.
    expect((traced.input.inputs as Record<string, unknown>)['LoRA.lora_name']).toBe('None')
  })

  it('caps a long value and says how long it was', () => {
    const traced = comfyTraceParameters(
      run({
        settings: { ...run().settings, prompt: 'p'.repeat(5000) },
        inputs: [{ nodeTitle: 'Style', nodeInput: 'text', type: 'string', value: 's'.repeat(900) }],
      }),
    )
    expect(traced.input.prompt).toMatch(/… \[5000 chars\]$/)
    expect(String(traced.input.prompt).length).toBeLessThan(2100)
    expect((traced.input.inputs as Record<string, unknown>)['Style.text']).toMatch(
      /… \[900 chars\]$/,
    )
  })

  it('does not trust a data URI that turns up in a non-image input', () => {
    const traced = comfyTraceParameters(
      run({
        inputs: [{ nodeTitle: 'Style', nodeInput: 'text', type: 'string', value: IMAGE_DATA_URI }],
      }),
    )
    expect(JSON.stringify(traced)).not.toContain('AAAA')
    expect((traced.input.inputs as Record<string, unknown>)['Style.text']).toBe(
      '<image/png, 293 KB>',
    )
  })

  it('keeps numbers and booleans as they are', () => {
    const traced = comfyTraceParameters(
      run({
        inputs: [
          { nodeTitle: 'Sampler', nodeInput: 'cfg', type: 'number', value: 3.5 },
          { nodeTitle: 'Sampler', nodeInput: 'add_noise', type: 'boolean', value: true },
        ],
      }),
    )
    const inputs = traced.input.inputs as Record<string, unknown>
    expect(inputs['Sampler.cfg']).toBe(3.5)
    expect(inputs['Sampler.add_noise']).toBe(true)
  })
})
