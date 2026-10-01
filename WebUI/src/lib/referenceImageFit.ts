export type PixelSize = { width: number; height: number }

export type PixelBudget = { megapixels: number; resolutionSteps: number }

/** Resolutions FluxKontextImageScale snaps to (ComfyUI nodes_flux.py). */
const KONTEXT_RESOLUTIONS: readonly PixelSize[] = [
  { width: 672, height: 1568 },
  { width: 688, height: 1504 },
  { width: 720, height: 1456 },
  { width: 752, height: 1392 },
  { width: 800, height: 1328 },
  { width: 832, height: 1248 },
  { width: 880, height: 1184 },
  { width: 944, height: 1104 },
  { width: 1024, height: 1024 },
  { width: 1104, height: 944 },
  { width: 1184, height: 880 },
  { width: 1248, height: 832 },
  { width: 1328, height: 800 },
  { width: 1392, height: 752 },
  { width: 1456, height: 720 },
  { width: 1504, height: 688 },
  { width: 1568, height: 672 },
]

export function kontextReferenceSize(width: number, height: number): PixelSize {
  const aspect = width / Math.max(1, height)
  let best: PixelSize = KONTEXT_RESOLUTIONS[0]
  let bestDiff = Infinity
  for (const size of KONTEXT_RESOLUTIONS) {
    const diff = Math.abs(aspect - size.width / size.height)
    if (diff < bestDiff) {
      bestDiff = diff
      best = size
    }
  }
  return { width: best.width, height: best.height }
}

/**
 * ComfyUI ImageScaleToTotalPixels: target about megapixels*1024², then round
 * each edge to a multiple of resolutionSteps so the VAE latent matches.
 */
export function scaleToTotalPixels(
  width: number,
  height: number,
  megapixels: number,
  resolutionSteps: number,
): PixelSize {
  if (width <= 0 || height <= 0 || megapixels <= 0) return { width, height }
  const steps = Math.max(1, Math.round(resolutionSteps))
  const total = Math.floor(megapixels * 1024 * 1024)
  const scale = Math.sqrt(total / (width * height))
  return {
    width: Math.max(steps, Math.round((width * scale) / steps) * steps),
    height: Math.max(steps, Math.round((height * scale) / steps) * steps),
  }
}

type WorkflowNode = {
  class_type?: string
  inputs?: Record<string, unknown>
}

function workflowNodes(workflow: unknown): WorkflowNode[] {
  if (!workflow || typeof workflow !== 'object') return []
  return Object.values(workflow as Record<string, unknown>).filter(
    (node): node is WorkflowNode => !!node && typeof node === 'object' && !Array.isArray(node),
  )
}

function numberInput(node: WorkflowNode, key: string): number | undefined {
  const value = node.inputs?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Pixel size the active workflow will actually run at. Null leaves the file
 * untouched (upscale, inpaint, colorize). Video has no scale node, so an
 * oversized reference is only shrunk to the generation budget.
 */
export function fittedReferenceSize(
  width: number,
  height: number,
  workflow: unknown,
  fallback?: PixelBudget,
): PixelSize | null {
  const nodes = workflowNodes(workflow)
  if (nodes.some((node) => node.class_type === 'FluxKontextImageScale')) {
    return kontextReferenceSize(width, height)
  }
  const scaleNodes = nodes.filter((node) => node.class_type === 'ImageScaleToTotalPixels')
  if (scaleNodes.length > 0) {
    const megapixels = Math.min(...scaleNodes.map((node) => numberInput(node, 'megapixels') ?? 1))
    const resolutionSteps = Math.max(
      ...scaleNodes.map((node) => numberInput(node, 'resolution_steps') ?? 1),
    )
    return scaleToTotalPixels(width, height, megapixels, resolutionSteps)
  }
  if (!fallback || fallback.megapixels <= 0 || width <= 0 || height <= 0) return null
  if (width * height <= fallback.megapixels * 1024 * 1024) return null
  return scaleToTotalPixels(width, height, fallback.megapixels, fallback.resolutionSteps)
}

/** Video references have no scale node; cap them at the preset's generation size. */
export function referencePixelBudget(
  category: string | undefined,
  width: number,
  height: number,
): PixelBudget | undefined {
  if (category !== 'create-videos') return undefined
  const pixels = width * height
  if (!Number.isFinite(pixels) || pixels <= 0) return undefined
  return { megapixels: pixels / (1024 * 1024), resolutionSteps: 16 }
}

export type ReferenceInputSlot = {
  optional?: boolean
  value: unknown
}

/**
 * Primary reference slot to fill from a history selection. Null when that
 * image is already bound, so loading a later slot does not overwrite slot 1.
 */
export function referenceSlotToFill(slots: ReferenceInputSlot[], imageUrl: string): number | null {
  if (!imageUrl || slots.length === 0) return null
  if (slots.some((slot) => slot.value === imageUrl)) return null
  const required = slots.findIndex((slot) => slot.optional !== true)
  return required === -1 ? 0 : required
}
