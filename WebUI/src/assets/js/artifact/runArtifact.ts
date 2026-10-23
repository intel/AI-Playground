import type { ComfyGenerationParams } from '../store/comfyUiPresets'
import { useDeveloperSettings } from '../store/developerSettings'
import {
  OPTIONAL_MODEL_NONE,
  presetSettingsKey,
  useImageGenerationPresets,
  type GenerationSettings,
} from '../store/imageGenerationPresets'
import type { MediaItem } from '@/types/mediaItem'
import { usePresets, type ComfyInput, type ComfyUiPreset, type Preset } from '../store/presets'
import { imageUrlToDataUri } from '@/lib/utils'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { isCancellation } from '../errors/appError'
import { presetToMode } from '@/lib/presetModes'

/**
 * Renderer-side Artifact capability: one fully-resolved request in, one settled
 * result out. Callers (the Image Gen UI, the chat media tools, Home Agent
 * channels) never touch selection state to make a run happen — no preset
 * switch, no variant activation, no prompt-field mutation. Everything that
 * decides the output travels on the request; everything the run produces is
 * carried by the tracked MediaItems it registers.
 */

export type ArtifactKind = 'create-image' | 'edit-image' | 'create-video' | 'create-3d'

/** Kind the later adapters will key off. Step 1 still routes by preset mediaType. */
export function artifactKindForMedia(
  mediaType: 'image' | 'video' | 'model3d' | undefined,
  hasSource: boolean,
): ArtifactKind {
  if (mediaType === 'video') return 'create-video'
  if (mediaType === 'model3d') return 'create-3d'
  return hasSource ? 'edit-image' : 'create-image'
}

export type ArtifactRequest = {
  kind: ArtifactKind
  /** Preset (workflow) name, as offered by the tool catalog / preset list. */
  workflow: string
  /** Explicit variant name; invalid names fall back like the UI does. */
  variant?: string
  prompt?: string
  negativePrompt?: string
  /** Source image (data URI, aipg-media:// or file URL) for edit-style kinds. */
  source?: string
  /**
   * Which media bucket the items land in (history, output schema). Defaults to
   * the preset's category-derived mode. Tools pin this because their output
   * schema is mode-tagged.
   */
  mode?: WorkflowModeType
  params?: {
    seed?: number
    width?: number
    height?: number
    inferenceSteps?: number
    batchSize?: number
  }
}

export type ArtifactRunContext = {
  /** Chat/tool activity the generation FSM phases nest under. */
  parentActivityId?: string | null
  abortSignal?: AbortSignal
  /**
   * `'queue'` parks the run behind an active one (chat tool calls); the
   * default fail-fast keeps the panel's one-generation-at-a-time contract.
   */
  queueMode?: 'queue'
  /** The conversation this run was asked from — routes orchestrator queue events. */
  conversationKey?: string
}

export type ArtifactResult = {
  state: 'completed' | 'failed' | 'cancelled'
  /** Items that reached 'done' — the full batch on success, partials otherwise. */
  items: MediaItem[]
  error?: string
}

// Fallbacks when neither the request nor the preset declares a value. Matches
// the create tool's historic defaults; presets normally declare their own.
const FALLBACK_PARAMS: Omit<ComfyGenerationParams, 'prompt'> = {
  seed: -1,
  width: 512,
  height: 512,
  inferenceSteps: 6,
  batchSize: 1,
  negativePrompt: 'nsfw',
}

const QUEUED_PLACEHOLDER_URL =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"%3E%3C/svg%3E'

function presetDefault(preset: Preset, settingName: string): unknown {
  return preset.settings.find((s) => 'settingName' in s && s.settingName === settingName)
    ?.defaultValue
}

function settingIsRelevantFor(preset: Preset, settingName: string): boolean {
  const setting = preset.settings.find((s) => 'settingName' in s && s.settingName === settingName)
  return setting ? setting.displayed || setting.modifiable : false
}

/**
 * Variant semantics per surface: an explicit (and valid) request variant wins;
 * otherwise the user's remembered variant for that workflow; otherwise the
 * first variant — mirroring what a preset switch would resolve to, without
 * the switch. Drivers that prefer a "Fast" variant (the chat tools) resolve it
 * themselves and pass it explicitly.
 */
function resolveVariantName(preset: Preset, requested: string | undefined): string | undefined {
  if (requested && preset.variants?.some((v) => v.name === requested)) return requested
  if (preset.variants && preset.variants.length > 0) {
    return preset.variants[0].name
  }
  return undefined
}

function resolveParams(request: ArtifactRequest, preset: ComfyUiPreset): ComfyGenerationParams {
  const params = request.params ?? {}
  const mediaType = preset.mediaType ?? 'image'
  const resolutionDefault = presetDefault(preset, 'resolution')
  const [defaultWidth, defaultHeight] =
    typeof resolutionDefault === 'string'
      ? resolutionDefault.split('x').map(Number)
      : [undefined, undefined]

  // Batching only makes sense for images (cheap alternates); video and 3D are
  // expensive and a single result is expected, so batch is forced to 1.
  const requestedBatch = params.batchSize ?? presetDefault(preset, 'batchSize')

  return {
    prompt: request.prompt ?? (presetDefault(preset, 'prompt') as string | undefined) ?? '',
    negativePrompt:
      request.negativePrompt ??
      (presetDefault(preset, 'negativePrompt') as string | undefined) ??
      FALLBACK_PARAMS.negativePrompt,
    seed:
      params.seed ?? (presetDefault(preset, 'seed') as number | undefined) ?? FALLBACK_PARAMS.seed,
    inferenceSteps:
      params.inferenceSteps ??
      (presetDefault(preset, 'inferenceSteps') as number | undefined) ??
      FALLBACK_PARAMS.inferenceSteps,
    width: params.width ?? defaultWidth ?? FALLBACK_PARAMS.width,
    height: params.height ?? defaultHeight ?? FALLBACK_PARAMS.height,
    batchSize: mediaType === 'image' ? Number(requestedBatch ?? FALLBACK_PARAMS.batchSize) : 1,
  }
}

type ResolvedInput = ComfyInput & { current: unknown }

/**
 * Snapshot of the workflow's dynamic inputs with their resolved current
 * values, read from the same per-persisted-preset map the settings sidebar
 * writes into. Plain values: the run owns them, so injecting a source image
 * cannot leak back into the persisted settings.
 */
function resolveInputs(
  preset: ComfyUiPreset,
  savedInputs: Record<string, unknown> | undefined,
): ResolvedInput[] {
  const inputSettings = preset.settings.filter(
    (s): s is ComfyInput => 'nodeTitle' in s && 'nodeInput' in s,
  )
  return inputSettings.map((input) => {
    const raw = savedInputs?.[`${input.nodeTitle}.${input.nodeInput}`] ?? input.defaultValue
    const current =
      input.type === 'model' &&
      input.optional === true &&
      (raw === undefined || raw === '' || raw === OPTIONAL_MODEL_NONE)
        ? OPTIONAL_MODEL_NONE
        : raw
    return { ...input, current }
  })
}

function buildSettings(
  preset: ComfyUiPreset,
  variantName: string | undefined,
  params: ComfyGenerationParams,
  safetyCheck: boolean,
  showPreview: boolean,
): GenerationSettings {
  const allSettings = {
    preset: preset.name,
    variant: variantName,
    device: 0, // TODO get correct device from backend service
    prompt: params.prompt,
    negativePrompt: params.negativePrompt,
    batchSize: params.batchSize,
    inferenceSteps: params.inferenceSteps,
    seed: params.seed,
    height: params.height,
    width: params.width,
    resolution: `${params.width}x${params.height}`,
    safetyCheck,
    showPreview,
  }
  return Object.fromEntries(
    Object.entries(allSettings).filter(
      ([key]) =>
        key === 'preset' ||
        key === 'variant' ||
        key === 'device' ||
        settingIsRelevantFor(preset, key),
    ),
  )
}

/**
 * Resolve and run one media generation. Model pre-flight stays renderer-side
 * (the permissions layer); everything after — readiness, installs, submission,
 * progress, the idle watchdog — is the main-process runner's, reached over
 * `artifact:run`. Resolves when the run settles; `items` carries what reached
 * 'done'. A user cancelling the required-model download still throws
 * (`isCancellation`) so the UI's pre-existing catch — which resets the prompt
 * bar — keeps working.
 */
export async function runArtifact(
  request: ArtifactRequest,
  ctx: ArtifactRunContext = {},
): Promise<ArtifactResult> {
  const presetsStore = usePresets()
  const imageGen = useImageGenerationPresets()

  const failed = (error: string): ArtifactResult => ({ state: 'failed', items: [], error })

  // 1. Resolve the workflow + variant without touching selection state.
  const basePreset = presetsStore.presets.find(
    (p) => p.name === request.workflow && p.type === 'comfy' && p.backend === 'comfyui',
  )
  if (!basePreset) return failed(`Unknown workflow "${request.workflow}"`)

  const requestedVariant = request.variant ?? presetsStore.activeVariantName[request.workflow]
  const variantName = resolveVariantName(basePreset, requestedVariant)
  const preset = (
    variantName ? presetsStore.resolvePresetVariant(request.workflow, variantName) : basePreset
  ) as ComfyUiPreset | null
  if (!preset) return failed(`Unknown workflow "${request.workflow}"`)

  const mode: WorkflowModeType = request.mode ?? (presetToMode(preset) as WorkflowModeType)
  const params = resolveParams(request, preset)
  const settingsKey = presetSettingsKey(preset.name, variantName)
  const inputs = resolveInputs(preset, imageGen.comfyInputsPerPreset[settingsKey])

  // 2. Edit kinds: inject the source image into the first required image
  // input, matching what the settings sidebar's LoadImage field would hold.
  if (request.source) {
    const imageInput = inputs.find(
      (input) =>
        (input.type === 'image' ||
          input.type === 'inpaintMask' ||
          input.type === 'outpaintCanvas') &&
        input.displayed !== false &&
        input.modifiable !== false &&
        (input.defaultValue === '' || input.defaultValue === undefined),
    )
    if (!imageInput) return failed('No suitable image input found in the preset')
    try {
      imageInput.current = await imageUrlToDataUri(request.source)
    } catch (error) {
      return failed(
        `Failed to convert source image: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }
  }

  // Cancelled before anything was queued — don't pull in models nobody waits for.
  if (ctx.abortSignal?.aborted) return { state: 'cancelled', items: [] }

  // 3. Required models. Download approval routes through the dialog (or the
  // remote channel on Home Agent turns) exactly as the UI path always did.
  try {
    await imageGen.ensureModelsAreAvailableFor(preset)
  } catch (error) {
    if (isCancellation(error)) throw error
    return failed(
      `Required models are unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }

  // Aborted while the model dialog was open — don't register placeholders for
  // a run whose caller is already gone.
  if (ctx.abortSignal?.aborted) return { state: 'cancelled', items: [] }

  // 4. Create the tracked items — the run's only footprint on shared state.
  const baseSeed = params.seed === -1 ? Math.floor(Math.random() * 1_000_000) : params.seed
  const baseSettings = buildSettings(
    preset,
    variantName,
    params,
    imageGen.safetyCheck,
    imageGen.showPreview,
  )
  const items: MediaItem[] = Array.from({ length: params.batchSize }, (_, i) => ({
    id: crypto.randomUUID(),
    mode,
    sourceImageUrl: request.source,
    state: 'queued' as const,
    type: 'image' as const,
    imageUrl: QUEUED_PLACEHOLDER_URL,
    settings: { ...baseSettings, seed: baseSeed + i },
    dynamicSettings: inputs.map((input) => ({
      ...input,
      current: input.current as never,
    })),
  }))
  items.forEach((item) => imageGen.updateImage(item))
  imageGen.lastError = null
  imageGen.generationParentActivityId = ctx.parentActivityId ?? null

  const removeQueuedStubs = () => {
    const trackedIds = new Set(items.map((item) => item.id))
    imageGen.generatedImages = imageGen.generatedImages.filter((img) => !trackedIds.has(img.id))
  }

  // 5. Submit to the main-process runner. Readiness, installs, submission and
  // the progress stream are main's; live UI state arrives through the kernel
  // artifact events (the imageGenerationPresets projection), and this promise
  // settles with the run. The abort listener is armed BEFORE submit so the
  // window between item registration and queueing is covered too.
  const runId = crypto.randomUUID()
  imageGen.trackArtifactRun(runId)
  const onAbort = () => {
    void window.electronAPI.artifact.cancel(runId)
  }
  ctx.abortSignal?.addEventListener('abort', onAbort, { once: true })

  let result: ArtifactResult
  try {
    result = await window.electronAPI.artifact.run(
      cloneForIpc({
        runId,
        mode,
        preset,
        params,
        inputs,
        items,
        source: request.source,
        variant: variantName,
        origin: 'renderer' as const,
        modelsConsented: true,
        showPreview: imageGen.showPreview,
        safetyCheck: imageGen.safetyCheck,
        keepModelsLoaded: useDeveloperSettings().keepModelsLoaded,
        conversationKey: ctx.conversationKey,
        // The tool activity's id lets queue events relabel it while parked.
        activityId: typeof ctx.parentActivityId === 'string' ? ctx.parentActivityId : undefined,
      }),
      ctx.queueMode ? { queue: ctx.queueMode } : undefined,
    )
  } catch (error) {
    // IPC itself failed (window replaced mid-run, handler threw) — the main
    // runner settles its own runs, but nothing will update this run's items, so
    // settle them here rather than leave permanent queued placeholders.
    const message = error instanceof Error ? error.message : 'Generation failed'
    imageGen.failGeneration(message)
    imageGen.untrackArtifactRun(runId)
    return failed(message)
  } finally {
    ctx.abortSignal?.removeEventListener('abort', onAbort)
  }

  // A refused submission left nothing of this run in flight — drop the queued
  // stubs so the history shows no permanent placeholders.
  if (result.state === 'failed' && result.items.length === 0) {
    if (
      result.error === 'Another generation is already in progress' ||
      !items.some((item) => item.state !== 'queued')
    ) {
      removeQueuedStubs()
    }
    // Fail-fast (and other no-event failures) never emit a terminal phase, so
    // the projection would keep this runId forever without an explicit untrack.
    imageGen.untrackArtifactRun(runId)
  }
  return result
}
