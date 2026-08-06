import { ComfyUIApiWorkflow } from './presets'
import { modelNameForComfyApi } from './imageGenerationPresets'
import { findKeysByClassType } from './comfyUiWorkflowHelpers'

const OVMS_IMAGE_CLASS_TYPES = ['OpenAICompatibleImageGeneration', 'OpenAICompatibleImageEdit']

export function workflowUsesOvmsImage(workflow: ComfyUIApiWorkflow): boolean {
  return OVMS_IMAGE_CLASS_TYPES.some((ct) => findKeysByClassType(workflow, ct).length > 0)
}

export function injectOvmsImageUrl(workflow: ComfyUIApiWorkflow, url: string): void {
  for (const classType of OVMS_IMAGE_CLASS_TYPES) {
    for (const key of findKeysByClassType(workflow, classType)) {
      const inputs = workflow[key]?.inputs
      if (!inputs || typeof inputs !== 'object') continue
      if ('base_url' in inputs) {
        inputs['base_url'] = url
      }
      // OVMS registers the served graph under the slash-flattened repo id
      // (see `--source_model` in openVINOBackendService.ts), so the model
      // sent in the OpenAI-compatible request must use the same form.
      if ('model' in inputs && typeof inputs['model'] === 'string') {
        inputs['model'] = inputs['model'].split('/').join('---')
      }
    }
  }
}

/** ComfyUI node input names that hold model/file paths; separator is OS-dependent (see main.ts preset handling). */
const COMFY_MODEL_PATH_INPUTS = new Set([
  'ckpt_name',
  'lora_name',
  'text_encoder',
  'vae_name',
  'unet_name',
  'clip_name',
  'model_name',
  'control_net_name',
])

export function normalizeModelPathsInWorkflow(
  workflow: ComfyUIApiWorkflow,
  platform: NodeJS.Platform,
): void {
  for (const node of Object.values(workflow)) {
    const inputs = (node as { inputs?: Record<string, unknown> }).inputs
    if (!inputs) continue
    for (const [inputName, value] of Object.entries(inputs)) {
      if (COMFY_MODEL_PATH_INPUTS.has(inputName) && typeof value === 'string') {
        inputs[inputName] = modelNameForComfyApi(value, platform)
      }
    }
  }
}

/**
 * Bypass a node by rewiring its outputs to its upstream and removing the node.
 * Supported: LoraLoader (output 0 = model from input "model", output 1 = clip from input "clip").
 */
export function bypassNode(workflow: ComfyUIApiWorkflow, nodeId: string): void {
  const node = workflow[nodeId] as
    | { class_type?: string; inputs?: Record<string, unknown> }
    | undefined
  if (!node?.inputs) return
  const classType = node.class_type
  let rewire: [number, [string, number]][]
  if (classType === 'LoraLoader') {
    const model = node.inputs.model as [string, number] | undefined
    const clip = node.inputs.clip as [string, number] | undefined
    if (!model || !clip) return
    rewire = [
      [0, model],
      [1, clip],
    ]
  } else {
    return
  }
  for (const entry of Object.values(workflow)) {
    const inputs = (entry as { inputs?: Record<string, unknown> }).inputs
    if (!inputs) continue
    for (const key of Object.keys(inputs)) {
      const v = inputs[key]
      if (
        Array.isArray(v) &&
        v.length === 2 &&
        typeof v[0] === 'string' &&
        typeof v[1] === 'number'
      ) {
        if (v[0] === nodeId) {
          const slot = v[1]
          const upstream = rewire.find(([s]) => s === slot)?.[1]
          if (upstream) inputs[key] = upstream
        }
      }
    }
  }
  delete workflow[nodeId]
}
