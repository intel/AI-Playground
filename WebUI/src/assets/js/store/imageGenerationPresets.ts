import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { makeFileBackedPreference } from '@/lib/fileBackedPreferences'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { makeForwardPersist } from '@/lib/ipcPersist'
import { useComfyUiPresets } from './comfyUiPresets'
import { useDemoMode } from './demoMode'
import { useI18N } from './i18n'
import { useErrors } from './errors'
import { createAppError } from '../errors/appError'
import { useBackendServices } from './backendServices'
import { connectKernelEventStream } from '@/assets/js/projection/kernelProjection'
import type { ArtifactPhase, ArtifactRunOwner } from '@/types/kernelEvents'
import { usePresets, presetRequiresUserPrompt, type ComfyInput } from './presets'

// ComfyUI model-name/path helpers and the optional-model sentinel live in
// `@/lib/comfyWorkflow` (shared with the main-process artifact runner) and are
// re-exported here because this store has always been their import site.
import {
  normalizeComfyUIModelName,
  OPTIONAL_MODEL_NONE,
  requiredModelToComfyUIName,
} from '@/lib/comfyWorkflow'
export {
  modelNameForComfyApi,
  normalizeComfyUIModelName,
  OPTIONAL_MODEL_NONE,
  requiredModelToComfyUIName,
} from '@/lib/comfyWorkflow'
import { useUIStore } from './ui'
import type { PresetRequirementsData } from './dialogs'
import { getMissingComfyuiBackendModels } from './imageGenerationUtils'
import { requestDownload } from '@/assets/js/permissions/permissions'
import { imageUrlToDataUri, saveImageToMediaInput } from '@/lib/utils'
import { referenceSlotToFill } from '@/lib/referenceImageFit'
import { withTraceSpan } from '@/lib/laminarSpans'
import { runArtifact, type ArtifactKind, type ArtifactResult } from '../artifact/runArtifact'
import type { Preset } from './presets'
import {
  getDemoModeInputImage,
  getDemoModeSketchInputImage,
  getDemoModeUpscaleInputImage,
} from './demoModeDefaults'

// MediaItem, the generation FSM state vocabulary and their predicates live in
// `@/types/mediaItem` (shared with the main-process artifact runner and the
// kernel event vocabulary) and are re-exported here as the historical import
// site.
import {
  isInFlight,
  type GenerateState,
  type ImageMediaItem,
  type MediaItem,
} from '@/types/mediaItem'
export {
  hasDisplayableMedia,
  isInFlight,
  is3D,
  isImage,
  isVideo,
  PLACEHOLDER_IMAGE_URL,
} from '@/types/mediaItem'
export type {
  ComfyDynamicInputWithCurrent,
  GenerateState,
  GenerationSettings,
  ImageMediaItem,
  MediaItem,
  MediaItemState,
  Model3DMediaItem,
  VideoMediaItem,
} from '@/types/mediaItem'

const globalDefaultSettings = {
  seed: -1,
  width: 512,
  height: 512,
  inferenceSteps: 4,
  resolution: '512x512',
  batchSize: 1,
  negativePrompt: 'nsfw',
  safetyCheck: true,
}

const generalDefaultSettings = {
  prompt: '',
  seed: -1,
  safetyCheck: true,
  showPreview: true,
}

export const backendToService: Record<'comfyui', BackendServiceName> = {
  comfyui: 'comfyui-backend',
}

/**
 * Persistence key for a preset's saved settings and dynamic inputs: the preset
 * name, or `preset:variant` when one is applied. Shared by this store's
 * settings-per-preset map and the artifact runner, which resolves a workflow's
 * saved inputs without making it the active preset.
 */
export function presetSettingsKey(presetName: string, variant?: string | null): string {
  return variant ? `${presetName}:${variant}` : presetName
}

export { findBestResolution } from './imageGenerationUtils'

export const useImageGenerationPresets = defineStore('imageGenerationPresets', () => {
  const demoMode = useDemoMode()
  const presetsStore = usePresets()
  const comfyUi = useComfyUiPresets()
  const backendServices = useBackendServices()
  const uiStore = useUIStore()
  const errors = useErrors()
  const i18nState = useI18N().state

  const activePreset = computed(() => {
    console.log('### activePreset', presetsStore.activePresetWithVariant)
    if (presetsStore.activePresetWithVariant?.type === 'comfy')
      return presetsStore.activePresetWithVariant
    return null
  })

  const processing = ref(false)
  const stopping = ref(false)

  const selectedGeneratedImageId = ref<string | null>(null)
  const selectedEditedImageId = ref<string | null>(null)
  const selectedVideoId = ref<string | null>(null)

  // general settings
  const prompt = ref<string>(generalDefaultSettings.prompt)
  const seed = ref<number>(generalDefaultSettings.seed)
  const safetyCheck = ref<boolean>(generalDefaultSettings.safetyCheck)
  const showPreview = ref<boolean>(generalDefaultSettings.showPreview)
  const batchSize = ref<number>(globalDefaultSettings.batchSize)

  const resetActivePresetSettings = () => {
    prompt.value = generalDefaultSettings.prompt
    seed.value = generalDefaultSettings.seed
    safetyCheck.value = generalDefaultSettings.safetyCheck
    showPreview.value = generalDefaultSettings.showPreview
    const settingsKey = getSettingsKey()
    if (settingsKey) {
      settingsPerPreset.value[settingsKey] = {}
      comfyInputsPerPreset.value[settingsKey] = undefined
    }
    loadSettingsForActivePreset()
  }

  // model specific settings
  const negativePrompt = ref<string>(globalDefaultSettings.negativePrompt)
  const width = ref<number>(globalDefaultSettings.width)
  const height = ref<number>(globalDefaultSettings.height)
  const inferenceSteps = ref<number>(globalDefaultSettings.inferenceSteps)
  const resolution = computed({
    get() {
      return `${width.value}x${height.value}`
    },
    set(newValue) {
      ;[width.value, height.value] = newValue.split('x').map(Number)
    },
  })

  // Get setting value from preset settings array
  const getSettingValue = (settingName: string): unknown => {
    if (!activePreset.value) return null
    const setting = activePreset.value.settings.find(
      (s) => 'settingName' in s && s.settingName === settingName,
    )
    return setting?.defaultValue ?? null
  }

  // Check if setting is displayed or modifiable
  const settingIsRelevant = (settingName: string): boolean => {
    if (!activePreset.value) return false
    const setting = activePreset.value.settings.find(
      (s) => 'settingName' in s && s.settingName === settingName,
    )
    return setting ? setting.displayed || setting.modifiable : false
  }

  const settings = {
    seed,
    inferenceSteps,
    width,
    height,
    resolution,
    batchSize,
    negativePrompt,
    safetyCheck,
    showPreview,
  }

  const backend = computed(() => {
    console.log('### computing backend', activePreset.value?.backend)
    if (!activePreset.value) return 'comfyui' as const
    return activePreset.value.backend as 'comfyui'
  })

  const modelOptionsByType = ref<Record<string, string[]>>({})

  const comfyInputs = computed(() => {
    if (!activePreset.value || activePreset.value.backend !== 'comfyui') return []
    const inputRef = (input: ComfyInput): string => `${input.nodeTitle}.${input.nodeInput}`
    const savePerPreset = (input: ComfyInput, newValue: unknown) => {
      const settingsKey = getSettingsKey()
      if (!settingsKey) return
      comfyInputsPerPreset.value[settingsKey] = {
        ...comfyInputsPerPreset.value[settingsKey],
        [inputRef(input)]: newValue,
      }
    }
    const getSavedOrDefault = (input: ComfyInput) => {
      const settingsKey = getSettingsKey()
      const raw = settingsKey
        ? (comfyInputsPerPreset.value[settingsKey]?.[inputRef(input)] ?? input.defaultValue)
        : input.defaultValue
      if (
        input.type === 'model' &&
        input.optional === true &&
        (raw === undefined || raw === '' || raw === OPTIONAL_MODEL_NONE)
      ) {
        return OPTIONAL_MODEL_NONE
      }
      return raw
    }

    const comfyInputs = activePreset.value.settings.filter(
      (s): s is ComfyInput => 'nodeTitle' in s && 'nodeInput' in s,
    )
    return comfyInputs.map((input) => {
      const _current = ref(getSavedOrDefault(input))

      const current = computed({
        get() {
          return _current.value
        },
        set(newValue) {
          _current.value = newValue
          savePerPreset(input, newValue)
        },
      })

      const base = { ...input, current }
      if (input.type === 'model' && input.modelType) {
        return { ...base, options: modelOptionsByType.value[input.modelType] ?? [] }
      }
      return base
    })
  })

  type PresetName = string
  type NodeInputReference = string
  const comfyInputsPerPreset = ref<
    Record<PresetName, Record<NodeInputReference, unknown> | undefined>
  >({})
  const settingsPerPreset = ref<Record<PresetName, Record<string, unknown>>>({})

  // Step 8 (§6.1): the per-preset settings are kernel-owned preferences
  // (preferences.json), hydrated before mount. Same legacy Pinia key as the
  // gallery records — hence legacySlim, so this half leaves the media half
  // for its own migrator (the two run sequentially inside init()).
  const settingsPrefs = makeFileBackedPreference({
    section: 'imageGenerationPresets',
    refs: { settingsPerPreset, comfyInputsPerPreset },
    legacyKey: 'imageGenerationPresets',
    legacySlim: true,
    toFile: (section) => {
      // `comfyUiPresets.queueBatch` snapshots each `comfyInputs[i].current.value`
      // into `MediaItem.dynamicSettings[].current`. Inpaint mask / outpaint
      // composite data URIs would inflate the persisted per-preset inputs —
      // keep them in memory but scrub the file copy (the old pinia
      // serializer's rule, moved here with the data).
      const isPersistableDataUri = (v: unknown): v is string =>
        typeof v === 'string' && (v.startsWith('data:image/') || v.startsWith('data:video/'))
      const inputs = section.comfyInputsPerPreset as Record<
        string,
        Record<string, unknown> | undefined
      >
      const filteredInputs: typeof inputs = {}
      for (const [presetName, presetInputs] of Object.entries(inputs)) {
        if (presetInputs === undefined) continue
        const filtered: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(presetInputs)) {
          if (!isPersistableDataUri(value)) filtered[key] = value
        }
        filteredInputs[presetName] = filtered
      }
      return { ...section, comfyInputsPerPreset: filteredInputs }
    },
  })

  let modelOptionsLoadToken = 0

  async function loadModelOptionsForActivePreset() {
    const loadToken = ++modelOptionsLoadToken
    const preset = activePreset.value
    if (!preset || preset.backend !== 'comfyui') {
      modelOptionsByType.value = {}
      return
    }
    const modelInputs = preset.settings.filter(
      (s): s is ComfyInput & { modelType: string } =>
        'nodeTitle' in s && 'nodeInput' in s && s.type === 'model' && !!s.modelType,
    )
    const modelTypes = [...new Set(modelInputs.map((s) => s.modelType))]
    const required = preset.requiredModels ?? []
    const optionalModelTypes = new Set(
      modelInputs.filter((s) => s.optional === true).map((s) => s.modelType),
    )
    const nextOptions: Record<string, string[]> = {}
    for (const modelType of modelTypes) {
      let fromDisk: string[] = []
      try {
        fromDisk = await window.electronAPI.getComfyUIModels(modelType)
      } catch (e) {
        console.error('Failed to load ComfyUI models', { modelType, error: e })
        // ComfyUI path may be missing or backend not running; still show required models
      }
      const fromRequired = required
        .filter((r) => r.type === modelType)
        .map((r) => requiredModelToComfyUIName(r.model))
      const normalizedRequired = fromRequired.map(normalizeComfyUIModelName)
      const normalizedDisk = fromDisk.map(normalizeComfyUIModelName)
      let merged = [...new Set([...normalizedRequired, ...normalizedDisk])]
      if (optionalModelTypes.has(modelType)) {
        merged = [OPTIONAL_MODEL_NONE, ...merged]
      }
      nextOptions[modelType] = merged
    }
    if (loadToken === modelOptionsLoadToken) {
      modelOptionsByType.value = nextOptions
    }
  }

  // Watch preset object so we re-run after preset reload (same name, new definition) and on preset switch
  watch(
    () => activePreset.value,
    () => {
      loadModelOptionsForActivePreset()
    },
    { immediate: true },
  )

  // Watch resolution changes and sync to target width/height ComfyInputs (for inpainting with target resolution)
  watch(resolution, (newResolution) => {
    const [newWidth, newHeight] = newResolution.split('x').map(Number)

    // Find target width and height ComfyInputs
    const targetWidthInput = comfyInputs.value.find(
      (input) => input.nodeTitle === 'width' && input.nodeInput === 'value',
    )
    const targetHeightInput = comfyInputs.value.find(
      (input) => input.nodeTitle === 'height' && input.nodeInput === 'value',
    )

    // Update them if they exist
    if (targetWidthInput && targetWidthInput.current) {
      targetWidthInput.current.value = newWidth
    }
    if (targetHeightInput && targetHeightInput.current) {
      targetHeightInput.current.value = newHeight
    }
  })

  const isModifiable = (settingName: string): boolean => {
    if (!activePreset.value) return false
    const setting = activePreset.value.settings.find(
      (s) => 'settingName' in s && s.settingName === settingName,
    )
    return setting?.modifiable ?? false
  }

  /**
   * Whether the currently active ComfyUI preset requires a user-entered
   * prompt. Defaults to `true` when no preset is active so that bare-bones
   * UI states still treat the prompt as required.
   *
   * The source of truth is the structured prompt setting (see
   * `presetRequiresUserPrompt`). Submission/validation code (e.g.
   * `PromptArea.vue`) MUST consult this flag rather than re-deriving the
   * contract locally.
   */
  const requiresUserPrompt = computed(() =>
    activePreset.value ? presetRequiresUserPrompt(activePreset.value) : true,
  )

  // Change the settings key to include variant
  function getSettingsKey(): string {
    if (!activePreset.value?.name) return ''
    let variantName: string | undefined = presetsStore.activeVariantName[activePreset.value.name]

    // If preset has variants but no variant is selected, use first variant
    if (!variantName && activePreset.value.variants && activePreset.value.variants.length > 0) {
      const firstVariant = presetsStore.getFirstVariantName(activePreset.value)
      if (firstVariant) {
        variantName = firstVariant
      }
    }

    return presetSettingsKey(activePreset.value.name, variantName)
  }

  // Note: Preset/variant changes are now handled by the orchestrator (usePresetSwitching),
  // which calls loadSettingsForActivePreset() explicitly. No watcher needed.

  function applyReferenceUrl(imageUrl: string) {
    const inputs = comfyInputs.value.filter((input) => input.type === 'image')
    const index = referenceSlotToFill(
      inputs.map((input) => ({ optional: input.optional, value: input.current.value })),
      imageUrl,
    )
    if (index === null) return
    inputs[index].current.value = imageUrl
  }

  // History selection (and a repeat click on the already-selected row) fills the
  // primary reference slot. An image that is already in a slot was just loaded
  // there, so it must not be copied onto slot 1.
  function syncSelectedReferenceImage() {
    const category = activePreset.value?.category
    const id =
      category === 'edit-images'
        ? selectedEditedImageId.value
        : category === 'create-videos'
          ? selectedVideoId.value
          : null
    if (!id) return
    const image = generatedImages.value.find((img) => img.id === id)
    if (!image || image.type !== 'image' || !image.fromImageGen) return
    applyReferenceUrl(image.imageUrl)
  }

  watch(
    () => [selectedEditedImageId.value, selectedVideoId.value, activePreset.value?.name] as const,
    () => {
      syncSelectedReferenceImage()
    },
  )

  // Keep resolution in sync with width/height
  watch(resolution, () => {
    const [w, h] = resolution.value.split('x').map(Number)
    settings.width.value = w
    settings.height.value = h
  })

  watch([inferenceSteps, width, height, batchSize], () => {
    console.log('### watch inferenceSteps, width, height, batchSize', {
      inferenceSteps: inferenceSteps.value,
      width: width.value,
      height: height.value,
      batchSize: batchSize.value,
    })
    const saveToSettingsPerPreset = (settingName: keyof typeof settings) => {
      const settingsKey = getSettingsKey()
      if (!settingsKey) return
      if (isModifiable(settingName)) {
        settingsPerPreset.value[settingsKey] = {
          ...settingsPerPreset.value[settingsKey],
          [settingName]: settings[settingName]?.value,
        }
      }
    }
    saveToSettingsPerPreset('seed')
    saveToSettingsPerPreset('inferenceSteps')
    saveToSettingsPerPreset('width')
    saveToSettingsPerPreset('height')
    saveToSettingsPerPreset('resolution')
    saveToSettingsPerPreset('batchSize')
    saveToSettingsPerPreset('negativePrompt')
    saveToSettingsPerPreset('safetyCheck')
    saveToSettingsPerPreset('showPreview')
  })

  const generatedImages = ref<MediaItem[]>([])
  const currentState = ref<GenerateState>('no_start')
  const stepText = ref('')
  // Human-readable message for the most recent generation failure. Drives the
  // error panel in WorkflowResult.vue and the tool-call watchers; cleared at the
  // start of each generate().
  const lastError = ref<string | null>(null)

  // When a generation is started by a chat tool call, the tool sets this to its
  // activity id so the generation-phase activity (created in comfyUiPresets) nests
  // under the chat turn's activity. Null for the desktop image-gen path.
  const generationParentActivityId = ref<string | null>(null)

  // Flip every not-yet-terminal media item to a terminal state. This is the
  // single place generation failures/cancellations land, so the UI and tool
  // watchers can no longer get stuck on an item that never leaves
  // 'queued'/'generating'.
  function settleInFlightItems(state: 'failed' | 'stopped') {
    generatedImages.value = generatedImages.value.map((item) =>
      isInFlight(item) ? { ...item, state } : item,
    )
  }

  // ── Kernel-owned gallery records (step 8 / step 11, §6.1) ────────────────
  // `generatedImages` is a live projection of `media/records/` files. Completed
  // renderer-origin runs persist from the artifact runner; this store writes
  // only user mutations (add/delete). In-flight items are never durable.
  const MEDIA_LEGACY_KEY = 'imageGenerationPresets'
  /** Set once `init()` has hydrated (or migrated) — gates every write-through. */
  const mediaRecordsHydrated = ref(false)
  let mediaRecordsInitPromise: Promise<void> | null = null
  const FLUSH_DEBOUNCE_MS = 300
  let mediaFlushTimer: ReturnType<typeof setTimeout> | null = null
  let mediaFlushInFlight = false
  /** id → JSON of what the record files hold; the diff base for save/delete. */
  const flushedMediaItems = new Map<string, string>()

  const persistMediaMutation = makeForwardPersist({
    code: 'media-records/persist-failed',
    technicalMessage: 'the media record file store rejected the write',
  })

  function mediaItemJson(item: MediaItem): string {
    return JSON.stringify(item)
  }

  function scheduleMediaRecordsFlush(): void {
    if (!mediaRecordsHydrated.value) return
    if (mediaFlushTimer) clearTimeout(mediaFlushTimer)
    mediaFlushTimer = setTimeout(() => {
      mediaFlushTimer = null
      void flushMediaRecords()
    }, FLUSH_DEBOUNCE_MS)
  }

  async function flushMediaRecords(): Promise<void> {
    if (!mediaRecordsHydrated.value) return
    if (mediaFlushInFlight) {
      // Re-arm instead of overlapping: this flush must diff against the
      // post-IPC base the in-flight one is about to write.
      scheduleMediaRecordsFlush()
      return
    }
    const doneItems = generatedImages.value.filter((item) => item.state === 'done')
    const currentIds = new Set<string>()
    const changed: MediaItem[] = []
    for (const item of doneItems) {
      currentIds.add(item.id)
      if (flushedMediaItems.get(item.id) !== mediaItemJson(item)) changed.push(item)
    }
    const removed = [...flushedMediaItems.keys()].filter((id) => !currentIds.has(id))
    if (changed.length === 0 && removed.length === 0) return
    mediaFlushInFlight = true
    const errorsStore = useErrors()
    try {
      if (changed.length > 0) {
        const result = await window.electronAPI.mediaItems.save(cloneForIpc(changed))
        if (result.success) {
          for (const item of changed) flushedMediaItems.set(item.id, mediaItemJson(item))
        } else {
          // The items stay un-flushed, so the next flush retries them.
          errorsStore.report(new Error(result.error), {
            category: 'backend',
            code: 'media-records/save-failed',
            severity: 'warning',
            surface: 'silent',
            technicalMessage: 'the media record file store rejected the write',
          })
        }
      }
      if (removed.length > 0) {
        const result = await window.electronAPI.mediaItems.delete(removed)
        if (result.success) {
          for (const id of removed) flushedMediaItems.delete(id)
        } else {
          errorsStore.report(new Error(result.error), {
            category: 'backend',
            code: 'media-records/delete-failed',
            severity: 'warning',
            surface: 'silent',
            technicalMessage: 'the media record file store rejected the delete',
          })
        }
      }
    } finally {
      mediaFlushInFlight = false
    }
  }

  function addGalleryItem(item: MediaItem): void {
    generatedImages.value.push(item)
    if (!mediaRecordsHydrated.value || item.state !== 'done') return
    persistMediaMutation(() =>
      window.electronAPI.mediaItems.save(cloneForIpc([item])).then((result) => {
        if (result.success) flushedMediaItems.set(item.id, mediaItemJson(item))
        return result
      }),
    )
  }

  function deleteRecordIds(ids: string[]): void {
    if (!mediaRecordsHydrated.value || ids.length === 0) return
    for (const id of ids) flushedMediaItems.delete(id)
    persistMediaMutation(() => window.electronAPI.mediaItems.delete(ids))
  }

  function persistMediaRecordsNow(): void {
    if (mediaFlushTimer) {
      clearTimeout(mediaFlushTimer)
      mediaFlushTimer = null
    }
    void flushMediaRecords()
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('beforeunload', persistMediaRecordsNow)
  }

  /** Read the pre-step-8 Pinia payload's gallery, if any, for the one-shot upload. */
  function readLegacyGeneratedImages(): unknown[] | null {
    const raw = demoAwareStorage.getItem(MEDIA_LEGACY_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as { generatedImages?: unknown }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.generatedImages)) {
        return null
      }
      return parsed.generatedImages.length > 0 ? parsed.generatedImages : null
    } catch {
      return null
    }
  }

  // Slim only the gallery half; the settings half of this key is uploaded
  // next. A failed upload leaves `generatedImages` in place to retry next boot.
  function slimLegacyKey(): void {
    const raw = demoAwareStorage.getItem(MEDIA_LEGACY_KEY)
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object' || !('generatedImages' in parsed)) return
      delete parsed.generatedImages
      if (Object.keys(parsed).length === 0) {
        demoAwareStorage.removeItem(MEDIA_LEGACY_KEY)
      } else {
        demoAwareStorage.setItem(MEDIA_LEGACY_KEY, JSON.stringify(parsed))
      }
    } catch {
      // An unparsable payload is best left alone; the next boot retries it.
    }
  }

  async function init(): Promise<void> {
    if (mediaRecordsInitPromise) return mediaRecordsInitPromise
    mediaRecordsInitPromise = (async () => {
      const errorsStore = useErrors()
      let bootstrap: Awaited<ReturnType<typeof window.electronAPI.mediaItems.bootstrap>> | null =
        null
      let bootstrapError: unknown = null
      try {
        bootstrap = await window.electronAPI.mediaItems.bootstrap()
        const legacy = readLegacyGeneratedImages()
        if (legacy) {
          // Merge-migrate (idempotent): it also rescues the case where an
          // index exists but the legacy upload never ran — a boot whose
          // bootstrap failed wrote session items to files, which used to
          // strand the gallery copy in the key.
          const migrated = await window.electronAPI.mediaItems.migrate(legacy)
          if (migrated.status === 'ok') {
            bootstrap = migrated
            slimLegacyKey()
          } else if (migrated.status === 'error') {
            if (bootstrap.status === 'ok') {
              // The rescue failed; keep the file view, leave the key for the
              // next boot, but do not lose the failure silently.
              errorsStore.report(new Error(migrated.error), {
                category: 'backend',
                code: 'media-records/migrate-failed',
                severity: 'warning',
                surface: 'silent',
                technicalMessage: 'the legacy gallery upload failed; keeping the key to retry',
              })
            } else {
              // Nothing to fall back to — the generic error path reports it.
              bootstrap = { status: 'error', error: migrated.error }
            }
          }
        } else if (bootstrap.status !== 'error') {
          slimLegacyKey()
        }
      } catch (error) {
        bootstrap = null
        bootstrapError = error
      }
      if (!bootstrap) {
        errorsStore.report(bootstrapError ?? new Error('media records bootstrap IPC failed'), {
          category: 'backend',
          code: 'media-records/bootstrap-failed',
          severity: 'warning',
          surface: 'silent',
          technicalMessage: 'the record file store did not answer',
        })
      } else if (bootstrap.status === 'error') {
        errorsStore.report(new Error(bootstrap.error), {
          category: 'backend',
          code: 'media-records/bootstrap-failed',
          severity: 'warning',
          surface: 'silent',
          technicalMessage: 'the record file store rejected the boot hydration',
        })
        bootstrap = null
      }
      if (bootstrap && bootstrap.status === 'ok') {
        generatedImages.value = bootstrap.items
      }
      // On a failed bootstrap the live gallery stays empty (`generatedImages`
      // is not in the persist pick, so Pinia cannot hydrate the leftover
      // key). The leftover key is kept so the next boot can merge-migrate;
      // write-through of an empty projection would not recover it. The diff
      // base always mirrors the ref as booted.
      flushedMediaItems.clear()
      for (const item of generatedImages.value) {
        if (item.state === 'done') flushedMediaItems.set(item.id, mediaItemJson(item))
      }
      mediaRecordsHydrated.value = true
      // The per-preset settings ride the same legacy Pinia key: run after
      // the media half so the two slims never interleave — each must see
      // the other's completed write, or a removed half comes back on the
      // next boot and the key never runs empty.
      await settingsPrefs.init()
    })()
    return mediaRecordsInitPromise
  }

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      settingsPrefs.dispose()
      if (mediaFlushTimer) clearTimeout(mediaFlushTimer)
      if (typeof window.removeEventListener === 'function') {
        window.removeEventListener('beforeunload', persistMediaRecordsNow)
      }
    })
  }

  function failGeneration(message: string) {
    lastError.value = message
    settleInFlightItems('failed')
    currentState.value = 'error'
    processing.value = false
    stopping.value = false
  }

  function cancelGeneration() {
    settleInFlightItems('stopped')
    currentState.value = 'no_start'
    processing.value = false
    stopping.value = false
  }

  function loadSettingsForActivePreset() {
    if (!activePreset.value) return

    const settingsKey = getSettingsKey()
    console.log(
      '### loadSettingsForActivePreset',
      settingsKey,
      JSON.stringify(settingsPerPreset.value[settingsKey], null, 2),
    )
    const getSavedOrDefault = (settingName: string) => {
      if (!settingsKey) return
      const saved = settingsPerPreset.value[settingsKey]?.[settingName]
      const presetValue = getSettingValue(settingName)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const globalDefaultValue: any =
        globalDefaultSettings[settingName as keyof typeof globalDefaultSettings]
      return saved ?? presetValue ?? globalDefaultValue
    }

    // Load standard settings from preset
    seed.value = getSavedOrDefault('seed') ?? generalDefaultSettings.seed
    inferenceSteps.value =
      getSavedOrDefault('inferenceSteps') ?? globalDefaultSettings.inferenceSteps
    width.value = getSavedOrDefault('width') ?? globalDefaultSettings.width
    height.value = getSavedOrDefault('height') ?? globalDefaultSettings.height
    resolution.value = getSavedOrDefault('resolution') ?? globalDefaultSettings.resolution
    batchSize.value = getSavedOrDefault('batchSize') ?? globalDefaultSettings.batchSize
    negativePrompt.value =
      getSavedOrDefault('negativePrompt') ?? globalDefaultSettings.negativePrompt
    safetyCheck.value = getSavedOrDefault('safetyCheck') ?? generalDefaultSettings.safetyCheck
    showPreview.value = getSavedOrDefault('showPreview') ?? generalDefaultSettings.showPreview

    syncSelectedReferenceImage()

    preloadImageDuringDemo()
  }

  async function preloadImageDuringDemo() {
    if (demoMode.enabled && activePreset.value?.category === 'edit-images') {
      const imageInput = comfyInputs.value.find((input) => input.type === 'image')
      let demoImage: string | null
      switch (activePreset.value?.name) {
        case 'Sketch to Photo':
          demoImage = getDemoModeSketchInputImage()
          break
        case 'Upscale':
          demoImage = getDemoModeUpscaleInputImage()
          break
        default:
          demoImage = getDemoModeInputImage()
      }
      if (imageInput && demoImage) {
        imageInput.current.value = await imageUrlToDataUri(demoImage)
      }

      // Also add the demo image to the history if not already present for this preset
      if (demoImage) {
        const alreadyInHistory = generatedImages.value.some(
          (img) =>
            img.mode === 'imageEdit' &&
            img.type === 'image' &&
            img.fromImageGen &&
            img.sourceImageUrl === demoImage,
        )
        if (!alreadyInHistory) {
          const sourceItem: ImageMediaItem = {
            id: 'demo-source',
            type: 'image',
            state: 'done',
            mode: 'imageEdit',
            imageUrl: demoImage,
            settings: {},
          }
          await copyImageAsInputForMode(sourceItem, 'imageEdit')
        }
      }
    }
  }

  async function copyImageAsInputForMode(image: MediaItem, mode: WorkflowModeType) {
    const newImage: MediaItem = { ...image, id: crypto.randomUUID(), createdAt: Date.now() }
    newImage.mode = mode
    if (image.type === 'image' && newImage.type === 'image') {
      newImage.sourceImageUrl = image.imageUrl
      if (image.imageUrl.startsWith('aipg-media://')) {
        newImage.imageUrl = image.imageUrl
      } else {
        try {
          const dataUri = await imageUrlToDataUri(image.imageUrl)
          newImage.imageUrl = await saveImageToMediaInput(dataUri)
        } catch (error) {
          errors.report(error, {
            category: 'generation',
            code: 'generation/copy-input-failed',
            userMessage: 'Could not copy the image as a generation input.',
          })
        }
      }
      newImage.fromImageGen = true
    }

    addGalleryItem(newImage)
    if (mode === 'imageEdit') {
      selectedEditedImageId.value = newImage.id
    } else if (mode === 'video') {
      selectedVideoId.value = newImage.id
    }
  }

  function updateImage(newImage: MediaItem) {
    const existingImageIndex = generatedImages.value.findIndex((img) => img.id === newImage.id)
    if (existingImageIndex !== -1) {
      generatedImages.value.splice(existingImageIndex, 1, newImage)
    } else {
      generatedImages.value.push(newImage)
    }
  }

  // Only panel-owned runs drive the Image Gen overlay; tool-owned runs render
  // on their own tool card (artifactRuns store).
  const trackedArtifactRunIds = new Set<string>()
  function trackArtifactRun(runId: string): void {
    trackedArtifactRunIds.add(runId)
  }
  function untrackArtifactRun(runId: string): void {
    trackedArtifactRunIds.delete(runId)
  }

  function adoptArtifactRun(runId: string, owner?: ArtifactRunOwner): boolean {
    if (trackedArtifactRunIds.has(runId)) return true
    if (owner?.kind !== 'panel') return false
    trackArtifactRun(runId)
    return true
  }

  // ── Artifact run projection (architecture-target §4.1 step 5) ────────────
  // The main-process artifact runner is the engine; its kernel events drive
  // this store's legacy FSM vocabulary, so every downstream consumer (the
  // generation overlay, the FSM→activity bridge, the tool watchers) keeps
  // working unchanged. Phases map 1:1 onto the states the old engine set.
  function applyArtifactPhase(
    runId: string,
    phase: ArtifactPhase,
    progress?: { current: number; max: number },
    error?: string,
  ): void {
    switch (phase) {
      case 'queued':
        processing.value = true
        break
      case 'preparing-backend':
        processing.value = true
        currentState.value = 'start_backend'
        stepText.value = ''
        break
      case 'installing-components':
        processing.value = true
        currentState.value = 'install_workflow_components'
        break
      case 'loading-components':
        processing.value = true
        currentState.value = 'load_workflow_components'
        break
      case 'loading-model':
        processing.value = true
        currentState.value = 'load_model'
        break
      case 'running':
        processing.value = true
        currentState.value = 'generating'
        if (progress) {
          stepText.value = `${i18nState.COM_GENERATING} ${progress.current}/${progress.max}`
        }
        break
      case 'completed':
        processing.value = false
        currentState.value = 'image_out'
        stepText.value = ''
        untrackArtifactRun(runId)
        break
      case 'failed':
        failGeneration(error ?? 'Generation failed')
        untrackArtifactRun(runId)
        break
      case 'cancelled':
        cancelGeneration()
        untrackArtifactRun(runId)
        break
    }
  }

  const artifactProjection = connectKernelEventStream(
    (event) => {
      if (event.type === 'artifact-phase') {
        if (!adoptArtifactRun(event.runId, event.owner)) return
        applyArtifactPhase(event.runId, event.phase, event.progress, event.error)
      } else if (event.type === 'artifact-item') {
        if (adoptArtifactRun(event.runId, event.owner)) {
          updateImage(event.item)
        } else if (event.origin === 'renderer' && event.item.state === 'done') {
          // Chat tool output joins the gallery as main persists it, without the overlay.
          updateImage(event.item)
        }
      }
    },
    (snapshot) => {
      // A reconnected renderer resumes a panel run. Tool runs share this
      // snapshot slot but must not paint the panel.
      const run = snapshot.state.activeArtifactRun
      if (!run) return
      const known = new Set(generatedImages.value.map((item) => item.id))
      const hasTrackedItems = run.items.some((item) => known.has(item.id))
      if (!hasTrackedItems && run.owner?.kind !== 'panel') return
      trackArtifactRun(run.runId)
      applyArtifactPhase(run.runId, run.phase, run.progress, run.error ?? undefined)
      for (const item of run.items) {
        if (hasTrackedItems && !known.has(item.id)) continue
        updateImage(item)
      }
    },
  )
  artifactProjection.ready.catch((reason: unknown) => {
    console.warn('artifact run snapshot unavailable; waiting on stream events instead', reason)
  })
  if (import.meta.hot) {
    import.meta.hot.dispose(() => artifactProjection.dispose())
  }

  async function getMissingModelsFor(preset: Preset | null): Promise<DownloadModelParam[]> {
    if (!preset) return []
    return getMissingComfyuiBackendModels(preset.requiredModels ?? [])
  }

  async function getMissingModels(): Promise<DownloadModelParam[]> {
    return getMissingModelsFor(activePreset.value)
  }

  async function ensureModelsAreAvailableFor(preset: Preset | null): Promise<void> {
    // Avoid the `new Promise(async (resolve, reject) => ...)` antipattern:
    // an exception inside an async executor becomes an unhandled rejection
    // and the outer promise never settles. Now that getMissingModels() can
    // throw (when a required model is unavailable), this matters.
    const downloadList = await getMissingModelsFor(preset)
    if (downloadList.length === 0) return
    // Traced only when something is actually missing: a `models.download` span
    // in a trace means multi-GB files were fetched before generating, which is
    // usually the reason a first run took so much longer than the next.
    return withTraceSpan('models.download', () => requestDownload(downloadList), {
      attributes: {
        'aipg.models': downloadList.map((model) => model.repo_id).join(', ') || undefined,
      },
    })
  }

  async function ensureModelsAreAvailable(): Promise<void> {
    return ensureModelsAreAvailableFor(activePreset.value)
  }

  /**
   * Validates all requirements for a preset (backend, custom nodes, Python
   * packages, models) without making it the active preset.
   */
  async function validatePresetRequirementsFor(preset: Preset | null): Promise<{
    backendRunning: boolean
    missingCustomNodes: string[]
    missingPythonPackages: string[]
    missingModels: DownloadModelParam[]
    allRequirementsMet: boolean
  }> {
    if (!preset) {
      return {
        backendRunning: false,
        missingCustomNodes: [],
        missingPythonPackages: [],
        missingModels: [],
        allRequirementsMet: false,
      }
    }

    // Check backend status
    const backendServiceName =
      preset.type === 'comfy' ? backendToService[preset.backend as 'comfyui'] : 'comfyui-backend'
    const backendInfo = backendServices.info.find((s) => s.serviceName === backendServiceName)
    const backendRunning = backendInfo?.status === 'running'

    // Check custom nodes and Python packages (only for ComfyUI presets)
    let missingCustomNodes: string[] = []
    let missingPythonPackages: string[] = []
    if (preset.type === 'comfy') {
      const requirements = await comfyUi.checkPresetRequirements(preset)
      missingCustomNodes = requirements.missingCustomNodes
      missingPythonPackages = requirements.missingPythonPackages
    }

    // Check models
    const missingModels = await getMissingModelsFor(preset)

    const allRequirementsMet =
      backendRunning &&
      missingCustomNodes.length === 0 &&
      missingPythonPackages.length === 0 &&
      missingModels.length === 0

    return {
      backendRunning,
      missingCustomNodes,
      missingPythonPackages,
      missingModels,
      allRequirementsMet,
    }
  }

  /**
   * Validates all requirements for the active preset
   * @returns Object containing validation results for backend, custom nodes, Python packages, and models
   */
  async function validatePresetRequirements(): Promise<{
    backendRunning: boolean
    missingCustomNodes: string[]
    missingPythonPackages: string[]
    missingModels: DownloadModelParam[]
    allRequirementsMet: boolean
  }> {
    return validatePresetRequirementsFor(activePreset.value)
  }

  /**
   * Formats validation results into data structure for requirements dialog
   */
  function formatRequirementsForDialog(validation: {
    missingCustomNodes: string[]
    missingPythonPackages: string[]
    missingModels: DownloadModelParam[]
  }): PresetRequirementsData {
    return {
      missingModels: validation.missingModels.map((model) => ({
        name: model.repo_id,
        type: model.type,
      })),
      missingCustomNodes: validation.missingCustomNodes,
      missingPythonPackages: validation.missingPythonPackages,
    }
  }

  // kind is advisory until per-kind adapters exist (routing is by preset
  // mediaType), but it must still say what the panel actually asked for.
  const MODE_TO_ARTIFACT_KIND: Record<WorkflowModeType, ArtifactKind> = {
    imageGen: 'create-image',
    imageEdit: 'edit-image',
    video: 'create-video',
  }

  /**
   * UI submit path for the Image Gen / Edit / Video panels: build an
   * artifact request from the live form state and hand it to the shared
   * runner. Resolves when the run settles (not when it is queued) — the
   * prompt bar's busy state follows the FSM (`processing`) independently,
   * so callers must not read the promise as "render finished" either way.
   * The panel's source image rides the saved LoadImage inputs (the
   * selectedEditedImageId watch), not `request.source`: multi-slot edit
   * presets manage each slot through its own binding, and a generic
   * source injection would clobber slot 1.
   */
  async function generate(
    mode: WorkflowModeType = 'imageGen',
  ): Promise<ArtifactResult | undefined> {
    const preset = activePreset.value
    if (!preset || preset.type !== 'comfy') {
      errors.report(
        createAppError({
          category: 'validation',
          code: 'generation/no-preset',
          userMessage: 'No preset selected.',
          surface: 'toast',
        }),
      )
      return
    }

    lastError.value = null
    // Drop abandoned placeholders from a previous cancelled/failed run
    generatedImages.value = generatedImages.value.filter((item) => item.state === 'done')
    // Auto-open history view for batch generation
    if (batchSize.value > 1) {
      uiStore.openHistory()
    }

    const inferenceBackendService = backendToService[backend.value]
    await backendServices.resetLastUsedInferenceBackend(inferenceBackendService)
    await backendServices.updateLastUsedBackend(inferenceBackendService)

    // Overlay and prompt-bar busy flag used to flip on the renderer websocket's
    // execution_start; the runner is in main now, so raise them here.
    processing.value = true
    currentState.value = 'start_backend'
    stepText.value = i18nState.COM_GENERATING

    // UI runs are top-level: no parent activity (the runner resets the stale
    // tool-parented value the previous chat run may have left behind).
    try {
      return await runArtifact({
        kind: MODE_TO_ARTIFACT_KIND[mode],
        workflow: preset.name,
        variant: presetsStore.activeVariantName[preset.name] || undefined,
        mode,
        prompt: prompt.value,
        negativePrompt: negativePrompt.value,
        params: {
          seed: seed.value,
          width: width.value,
          height: height.value,
          inferenceSteps: inferenceSteps.value,
          batchSize: batchSize.value,
        },
      })
    } finally {
      processing.value = false
    }
  }

  function stopGeneration() {
    stopping.value = true
    void window.electronAPI.artifact.cancel().finally(() => cancelGeneration())
  }

  function deleteImage(id: string) {
    generatedImages.value = generatedImages.value.filter((image) => image.id !== id)
    deleteRecordIds([id])

    if (selectedGeneratedImageId.value === id) {
      selectedGeneratedImageId.value = null
    }
    if (selectedEditedImageId.value === id) {
      selectedEditedImageId.value = null
    }
    if (selectedVideoId.value === id) {
      selectedVideoId.value = null
    }
  }

  function deleteAllImages() {
    const ids = generatedImages.value.map((image) => image.id)
    generatedImages.value.length = 0
    deleteRecordIds(ids)
  }

  function deleteAllImagesForMode(mode: WorkflowModeType) {
    const removed = generatedImages.value.filter((image) => image.mode === mode).map((i) => i.id)
    generatedImages.value = generatedImages.value.filter((image) => image.mode !== mode)
    deleteRecordIds(removed)

    switch (mode) {
      case 'imageGen':
        selectedGeneratedImageId.value = null
        break
      case 'imageEdit':
        selectedEditedImageId.value = null
        break
      case 'video':
        selectedVideoId.value = null
        break
    }
  }

  // Initialize with first preset if available
  watch(
    () => presetsStore.presets,
    (presets) => {
      console.log('### watch presets', {
        presets: presetsStore.presets,
        activePreset: activePreset.value,
        activeVariantName: presetsStore.activeVariantName,
      })
      if (presets.length > 0 && !activePreset.value) {
        const firstComfyPreset = presets.find((p) => p.type === 'comfy')
        if (firstComfyPreset) {
          // If preset has variants, select first variant; otherwise pass null
          const firstVariantName =
            firstComfyPreset.variants && firstComfyPreset.variants.length > 0
              ? firstComfyPreset.variants[0].name
              : null
          presetsStore.setActiveVariant(firstComfyPreset.name, firstVariantName)
        }
      }
    },
    { immediate: true },
  )

  return {
    backend,
    activePreset,
    processing,
    prompt,
    generatedImages,
    currentState,
    stepText,
    stopping,
    lastError,
    generationParentActivityId,
    failGeneration,
    cancelGeneration,
    safetyCheck,
    showPreview,
    inferenceSteps,
    seed,
    width,
    height,
    batchSize,
    negativePrompt,
    settingsPerPreset,
    comfyInputsPerPreset,
    comfyInputs,
    resetActivePresetSettings,
    getMissingModels,
    getMissingModelsFor,
    ensureModelsAreAvailable,
    ensureModelsAreAvailableFor,
    validatePresetRequirements,
    validatePresetRequirementsFor,
    formatRequirementsForDialog,
    updateImage,
    trackArtifactRun,
    untrackArtifactRun,
    generate,
    stopGeneration,
    deleteImage,
    deleteAllImages,
    deleteAllImagesForMode,
    selectedGeneratedImageId,
    selectedEditedImageId,
    selectedVideoId,
    settingIsRelevant,
    isModifiable,
    requiresUserPrompt,
    loadSettingsForActivePreset,
    syncSelectedReferenceImage,
    copyImageAsInputForMode,
    addGalleryItem,
    init,
    mediaRecordsHydrated,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useImageGenerationPresets, import.meta.hot))
}
