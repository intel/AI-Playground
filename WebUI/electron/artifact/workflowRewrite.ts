/**
 * Main-side workflow rewriting for the artifact runner
 * (docs/architecture-target.md §4.1, step 5): port of the renderer engine's
 * `modifyDynamicSettingsInWorkflow` + the surrounding rewrites
 * (`src/assets/js/store/comfyUiPresets.ts`).
 *
 * Pure workflow-graph helpers (setting substitution, model-name mapping, LoRA
 * bypass, OVMS URL injection, model-path normalization) live in the shared
 * `@/lib/comfyWorkflow`. This module owns the input-file side: turning
 * data-URI/aipg-media input values into files in ComfyUI's input directory
 * under their SHA-256 content-hash names, and re-encoding images to 8-bit
 * RGBA PNG so ComfyUI's PyAV-based LoadImage never hits the alignment filter
 * graph that crashes on planar-float/grayscale frames. The renderer did that
 * through a 2D canvas; main has no DOM, so it goes through Electron's
 * `nativeImage`, which decodes and re-encodes through the same Chromium code.
 */
import { nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import {
  OPTIONAL_MODEL_NONE,
  bypassNode,
  findKeysByTitle,
  isImageUrl,
  modelNameForComfyApi,
  modifySettingInWorkflow,
  normalizeModelPathsInWorkflow,
  bypassOptionalModelNodes,
  injectOvmsImageUrl,
} from '@/lib/comfyWorkflow'
import type { ComfyInput, ComfyUiPreset, ComfyUIApiWorkflow } from '@/lib/presetSchemas'

/** A workflow dynamic input with its resolved value (plain value, no store ref). */
export type ArtifactRunInput = ComfyInput & { current: unknown }

export type WorkflowRewriteDeps = {
  /** Reads an `aipg-media://` URL into a data URI; null when unreadable. */
  readMediaAsDataUri(url: string): Promise<string | null>
  /** Uploads one file into ComfyUI's input directory (comfyClient). */
  uploadInputFile(file: { name: string; blob: Blob; subfolder?: string }): Promise<void>
}

/** Port of the renderer's `validateRequiredImageInputs`. */
export function validateRequiredImageInputs(inputs: ArtifactRunInput[]): string[] {
  const missingInputs: string[] = []
  for (const input of inputs) {
    if (input.optional === true) continue
    const isImageType =
      input.type === 'image' || input.type === 'inpaintMask' || input.type === 'outpaintCanvas'
    const isDisplayed = input.displayed !== false
    const isModifiable = input.modifiable !== false
    const hasNoDefault = input.defaultValue === '' || input.defaultValue === undefined
    if (isImageType && isDisplayed && isModifiable && hasNoDefault) {
      const value = input.current
      const isEmpty = value === '' || value === undefined || value === null
      const isValid = typeof value === 'string' && value !== '' && isImageUrl(value)
      if (isEmpty || !isValid) missingInputs.push(input.label)
    }
  }
  return missingInputs
}

/** The 1x1 transparent PNG injected for empty optional image inputs. */
const EMPTY_INPUT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function dataUriToBlob(dataUri: string): Blob {
  const [meta, base64 = ''] = dataUri.split(',')
  const mime = meta.split(':')[1]?.split(';')[0] ?? 'application/octet-stream'
  const isBase64 = meta.includes('base64')
  const buffer = isBase64
    ? Buffer.from(base64, 'base64')
    : Buffer.from(decodeURIComponent(base64), 'utf-8')
  return new Blob([buffer], { type: mime })
}

/**
 * Re-encodes an image data URI to 8-bit RGBA PNG. `nativeImage` refuses
 * nothing it cannot decode (returns an empty image), which mirrors the
 * renderer's own fallback: pass the original through untouched.
 */
export function reencodeImageTo8BitPng(dataUri: string): string {
  const image = nativeImage.createFromDataURL(dataUri)
  if (image.isEmpty()) return dataUri
  return `data:image/png;base64,${image.toPNG().toString('base64')}`
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

/**
 * Ports `modifyDynamicSettingsInWorkflow`: substitutes every dynamic input's
 * resolved value into the workflow graph, uploading image/video inputs to
 * ComfyUI's input directory under content-hash names so repeated runs reuse
 * the same file instead of accumulating duplicates.
 */
export async function modifyDynamicSettingsInWorkflow(
  mutableWorkflow: ComfyUIApiWorkflow,
  platform: NodeJS.Platform,
  inputs: ArtifactRunInput[],
  deps: WorkflowRewriteDeps,
): Promise<void> {
  for (const input of inputs) {
    const keys = findKeysByTitle(mutableWorkflow, input.nodeTitle)
    if (keys.length === 0) continue

    if (
      input.type === 'number' ||
      input.type === 'string' ||
      input.type === 'boolean' ||
      input.type === 'stringList'
    ) {
      const node = mutableWorkflow[keys[0]]
      if (node?.inputs !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(node.inputs as any)[input.nodeInput] = input.current
      }
    }
    if (input.type === 'model') {
      if (input.current === OPTIONAL_MODEL_NONE) {
        // The node is bypassed wholesale by bypassOptionalModelNodes instead.
        continue
      }
      const node = mutableWorkflow[keys[0]]
      if (node?.inputs !== undefined) {
        const value =
          typeof input.current === 'string'
            ? modelNameForComfyApi(input.current, platform)
            : input.current
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(node.inputs as any)[input.nodeInput] = value
      }
    }
    if (input.type === 'image' || input.type === 'inpaintMask' || input.type === 'outpaintCanvas') {
      const rawValue = input.current
      const isEmpty = typeof rawValue !== 'string' || rawValue === '' || !isImageUrl(rawValue)
      const isOptional = input.optional === true

      let imageDataUri: string
      if (isEmpty && isOptional && input.type === 'image') {
        imageDataUri = EMPTY_INPUT_PNG
      } else if (typeof rawValue === 'string' && rawValue !== '') {
        imageDataUri = rawValue.startsWith('aipg-media://')
          ? ((await deps.readMediaAsDataUri(rawValue)) ?? '')
          : rawValue
      } else {
        continue
      }
      if (!imageDataUri) continue

      imageDataUri = reencodeImageTo8BitPng(imageDataUri)
      const uploadImageName = `${sha256Hex(imageDataUri)}.png`
      const node = mutableWorkflow[keys[0]]
      if (node?.inputs !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(node.inputs as any)[input.nodeInput] = uploadImageName
      }
      await deps.uploadInputFile({
        name: uploadImageName,
        blob: dataUriToBlob(imageDataUri),
      })
    }
    if (input.type === 'video') {
      if (typeof input.current !== 'string') continue
      const extension = input.current.match(/data:video\/(mp4|h264|h265);base64,/)?.[1]
      const uploadVideoName = `${sha256Hex(input.current)}.${extension}`
      const node = mutableWorkflow[keys[0]]
      if (node?.inputs !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(node.inputs as any)[input.nodeInput] = uploadVideoName
      }
      await deps.uploadInputFile({
        name: uploadVideoName,
        blob: dataUriToBlob(input.current),
      })
    }
  }
}

export type WorkflowRunParams = {
  prompt: string
  negativePrompt: string
  inferenceSteps: number
  width: number
  height: number
}

/**
 * The full rewrite pass the runner applies before queueing: scalar settings,
 * dynamic inputs (with their uploads), optional-model bypass, model-path
 * normalization and the OVMS image-server URL when the workflow needs one.
 * Mutates and returns the same workflow object.
 */
export async function rewriteWorkflowForRun(
  preset: ComfyUiPreset,
  params: WorkflowRunParams,
  inputs: ArtifactRunInput[],
  platform: NodeJS.Platform,
  ovmsImageUrl: string | null,
  deps: WorkflowRewriteDeps,
): Promise<ComfyUIApiWorkflow> {
  const workflow = structuredClone(preset.comfyUiApiWorkflow)
  modifySettingInWorkflow(workflow, 'inferenceSteps', params.inferenceSteps)
  modifySettingInWorkflow(workflow, 'height', params.height)
  modifySettingInWorkflow(workflow, 'width', params.width)
  modifySettingInWorkflow(workflow, 'prompt', params.prompt)
  modifySettingInWorkflow(workflow, 'negativePrompt', params.negativePrompt)

  await modifyDynamicSettingsInWorkflow(workflow, platform, inputs, deps)

  if (ovmsImageUrl) injectOvmsImageUrl(workflow, ovmsImageUrl)
  bypassOptionalModelNodes(workflow, inputs)
  normalizeModelPathsInWorkflow(workflow, platform)
  return workflow
}

/** LoRA-style optional model nodes whose value is None (kept for the runner's bypass list). */
export { bypassNode }
