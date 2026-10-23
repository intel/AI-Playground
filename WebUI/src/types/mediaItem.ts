import type { ComfyInput } from '@/lib/presetSchemas'

// MediaItem and the generation FSM state vocabulary (docs/architecture-target.md
// §4.1). Shared between the renderer's imageGenerationPresets store, the kernel
// event vocabulary (src/types/kernelEvents.ts) and the main-process artifact
// runner, which produces items — so the wire shape of a tracked media item has
// exactly one definition. The renderer store re-exports these as its
// historical import site.

export type GenerateState =
  | 'no_start'
  | 'start_backend'
  | 'input_image'
  | 'install_workflow_components'
  | 'load_workflow_components'
  | 'load_model'
  | 'load_model_components'
  | 'generating'
  | 'image_out'
  | 'error'

export type GenerationSettings = Partial<{
  preset: string
  variant?: string
  device: number
  prompt: string
  seed: number
  inferenceSteps: number
  width: number
  height: number
  resolution: string
  batchSize: number
  negativePrompt: string
  safetyCheck: boolean
  showPreview: boolean
}>

export type ComfyDynamicInputWithCurrent = ComfyInput & { current: string | number | boolean }

export type MediaItemState = 'queued' | 'generating' | 'done' | 'stopped' | 'failed'

/** A media item that has not reached a terminal state yet. */
export const isInFlight = (item: MediaItem): boolean =>
  item.state === 'queued' || item.state === 'generating'

type BaseMediaItem = {
  id: string
  state: MediaItemState
  mode: WorkflowModeType
  sourceImageUrl?: string
  settings: GenerationSettings
  dynamicSettings?: ComfyDynamicInputWithCurrent[]
  createdAt?: number
}

export type ImageMediaItem = BaseMediaItem & {
  type: 'image'
  fromImageGen?: boolean
  imageUrl: string
  isNsfwBlocked?: boolean
}

export type VideoMediaItem = BaseMediaItem & {
  type: 'video'
  videoUrl: string
  thumbnailUrl?: string // Optional thumbnail for video preview
}

export type Model3DMediaItem = BaseMediaItem & {
  type: 'model3d'
  model3dUrl: string
  thumbnailUrl?: string // Optional thumbnail for 3D preview
}

export type MediaItem = ImageMediaItem | VideoMediaItem | Model3DMediaItem

export const isVideo = (item: MediaItem): item is VideoMediaItem => item.type === 'video'

export const is3D = (item: MediaItem): item is Model3DMediaItem => item.type === 'model3d'

export const isImage = (item: MediaItem): item is ImageMediaItem => item.type === 'image'

/**
 * Transparent 1x1 SVG injected as the `imageUrl` for queued items so the slot
 * exists before any real output arrives (see the artifact runner's item
 * registration). It is not real output, so "has media" checks must treat it as
 * empty.
 */
export const PLACEHOLDER_IMAGE_URL =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"%3E%3C/svg%3E'

/**
 * Whether a media item carries real, displayable output (not an empty or
 * placeholder slot). Used to hide cancelled/failed items that never produced
 * media (e.g. items left in a terminal `stopped`/`failed` state after a batch
 * is cancelled) from galleries and auto-selection.
 */
export const hasDisplayableMedia = (item: MediaItem): boolean => {
  if (isVideo(item)) return !!item.videoUrl && item.videoUrl.trim() !== ''
  if (is3D(item)) return !!item.model3dUrl && item.model3dUrl.trim() !== ''
  const url = item.imageUrl
  return !!url && url.trim() !== '' && url !== PLACEHOLDER_IMAGE_URL
}
