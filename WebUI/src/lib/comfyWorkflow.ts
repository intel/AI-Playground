import type { ComfyUIApiWorkflow } from '@/lib/presetSchemas'

// Pure ComfyUI workflow helpers shared by the renderer generation UI, the
// artifact runner in the Electron main process, and their tests. No Pinia, no
// Electron, no browser APIs — anything that mutates a workflow dict or names a
// ComfyUI model path lives here (docs/architecture-target.md §4.1).

/** Value for optional model inputs when the node should be bypassed (e.g. no LoRA). */
export const OPTIONAL_MODEL_NONE = 'None'

/**
 * Convert stored model name to the path separator ComfyUI expects for the current OS.
 * Matches preset handling in main.ts: Windows expects backslash, non-Windows expects forward slash.
 */
export function modelNameForComfyApi(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? name.replace(/\//g, '\\') : name.replace(/\\/g, '/')
}

/** Normalize to ComfyUI format (backslash) so disk scan and requiredModels dedupe correctly across OS. */
export function normalizeComfyUIModelName(name: string): string {
  return name.replace(/\//g, '\\')
}

/** Convert requiredModels "repo/path/file.safetensors" to ComfyUI format "repo---path\\file.safetensors" */
export function requiredModelToComfyUIName(modelPath: string): string {
  const parts = modelPath.split('/')
  if (parts.length < 2) return modelPath
  const firstTwo = parts.slice(0, 2).join('---')
  const rest = parts.slice(2).join('\\')
  return rest ? `${firstTwo}\\${rest}` : firstTwo
}

export function isBase64ImageDataUri(url: string | undefined | null): boolean {
  if (!url || typeof url !== 'string') return false
  return /^data:image\/(png|jpeg|webp);base64,/.test(url)
}

/**
 * Checks if a string is a displayable image URL (base64 data URI or aipg-media).
 * Use this for "has image" UI checks (e.g. img src, drop zones).
 */
export function isImageUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== 'string') return false
  return isBase64ImageDataUri(url) || url.startsWith('aipg-media://')
}

/**
 * Builds an `aipg-media://` URL for a path relative to the media directory.
 *
 * The media-relative path MUST live in the URL *path*, under a constant
 * `media` authority — never in the authority itself. `aipg-media` is
 * registered as a *standard* scheme (see `registerSchemesAsPrivileged` in
 * `electron/main.ts`), and Chromium lowercases the authority of standard URLs.
 * Putting a case-sensitive filename there (e.g. ComfyUI's `ComfyUI_00001_.png`)
 * therefore resolves to `comfyui_00001_.png`, which silently works on
 * case-insensitive filesystems (Windows/macOS) but fails with
 * `net::ERR_FILE_NOT_FOUND` on case-sensitive ones (Linux). Keeping the path in
 * the URL path preserves case on every OS.
 */
export function mediaUrl(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  const encoded = normalized.split('/').map(encodeURIComponent).join('/')
  return `aipg-media://media/${encoded}`
}

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
    { class_type?: string; inputs?: Record<string, unknown> } | undefined
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

/** Rewire and remove optional model nodes whose value is None (e.g. LoRA bypass). */
export function bypassOptionalModelNodes(
  workflow: ComfyUIApiWorkflow,
  inputs: { type: string; optional?: boolean; nodeTitle: string; current: unknown }[],
): void {
  for (const input of inputs) {
    if (
      input.type !== 'model' ||
      input.optional !== true ||
      input.current !== OPTIONAL_MODEL_NONE
    ) {
      continue
    }
    const keys = findKeysByTitle(workflow, input.nodeTitle)
    for (const key of keys) {
      bypassNode(workflow, key)
    }
  }
}
