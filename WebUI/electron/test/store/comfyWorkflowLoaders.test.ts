import { describe, expect, it } from 'vitest'

import { loaderModelNames, nodeTitle } from '@/assets/js/store/comfyUiWorkflowHelpers'
import type { ComfyUIApiWorkflow } from '@/assets/js/store/presets'

/**
 * What a `comfyui.load_model` span says it is loading. The loader classes agree
 * on nothing except that the file is named in a `*_name` input.
 */
const workflow = {
  '4': {
    class_type: 'CheckpointLoaderSimple',
    _meta: { title: 'Load Checkpoint' },
    inputs: { ckpt_name: 'sdxl_turbo.safetensors' },
  },
  '11': {
    class_type: 'DualCLIPLoader (GGUF)',
    _meta: { title: 'DualCLIPLoader' },
    inputs: { clip_name1: 't5.gguf', clip_name2: 'clip_l.safetensors', type: 'flux' },
  },
  '12': {
    class_type: 'Unet Loader (GGUF)',
    inputs: { unet_name: 'flux-dev-Q4.gguf' },
  },
  '13': {
    class_type: 'KSampler',
    _meta: { title: 'KSampler' },
    inputs: { steps: 8, model: ['4', 0] },
  },
} as unknown as ComfyUIApiWorkflow

describe('loader nodes as a span describes them', () => {
  it('names the model file a loader was pointed at', () => {
    expect(loaderModelNames(workflow, '4')).toEqual(['sdxl_turbo.safetensors'])
    expect(loaderModelNames(workflow, '12')).toEqual(['flux-dev-Q4.gguf'])
  })

  it('keeps both files of a dual loader, in the order it lists them', () => {
    expect(loaderModelNames(workflow, '11')).toEqual(['t5.gguf', 'clip_l.safetensors'])
  })

  it('finds nothing to name on a node that loads nothing', () => {
    expect(loaderModelNames(workflow, '13')).toEqual([])
    expect(loaderModelNames(workflow, 'missing')).toEqual([])
  })

  it('falls back to no title rather than inventing one', () => {
    expect(nodeTitle(workflow, '4')).toBe('Load Checkpoint')
    expect(nodeTitle(workflow, '12')).toBeUndefined()
    expect(nodeTitle(workflow, 'missing')).toBeUndefined()
  })
})
