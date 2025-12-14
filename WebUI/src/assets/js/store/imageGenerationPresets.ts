import { acceptHMRUpdate, defineStore } from 'pinia'
import { useComfyUiPresets } from './comfyUiPresets'
import { useI18N } from './i18n'
import * as toast from '@/assets/js/toast.ts'
import { useBackendServices } from './backendServices'
import { usePresets, type ComfyInput } from './presets'
import { useUIStore } from './ui'
import { PresetRequirementsData, useDialogStore } from './dialogs'
import { getMissingComfyuiBackendModels } from './imageGenerationUtils'

export type GenerateState =
  | 'no_start'
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
}>

export type ComfyDynamicInputWithCurrent = ComfyInput & { current: string | number | boolean }

export type MediaItemState = 'queued' | 'generating' | 'done' | 'stopped'

type BaseMediaItem = {
  id: string
  state: MediaItemState
  mode: WorkflowModeType
  sourceImageUrl?: string
  settings: GenerationSettings
  dynamicSettings?: ComfyDynamicInputWithCurrent[]
}

export type ImageMediaItem = BaseMediaItem & {
  type: 'image'
  imageUrl: string
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
}

export const backendToService: Record<'comfyui', BackendServiceName> = {
  comfyui: 'comfyui-backend',
}

export { findBestResolution } from './imageGenerationUtils'

export const useImageGenerationPresets = defineStore(
  'imageGenerationPresets',
  () => {
    const presetsStore = usePresets()
    const comfyUi = useComfyUiPresets()
    const backendServices = useBackendServices()
    const uiStore = useUIStore()
    const dialogStore = useDialogStore()
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
    const batchSize = ref<number>(globalDefaultSettings.batchSize)

    const resetActivePresetSettings = () => {
      prompt.value = generalDefaultSettings.prompt
      seed.value = generalDefaultSettings.seed
      safetyCheck.value = generalDefaultSettings.safetyCheck
      const settingsKey = getSettingsKey()
      if (settingsKey) {
        settingsPerPreset.value[settingsKey] = {}
      }
      comfyInputsPerPreset.value[activePreset.value?.name ?? ''] = undefined
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

    const getGenerationParameters = (): GenerationSettings => {
      const allSettings = {
        preset: activePreset.value?.name ?? 'unknown',
        device: 0, // TODO get correct device from backend service
        prompt: prompt.value,
        negativePrompt: negativePrompt.value,
        batchSize: batchSize.value,
        inferenceSteps: inferenceSteps.value,
        seed: seed.value,
        height: height.value,
        width: width.value,
        resolution: resolution.value,
        safetyCheck: safetyCheck.value,
      }
      return Object.fromEntries(
        Object.entries(allSettings).filter(([key]) => {
          if (key === 'preset' || key === 'device') return true
          return settingIsRelevant(key)
        }),
      )
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
    }

    const backend = computed(() => {
      console.log('### computing backend', activePreset.value?.backend)
      if (!activePreset.value) return 'comfyui' as const
      return activePreset.value.backend as 'comfyui'
    })

    const comfyInputs = computed(() => {
      if (!activePreset.value || activePreset.value.backend !== 'comfyui') return []
      const inputRef = (input: ComfyInput): string => `${input.nodeTitle}.${input.nodeInput}`
      const savePerPreset = (input: ComfyInput, newValue: unknown) => {
        if (!activePreset.value?.name) return
        comfyInputsPerPreset.value[activePreset.value.name] = {
          ...comfyInputsPerPreset.value[activePreset.value.name],
          [inputRef(input)]: newValue,
        }
      }
      const getSavedOrDefault = (input: ComfyInput) => {
        if (!activePreset.value?.name) return input.defaultValue
        const saved = comfyInputsPerPreset.value[activePreset.value.name]?.[inputRef(input)]
        return saved ?? input.defaultValue
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

        return { ...input, current }
      })
    })

    type PresetName = string
    type NodeInputReference = string
    const comfyInputsPerPreset = ref<
      Record<PresetName, Record<NodeInputReference, unknown> | undefined>
    >({})
    const settingsPerPreset = ref<Record<PresetName, Record<string, unknown>>>({})

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

      return variantName ? `${activePreset.value.name}:${variantName}` : activePreset.value.name
    }

    // Note: Preset/variant changes are now handled by the orchestrator (usePresetSwitching),
    // which calls loadSettingsForActivePreset() explicitly. No watcher needed.

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
    })

    const generatedImages = ref<MediaItem[]>([])
    const currentState = ref<GenerateState>('no_start')
    const stepText = ref('')

    function loadSettingsForActivePreset() {
      if (!activePreset.value) return

      const settingsKey = getSettingsKey()
      console.log('### loadSettingsForActivePreset', settingsKey, settingsPerPreset.value)
      const getSavedOrDefault = (settingName: string) => {
        if (!settingsKey) return
        const saved = settingsPerPreset.value[settingsKey]?.[settingName]
        const presetValue = getSettingValue(settingName)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const globalDefaultValue: any = globalDefaultSettings[settingName as keyof typeof globalDefaultSettings]
        console.log('### getSavedOrDefault', settingName, saved, presetValue, globalDefaultValue)
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
    }

    function updateImage(newImage: MediaItem) {
      const existingImageIndex = generatedImages.value.findIndex((img) => img.id === newImage.id)
      if (existingImageIndex !== -1) {
        generatedImages.value.splice(existingImageIndex, 1, newImage)
      } else {
        generatedImages.value.push(newImage)
      }
    }

    async function getMissingModels(): Promise<DownloadModelParam[]> {
      if (!activePreset.value) return []
      return getMissingComfyuiBackendModels(activePreset.value.requiredModels ?? [])
    }

    async function ensureModelsAreAvailable(): Promise<void> {
      return new Promise<void>(async (resolve, reject) => {
        const downloadList = await getMissingModels()
        if (downloadList.length > 0) {
          dialogStore.showDownloadDialog(downloadList, resolve, reject)
        } else {
          resolve()
        }
      })
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
      if (!activePreset.value) {
        return {
          backendRunning: false,
          missingCustomNodes: [],
          missingPythonPackages: [],
          missingModels: [],
          allRequirementsMet: false,
        }
      }

      // Check backend status
      const backendServiceName = backendToService[backend.value]
      const backendInfo = backendServices.info.find((s) => s.serviceName === backendServiceName)
      const backendRunning = backendInfo?.status === 'running'

      // Check custom nodes and Python packages (only for ComfyUI presets)
      let missingCustomNodes: string[] = []
      let missingPythonPackages: string[] = []
      if (activePreset.value.type === 'comfy') {
        const requirements = await comfyUi.checkPresetRequirements()
        missingCustomNodes = requirements.missingCustomNodes
        missingPythonPackages = requirements.missingPythonPackages
      }

      // Check models
      const missingModels = await getMissingModels()

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

    async function generate(mode: WorkflowModeType = 'imageGen', sourceImage?: string) {
      console.log('### generate', mode, sourceImage, activePreset.value)
      if (!activePreset.value) {
        toast.error('No preset selected')
        return
      }

      generatedImages.value = generatedImages.value.filter((item) => item.state === 'done')
      const imageIds: string[] = Array.from({ length: batchSize.value }, () => crypto.randomUUID())
      imageIds.forEach((imageId) => {
        updateImage({
          id: imageId,
          mode: mode,
          sourceImageUrl: sourceImage,
          state: 'queued',
          settings: {},
          type: 'image',
          imageUrl: '',
        })
      })
      currentState.value = 'no_start'
      stepText.value = i18nState.COM_GENERATING

      // Auto-open history view for batch generation
      if (batchSize.value > 1) {
        uiStore.openHistory()
      }

      const inferenceBackendService = backendToService[backend.value]
      await backendServices.resetLastUsedInferenceBackend(inferenceBackendService)
      await backendServices.updateLastUsedBackend(inferenceBackendService)
      await comfyUi.generate(imageIds, mode, sourceImage)
    }

    function stopGeneration() {
      comfyUi.stop()
    }

    function deleteImage(id: string) {
      generatedImages.value = generatedImages.value.filter((image) => image.id !== id)

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
      generatedImages.value.length = 0
    }

    function deleteAllImagesForMode(mode: WorkflowModeType) {
      generatedImages.value = generatedImages.value.filter((image) => image.mode !== mode)

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
      safetyCheck,
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
      ensureModelsAreAvailable,
      validatePresetRequirements,
      formatRequirementsForDialog,
      updateImage,
      generate,
      stopGeneration,
      deleteImage,
      deleteAllImages,
      deleteAllImagesForMode,
      getGenerationParameters,
      selectedGeneratedImageId,
      selectedEditedImageId,
      selectedVideoId,
      settingIsRelevant,
      isModifiable,
      loadSettingsForActivePreset,
    }
  },
  {
    persist: {
      debug: true,
      pick: ['settingsPerPreset', 'comfyInputsPerPreset'],
      serializer: {
        // Custom serializer to filter out large data URIs from persistence
        serialize: (state) => {
          if (!state.comfyInputsPerPreset) return JSON.stringify(state)
          const comfyInputsPerPreset = state.comfyInputsPerPreset as Record<string, Record<string, unknown> | undefined>
          
            const filteredInputs: typeof comfyInputsPerPreset = {}
            Object.entries(comfyInputsPerPreset)
            .filter(([_, inputs]) => inputs !== undefined)
            .map(([presetName, inputs]) => [presetName, Object.fromEntries(Object.entries(inputs as Record<string, unknown>).filter(([key]) => ['image', 'inpaintMask', 'video'].includes(key)))]
            )
          return JSON.stringify({
            ...state,
            comfyInputsPerPreset: filteredInputs,
          })
        },
        deserialize: (value) => JSON.parse(value),
      },
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useImageGenerationPresets, import.meta.hot))
}
