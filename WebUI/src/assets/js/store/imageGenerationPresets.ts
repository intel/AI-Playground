import { acceptHMRUpdate, defineStore, storeToRefs } from 'pinia'
import { useComfyUiPresets } from './comfyUiPresets'
import { useStableDiffusion } from './stableDiffusion'
import { useI18N } from './i18n'
import * as Const from '../const'
import * as toast from '@/assets/js/toast.ts'
import { useModels } from './models'
import { useBackendServices } from './backendServices'
import { usePresets, type ComfyUiPreset, type ComfyInput, type Setting } from './presets'
import type { ComfyUIApiWorkflow } from './presets'

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
  imageModel: string
  inpaintModel: string
  guidanceScale: number
  lora: string | null
  scheduler: string | null
  imagePreview: boolean
  safetyCheck: boolean
}>

export type ComfyDynamicInputWithCurrent =
  | (ComfyInput & { current: string | number | boolean })

export type Image = {
  id: string
  state: 'queued' | 'generating' | 'done' | 'stopped'
  mode: WorkflowModeType
  sourceImageUrl?: string
  settings: GenerationSettings
  dynamicSettings?: ComfyDynamicInputWithCurrent[]
  imageUrl: string
}

export type Video = Image & { videoUrl: string }

export type Model3D = Image & { model3dUrl: string }

export type MediaItem = Image | Video | Model3D

export const isVideo = (item: MediaItem): item is Video => 'videoUrl' in item

export const is3D = (item: MediaItem): item is Model3D => 'model3dUrl' in item

const globalDefaultSettings = {
  seed: -1,
  width: 512,
  height: 512,
  inferenceSteps: 6,
  resolution: '704x384',
  batchSize: 4,
  negativePrompt: 'nsfw',
  imageModel: 'Lykon/dreamshaper-8',
  inpaintModel: 'Lykon/dreamshaper-8-inpainting',
  guidanceScale: 7,
  lora: 'None',
  scheduler: 'DPM++ SDE Karras',
}

const generalDefaultSettings = {
  prompt: '',
  seed: -1,
  imagePreview: true,
  safetyCheck: true,
}

export const backendToService: Record<'comfyui' | 'default', BackendServiceName> = {
  comfyui: 'comfyui-backend',
  default: 'ai-backend',
}

export function findBestResolution(totalPixels: number, aspectRatio: number) {
  const MIN_SIZE = 256
  const MAX_SIZE = 1536
  let bestWidth = 0
  let bestHeight = 0
  let minDiff = Infinity

  for (let h = MIN_SIZE; h <= MAX_SIZE; h += 64) {
    let w = aspectRatio * h
    w = Math.round(w / 64) * 64

    if (w < MIN_SIZE || w > MAX_SIZE) continue

    const actualPixels = w * h
    const diff = Math.abs(actualPixels - totalPixels)

    if (diff < minDiff) {
      minDiff = diff
      bestWidth = w
      bestHeight = h
    }
  }

  return { width: bestWidth, height: bestHeight, totalPixels: bestWidth * bestHeight }
}

export const useImageGenerationPresets = defineStore(
  'imageGenerationPresets',
  () => {
    const presetsStore = usePresets()
    const comfyUi = useComfyUiPresets()
    const stableDiffusion = useStableDiffusion()
    const backendServices = useBackendServices()
    const models = useModels()
    const i18nState = useI18N().state

    const hdWarningDismissed = ref(false)

    const activePreset = computed(() => {
      console.log('### activePreset', presetsStore.activePresetWithVariant)
      if (presetsStore.activePresetWithVariant?.type === 'comfy') return presetsStore.activePresetWithVariant
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
    const imagePreview = ref<boolean>(generalDefaultSettings.imagePreview)
    const safetyCheck = ref<boolean>(generalDefaultSettings.safetyCheck)
    const batchSize = ref<number>(globalDefaultSettings.batchSize)

    const resetActivePresetSettings = () => {
      prompt.value = generalDefaultSettings.prompt
      seed.value = generalDefaultSettings.seed
      imagePreview.value = generalDefaultSettings.imagePreview
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
    const scheduler = ref<string>(globalDefaultSettings.scheduler)
    const imageModel = ref(globalDefaultSettings.imageModel)
    const inpaintModel = ref(globalDefaultSettings.inpaintModel)
    const lora = ref<string>(globalDefaultSettings.lora)
    const guidanceScale = ref<number>(globalDefaultSettings.guidanceScale)
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
    const getSettingValue = (settingName: string): any => {
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
        imageModel: imageModel.value,
        batchSize: batchSize.value,
        inferenceSteps: inferenceSteps.value,
        guidanceScale: guidanceScale.value,
        seed: seed.value,
        height: height.value,
        width: width.value,
        resolution: resolution.value,
        lora: lora.value,
        scheduler: scheduler.value,
        imagePreview: imagePreview.value,
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
      lora,
      scheduler,
      guidanceScale,
      imageModel,
      inpaintModel,
    }

    const backend = computed(() => {
      console.log('### computing backend', activePreset.value?.backend)
      if (!activePreset.value) return 'default' as const
      return activePreset.value.backend as 'comfyui' | 'default'
    })

    const comfyInputs = computed(() => {
      if (!activePreset.value || activePreset.value.backend !== 'comfyui') return []
      const inputRef = (input: ComfyInput): string => `${input.nodeTitle}.${input.nodeInput}`
      const savePerPreset = (input: ComfyInput, newValue: any) => {
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
      Record<PresetName, Record<NodeInputReference, any> | undefined>
    >({})
    const settingsPerPreset = ref<Record<PresetName, Record<string, any>>>({})

    // Watch resolution changes and sync to target width/height ComfyInputs (for inpainting with target resolution)
    watch(resolution, (newResolution) => {
      const [newWidth, newHeight] = newResolution.split('x').map(Number)
      
      // Find target width and height ComfyInputs
      const targetWidthInput = comfyInputs.value.find(
        (input) => input.nodeTitle === 'width' && input.nodeInput === 'value'
      )
      const targetHeightInput = comfyInputs.value.find(
        (input) => input.nodeTitle === 'height' && input.nodeInput === 'value'
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
      const variantName = presetsStore.activeVariantName[activePreset.value.name]
      return variantName ? `${activePreset.value.name}:${variantName}` : activePreset.value.name
    }

    // Watch for variant changes by watching the variant name for the current preset
    const currentVariantName = computed(() => {
      console.log('### computing currentVariantName', activePreset.value?.name)
      if (!activePreset.value?.name) return null
      return presetsStore.activeVariantName[activePreset.value.name] || null
    })

    // Track the last preset name to avoid unnecessary reloads
    let lastPresetName: string | null = null
    let lastVariantName: string | null = null

    watch(
      [activePreset, currentVariantName],
      () => {
        console.log('### watch activePreset and currentVariantName', { activePreset: activePreset.value, currentVariantName: currentVariantName.value })
        const currentPresetName = activePreset.value?.name ?? null
        const currentVariant = currentVariantName.value
        
        // Only reload if the preset or variant actually changed
        if (currentPresetName === lastPresetName && currentVariant === lastVariantName) {
          return
        }
        
        lastPresetName = currentPresetName
        lastVariantName = currentVariant ?? null
        
        loadSettingsForActivePreset()
        if (activePreset.value && activePreset.value.type === 'comfy' && activePreset.value.name && activePreset.value.category) {
          presetsStore.setLastUsedPreset(activePreset.value.category, activePreset.value.name)
        }
      },
    )

    watch(resolution, () => {
      const [w, h] = resolution.value.split('x').map(Number)
      settings.width.value = w
      settings.height.value = h
    })

    watch([inferenceSteps, width, height, batchSize], () => {
      console.log('### watch inferenceSteps, width, height, batchSize', { inferenceSteps: inferenceSteps.value, width: width.value, height: height.value, batchSize: batchSize.value })
      const saveToSettingsPerPreset = (settingName: string) => {
        const settingsKey = getSettingsKey()
        if (!settingsKey) return
        if (isModifiable(settingName)) {
          settingsPerPreset.value[settingsKey] = {
            ...settingsPerPreset.value[settingsKey],
            [settingName]: (settings as any)[settingName]?.value,
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
      saveToSettingsPerPreset('lora')
      saveToSettingsPerPreset('scheduler')
      saveToSettingsPerPreset('guidanceScale')
      saveToSettingsPerPreset('imageModel')
      saveToSettingsPerPreset('inpaintModel')
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
        const globalValue = (globalDefaultSettings as any)[settingName]
        console.log('### getSavedOrDefault', settingName, saved, presetValue, globalValue)
        return saved ?? presetValue ?? globalValue
      }

      // Load standard settings from preset
      seed.value = getSavedOrDefault('seed') ?? generalDefaultSettings.seed
      inferenceSteps.value = getSavedOrDefault('inferenceSteps') ?? globalDefaultSettings.inferenceSteps
      width.value = getSavedOrDefault('width') ?? globalDefaultSettings.width
      height.value = getSavedOrDefault('height') ?? globalDefaultSettings.height
      resolution.value = getSavedOrDefault('resolution') ?? globalDefaultSettings.resolution
      batchSize.value = getSavedOrDefault('batchSize') ?? globalDefaultSettings.batchSize
      negativePrompt.value = getSavedOrDefault('negativePrompt') ?? globalDefaultSettings.negativePrompt
      lora.value = getSavedOrDefault('lora') ?? globalDefaultSettings.lora
      scheduler.value = getSavedOrDefault('scheduler') ?? globalDefaultSettings.scheduler
      guidanceScale.value = getSavedOrDefault('guidanceScale') ?? globalDefaultSettings.guidanceScale
      imageModel.value = getSavedOrDefault('imageModel') ?? globalDefaultSettings.imageModel
      inpaintModel.value = getSavedOrDefault('inpaintModel') ?? globalDefaultSettings.inpaintModel
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
      if (activePreset.value.backend === 'comfyui') {
        return getMissingComfyuiBackendModels(activePreset.value)
      } else {
        return getMissingDefaultBackendModels()
      }
    }

    async function getMissingComfyuiBackendModels(
      preset: ComfyUiPreset,
    ): Promise<DownloadModelParam[]> {
      function extractDownloadModelParamsFromString(
        requiredModel: { type: string; model: string; additionalLicenceLink?: string },
      ): CheckModelAlreadyLoadedParameters {
        function modelTypeToId(type: string) {
          switch (type) {
            case 'checkpoints':
              return Const.MODEL_TYPE_COMFY_CHECKPOINTS
            case 'unet':
              return Const.MODEL_TYPE_COMFY_UNET
            case 'clip':
              return Const.MODEL_TYPE_COMFY_CLIP
            case 'vae':
              return Const.MODEL_TYPE_COMFY_VAE
            case 'faceswap':
              return Const.MODEL_TYPE_FACESWAP
            case 'facerestore':
              return Const.MODEL_TYPE_FACERESTORE
            case 'nsfwdetector':
              return Const.MODEL_TYPE_NSFW_DETECTOR
            case 'defaultCheckpoint':
              return Const.MODEL_TYPE_COMFY_DEFAULT_CHECKPOINT
            case 'defaultLora':
              return Const.MODEL_TYPE_COMFY_DEFAULT_LORA
            case 'controlNet':
              return Const.MODEL_TYPE_COMFY_CONTROL_NET
            case 'upscale':
              return Const.MODEL_TYPE_UPSCALE
            default:
              console.warn('received unknown comfyUI type: ', type)
              return -1
          }
        }

        return {
          type: modelTypeToId(requiredModel.type),
          repo_id: requiredModel.model,
          backend: 'comfyui',
          additionalLicenseLink: requiredModel.additionalLicenceLink,
        }
      }

      const checkList: CheckModelAlreadyLoadedParameters[] =
        (preset.requiredModels ?? []).map(extractDownloadModelParamsFromString)
      const checkedModels: CheckModelAlreadyLoadedResult[] =
        await models.checkModelAlreadyLoaded(checkList)
      const modelsToBeLoaded = checkedModels.filter(
        (checkModelExistsResult) => !checkModelExistsResult.already_loaded,
      )
      for (const item of modelsToBeLoaded) {
        if (!(await models.checkIfHuggingFaceUrlExists(item.repo_id))) {
          toast.error(`declared model ${item.repo_id} does not exist. Aborting Generation.`)
          return []
        }
      }
      return modelsToBeLoaded
    }

    async function getMissingDefaultBackendModels(): Promise<DownloadModelParam[]> {
      const checkList: CheckModelAlreadyLoadedParameters[] = [
        { repo_id: imageModel.value, type: Const.MODEL_TYPE_STABLE_DIFFUSION, backend: 'default' },
      ]
      if (lora.value !== 'None') {
        checkList.push({ repo_id: lora.value, type: Const.MODEL_TYPE_LORA, backend: 'default' })
      }
      if (imagePreview.value) {
        checkList.push({
          repo_id: 'madebyollin/taesd',
          type: Const.MODEL_TYPE_PREVIEW,
          backend: 'default',
        })
        checkList.push({
          repo_id: 'madebyollin/taesdxl',
          type: Const.MODEL_TYPE_PREVIEW,
          backend: 'default',
        })
      }

      const result = await models.checkModelAlreadyLoaded(checkList)
      return result.filter((checkModelExistsResult) => !checkModelExistsResult.already_loaded)
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
          imageUrl: '',
        })
      })
      currentState.value = 'no_start'
      stepText.value = i18nState.COM_GENERATING
      const inferenceBackendService = backendToService[backend.value]
      await backendServices.resetLastUsedInferenceBackend(inferenceBackendService)
      backendServices.updateLastUsedBackend(inferenceBackendService)
      if (activePreset.value.backend === 'comfyui') {
        await comfyUi.generate(imageIds, mode, sourceImage)
      } else {
        await stableDiffusion.generate(imageIds, mode, sourceImage)
      }
    }

    function stopGeneration() {
      stableDiffusion.stop()
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
        console.log('### watch presets', { presets: presetsStore.presets, activePreset: activePreset.value, currentVariantName: currentVariantName.value, activeVariantName: presetsStore.activeVariantName })
        if (presets.length > 0 && !activePreset.value) {
          const firstComfyPreset = presets.find((p) => p.type === 'comfy')
          if (firstComfyPreset) {
            presetsStore.setActiveVariant(firstComfyPreset.name, null)
          }
        }
      },
      { immediate: true },
    )

    return {
      hdWarningDismissed,
      backend,
      activePreset,
      processing,
      prompt,
      generatedImages,
      currentState,
      stepText,
      stopping,
      imageModel,
      inpaintModel,
      lora,
      scheduler,
      guidanceScale,
      imagePreview,
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
    }
  },
  {
    persist: {
      debug: true,
      pick: [
        'settingsPerPreset',
        'comfyInputsPerPreset',
        'hdWarningDismissed',
      ],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useImageGenerationPresets, import.meta.hot))
}

