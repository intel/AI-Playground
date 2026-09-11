import type { ComfyUIApiWorkflow } from './presets'

/**
 * Pure helpers that read or mutate a ComfyUI API workflow dict. Extracted from
 * `comfyUiPresets.ts` so they can be unit-tested without dragging in Pinia /
 * Vue / Electron module-load side effects.
 */

export const settingToComfyInputsName = {
  seed: ['seed', 'noise_seed'],
  inferenceSteps: ['steps'],
  height: ['height'],
  width: ['width'],
  prompt: ['text'],
  negativePrompt: ['text'],
  batchSize: ['batch_size'],
} satisfies Partial<Record<string, string[]>>

export type ComfySetting = keyof typeof settingToComfyInputsName

export const findKeysByTitle = (
  workflow: ComfyUIApiWorkflow,
  title: ComfySetting | 'loader' | string,
) =>
  Object.entries(workflow)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter(([_key, value]) => (value as any)?.['_meta']?.title === title)
    .map(([key, _value]) => key)

/** The name the workflow gives a node, which is what a person recognizes it by. */
export const nodeTitle = (workflow: ComfyUIApiWorkflow, nodeId: string): string | undefined => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const title = (workflow[nodeId] as any)?.['_meta']?.title
  return typeof title === 'string' ? title : undefined
}

/**
 * The model files a loader node was pointed at, in the order it lists them (a
 * dual CLIP loader names two). Loaders spell the file in an input whose name
 * ends in `_name` — `ckpt_name`, `unet_name`, `clip_name1` — which is all the
 * different loader classes have in common.
 */
export const loaderModelNames = (workflow: ComfyUIApiWorkflow, nodeId: string): string[] => {
  const inputs = workflow[nodeId]?.inputs
  if (!inputs || typeof inputs !== 'object') return []
  return Object.entries(inputs)
    .filter(([name, value]) => /_name\d*$/.test(name) && typeof value === 'string')
    .map(([, value]) => value as string)
}

export const findKeysByClassType = (workflow: ComfyUIApiWorkflow, classType: string) =>
  Object.entries(workflow)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter(([_key, value]) => (value as any)?.['class_type'] === classType)
    .map(([key, _value]) => key)

export const findKeysByInputsName = (workflow: ComfyUIApiWorkflow, setting: ComfySetting) => {
  for (const inputName of settingToComfyInputsName[setting]) {
    if (inputName === 'text') continue
    const keys = Object.entries(workflow)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter(([_key, value]) => (value as any)?.['inputs']?.[inputName ?? ''] !== undefined)
      .map(([key, _value]) => key)
    if (keys.length > 0) return keys
  }
  return []
}

export const getInputNameBySettingAndKey = (
  workflow: ComfyUIApiWorkflow,
  key: string,
  setting: ComfySetting,
) => {
  const inputs = workflow[key]?.inputs
  if (!inputs || typeof inputs !== 'object') return ''
  for (const inputName of settingToComfyInputsName[setting]) {
    // Use `in`, not truthiness: empty prompt ("") and seed 0 are valid defaults to overwrite
    if (inputName !== undefined && inputName in inputs) return inputName
  }
  return ''
}

/**
 * A ComfyUI node input shaped as `[upstreamNodeId, slotIndex]`. When a preset's
 * workflow wires a value through a graph link (e.g. a `PrimitiveInt` shared
 * across multiple `KSampler`s), we must not overwrite it with a scalar — doing
 * so silently disconnects the link and breaks the workflow.
 */
export function isNodeLink(value: unknown): value is [string, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'number'
  )
}

export function modifySettingInWorkflow(
  workflow: ComfyUIApiWorkflow,
  setting: ComfySetting,
  value: unknown,
) {
  const keys =
    findKeysByTitle(workflow, setting).length > 0
      ? findKeysByTitle(workflow, setting)
      : findKeysByInputsName(workflow, setting)
  if (keys.length === 0) {
    console.warn(`No key found for setting ${setting}. Skipping this setting.`)
    return
  }
  if (keys.length > 1) {
    console.warn(`Multiple keys found for setting ${setting}. Using first one`)
  }
  const key = keys[0]
  const inputName = getInputNameBySettingAndKey(workflow, key, setting)
  const nodeInputs = workflow[key]?.inputs
  if (inputName !== '' && nodeInputs && inputName in nodeInputs) {
    if (isNodeLink(nodeInputs[inputName])) {
      console.debug(
        `Skipping write for setting '${setting}' on node '${key}.${inputName}': value is a graph link.`,
      )
      return
    }
    nodeInputs[inputName] = value
  } else if (nodeInputs && 'a' in nodeInputs) {
    if (isNodeLink(nodeInputs['a'])) {
      console.debug(
        `Skipping write for setting '${setting}' on node '${key}.a': value is a graph link.`,
      )
      return
    }
    nodeInputs['a'] = value
  }
}
