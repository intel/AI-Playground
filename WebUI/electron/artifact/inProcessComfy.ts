import { randomUUID } from 'node:crypto'
import { submitArtifactRun, cancelArtifactRun } from '../kernel/orchestrator.ts'
import type { ArtifactRunResult } from './runner.ts'
import { resolveComfyEntry, type PresetCatalog } from './catalog.ts'
import type { ComfyInput, ComfyUiPreset, Preset } from '@/lib/presetSchemas'
import { OPTIONAL_MODEL_NONE } from '@/lib/comfyWorkflow'
import {
  DEFAULT_RESOLUTION_CONFIG,
  findClosestResolutionInConfig,
  getResolutionForConfig,
  getResolutionsFromConfig,
} from '@/lib/comfyResolutions'
import type { ResolutionConfig, MegapixelOption } from '@/lib/presetSchemas'
import type { ArtifactRunOwner } from '@/types/kernelEvents'

// Shared in-process Comfy execution (architecture-target §8 step 12):
// generateImage / editImage, Chat parent comfyUI / comfyUiImageEdit, and the
// NL media specialist's inner Comfy tools all resolve a workflow from main's
// catalog and submit through the orchestrator. Download consent stays artifact:request.

type CatalogProvider = () => Promise<PresetCatalog>
let catalogProvider: CatalogProvider | null = null

export function setMediaCatalogProvider(provider: CatalogProvider): void {
  catalogProvider = provider
}

export function resetMediaCatalogProviderForTest(): void {
  catalogProvider = null
}

function findFastVariant(preset: Preset): string | null {
  if (!preset.variants || preset.variants.length === 0) return null
  const fastVariant = preset.variants.find((v) => v.name.toLowerCase().includes('fast'))
  return fastVariant ? fastVariant.name : null
}

function resolveVariant(preset: Preset, requested: unknown): string | undefined {
  if (typeof requested === 'string' && preset.variants?.some((v) => v.name === requested)) {
    return requested
  }
  return findFastVariant(preset) ?? preset.variants?.[0]?.name
}

function getDefaultMegapixelLabel(config: ResolutionConfig): string {
  const labels = config.megapixels.map((m: MegapixelOption) => m.label)
  if (labels.includes('1.0')) return '1.0'
  return labels[Math.floor(labels.length / 2)] ?? '0.5'
}

function resolveSize(
  preset: ComfyUiPreset,
  args: { aspectRatio?: unknown; megapixels?: unknown; resolution?: unknown },
): { width?: number; height?: number } {
  const config = preset.resolutionConfig ?? DEFAULT_RESOLUTION_CONFIG
  const aspectRatio = typeof args.aspectRatio === 'string' ? args.aspectRatio : undefined
  const megapixels = typeof args.megapixels === 'string' ? args.megapixels : undefined
  const resolution = typeof args.resolution === 'string' ? args.resolution : undefined

  if (aspectRatio || megapixels) {
    const ar = aspectRatio ?? '1/1'
    const mp = megapixels ?? getDefaultMegapixelLabel(config)
    const exact = getResolutionForConfig(config, mp, ar)
    if (exact) return { width: exact.width, height: exact.height }
    const matchingAR = getResolutionsFromConfig(config).filter((r) => r.aspectRatio === ar)
    if (matchingAR.length === 0) return {}
    const target = parseFloat(mp)
    const closest = matchingAR.reduce((prev, curr) =>
      Math.abs(parseFloat(curr.megapixels) - target) <
      Math.abs(parseFloat(prev.megapixels) - target)
        ? curr
        : prev,
    )
    return { width: closest.width, height: closest.height }
  }
  if (resolution) {
    const [w, h] = resolution.split('x').map(Number)
    if (w && h) {
      const match = findClosestResolutionInConfig(config, w, h)
      return match ? { width: match.width, height: match.height } : { width: w, height: h }
    }
  }
  return {}
}

function resolveInputs(
  preset: ComfyUiPreset,
  source?: string,
): Array<ComfyInput & { current: unknown }> {
  const inputs = preset.settings.filter(
    (s): s is ComfyInput => 'nodeTitle' in s && 'nodeInput' in s,
  )
  const resolved = inputs.map((input) => {
    const raw = input.defaultValue
    const current =
      input.type === 'model' &&
      input.optional === true &&
      (raw === undefined || raw === '' || raw === OPTIONAL_MODEL_NONE)
        ? OPTIONAL_MODEL_NONE
        : raw
    return { ...input, current }
  })
  if (source) {
    const imageInput = resolved.find(
      (input) =>
        (input.type === 'image' ||
          input.type === 'inpaintMask' ||
          input.type === 'outpaintCanvas') &&
        input.displayed !== false &&
        input.modifiable !== false &&
        (input.current === '' || input.current === undefined),
    )
    if (imageInput) imageInput.current = source
  }
  return resolved
}

function toolOutput(result: ArtifactRunResult): Record<string, unknown> {
  const images = result.items.map((item) => {
    const settings = item.settings || {}
    if (item.type === 'video') {
      return { id: item.id, type: 'video', videoUrl: item.videoUrl, mode: 'imageGen', settings }
    }
    if (item.type === 'model3d') {
      return {
        id: item.id,
        type: 'model3d',
        model3dUrl: item.model3dUrl,
        mode: 'imageGen',
        settings,
      }
    }
    return { id: item.id, type: 'image', imageUrl: item.imageUrl, mode: 'imageGen', settings }
  })
  if (result.state === 'cancelled') {
    return { success: false, message: 'Generation cancelled.', images }
  }
  if (result.state === 'failed') {
    return {
      success: false,
      message: `ComfyUI generation failed: ${result.error ?? 'unknown error'}`,
      images,
    }
  }
  return { images }
}

export type InProcessComfyArgs = {
  workflow?: unknown
  variant?: unknown
  prompt?: unknown
  negativePrompt?: unknown
  aspectRatio?: unknown
  megapixels?: unknown
  resolution?: unknown
  inferenceSteps?: unknown
  seed?: unknown
  batchSize?: unknown
  defaultWorkflow?: string
}

export type InProcessComfyRequest = {
  kind: 'create' | 'edit'
  args: InProcessComfyArgs
  source?: string
  origin: 'renderer' | 'agent'
  owner?: ArtifactRunOwner
  conversationKey?: string
  keepModelsLoaded: boolean
  signal?: AbortSignal
}

export async function runInProcessComfyTool(
  request: InProcessComfyRequest,
): Promise<Record<string, unknown>> {
  if (!catalogProvider) {
    return { success: false, message: 'No preset catalog is available in main.', images: [] }
  }
  const workflowName =
    typeof request.args.workflow === 'string' && request.args.workflow !== ''
      ? request.args.workflow
      : request.args.defaultWorkflow
  if (!workflowName) {
    return {
      success: false,
      message: 'No workflow requested and none configured as default.',
      images: [],
    }
  }

  const catalog = await catalogProvider()
  const base = catalog.comfy.get(workflowName)
  if (!base) {
    return { success: false, message: `Workflow "${workflowName}" is not available.`, images: [] }
  }
  const variant = resolveVariant(base, request.args.variant)
  const preset = resolveComfyEntry(catalog, workflowName, variant)
  if (!preset) {
    return {
      success: false,
      message: `Workflow "${workflowName}" could not be resolved.`,
      images: [],
    }
  }

  const isEdit = request.kind === 'edit'
  const { width, height } = isEdit ? {} : resolveSize(preset, request.args)
  const prompt = typeof request.args.prompt === 'string' ? request.args.prompt : ''

  const payload = {
    runId: randomUUID(),
    mode: (isEdit ? 'imageEdit' : 'imageGen') as 'imageEdit' | 'imageGen',
    preset,
    params: {
      prompt,
      negativePrompt:
        typeof request.args.negativePrompt === 'string' ? request.args.negativePrompt : 'nsfw',
      seed: typeof request.args.seed === 'number' ? request.args.seed : -1,
      inferenceSteps:
        typeof request.args.inferenceSteps === 'number' ? request.args.inferenceSteps : 6,
      width: width ?? 512,
      height: height ?? 512,
      batchSize: isEdit
        ? 1
        : typeof request.args.batchSize === 'number'
          ? request.args.batchSize
          : 1,
    },
    inputs: resolveInputs(preset, isEdit ? request.source : undefined),
    source: isEdit ? request.source : undefined,
    keepModelsLoaded: request.keepModelsLoaded,
    variant,
    origin: request.origin,
    owner: request.owner,
    conversationKey: request.conversationKey,
  }

  const onAbort = () => cancelArtifactRun(payload.runId)
  if (request.signal?.aborted) {
    onAbort()
    return toolOutput({ state: 'cancelled', items: [] })
  }
  request.signal?.addEventListener('abort', onAbort, { once: true })
  let result: ArtifactRunResult
  try {
    result = await submitArtifactRun(payload, { queue: 'queue' })
  } finally {
    request.signal?.removeEventListener('abort', onAbort)
  }
  return toolOutput(result)
}
