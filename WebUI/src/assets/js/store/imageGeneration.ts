import { acceptHMRUpdate, defineStore } from 'pinia'
import z from 'zod'
import { useComfyUi } from './comfyUi'
import { useStableDiffusion } from './stableDiffusion'
import { useI18N } from './i18n'
import * as Const from '../const'
import * as toast from '@/assets/js/toast.ts'
import { useModels } from './models'
import { useBackendServices } from './backendServices'

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

export type GenerationSettings = Partial<
  Settings & {
    workflow: string
  } & {
    device: number
  }
>

export type ComfyDynamicInputWithCurrent =
  | (ComfyImageInput & { current: string })
  | (ComfyVideoInput & { current: string })
  | (ComfyNumberInput & { current: number })
  | (ComfyStringInput & { current: string })
  | (ComfyBooleanInput & { current: boolean })
  | (ComfyStringListInput & { current: string })

export type Image = {
  id: string
  state: 'queued' | 'generating' | 'done' | 'stopped'
  mode: 'imageGen' | 'imageEdit'
  sourceImageUrl?: string
  settings: GenerationSettings
  dynamicSettings?: ComfyDynamicInputWithCurrent[]
  imageUrl: string
}

export type Video = Image & { videoUrl: string }

export type MediaItem = Image | Video

export const isVideo = (item: MediaItem): item is Video => 'videoUrl' in item

const SettingsSchema = z.object({
  imageModel: z.string(),
  inpaintModel: z.string(),
  negativePrompt: z.string(),
  batchSize: z.number(),
  width: z.number(),
  height: z.number(),
  prompt: z.string(),
  resolution: z.string(),
  guidanceScale: z.number(),
  inferenceSteps: z.number(),
  seed: z.number(),
  lora: z.string().nullable(),
  scheduler: z.string().nullable(),
  imagePreview: z.boolean(),
  safetyCheck: z.boolean(),
})
type Settings = z.infer<typeof SettingsSchema>

const SettingSchema = SettingsSchema.keyof()

export type Setting = z.infer<typeof SettingSchema>

const WorkflowRequirementSchema = z.enum(['high-vram'])

const RequiredModelSchema = z.object({
  type: z.string(),
  model: z.string(),
  additionalLicenceLink: z.string().optional(),
})

export type RequiredModel = z.infer<typeof RequiredModelSchema>

const ComfyUIApiWorkflowSchema = z.record(
  z.string(),
  z
    .object({
      inputs: z
        .object({
          text: z.string().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
)
export type ComfyUIApiWorkflow = z.infer<typeof ComfyUIApiWorkflowSchema>

const DefaultWorkflowSchema = z.object({
  name: z.string(),
  displayPriority: z.number().optional(),
  backend: z.literal('default'),
  tags: z.array(z.string()),
  requiredModels: z.array(RequiredModelSchema).optional(),
  requirements: z.array(WorkflowRequirementSchema),
  inputs: z.array(
    z.object({
      name: z.string(),
      type: z.enum(['image', 'mask', 'text']),
    }),
  ),
  outputs: z.array(
    z.object({
      name: z.string(),
      type: z.literal('image'),
    }),
  ),
  defaultSettings: SettingsSchema.partial().optional(),
  displayedSettings: z.array(SettingsSchema.keyof()),
  modifiableSettings: z.array(SettingsSchema.keyof()),
  dependencies: z.array(z.unknown()).optional(),
})
export type DefaultWorkflow = z.infer<typeof DefaultWorkflowSchema>

const ComfyNumberInputSchema = z.object({
  nodeTitle: z.string(),
  nodeInput: z.string(),
  type: z.literal('number'),
  label: z.string(),
  defaultValue: z.number(),
  min: z.number(),
  max: z.number(),
  step: z.number(),
})
export type ComfyNumberInput = z.infer<typeof ComfyNumberInputSchema>

const ComfyImageInputSchema = z.object({
  nodeTitle: z.string(),
  nodeInput: z.string(),
  type: z.literal('image'),
  defaultValue: z.string(),
  label: z.string(),
})
export type ComfyImageInput = z.infer<typeof ComfyImageInputSchema>

const ComfyVideoInputSchema = z.object({
  nodeTitle: z.string(),
  nodeInput: z.string(),
  type: z.literal('video'),
  defaultValue: z.string(),
  label: z.string(),
})
export type ComfyVideoInput = z.infer<typeof ComfyVideoInputSchema>

const ComfyStringInputSchema = z.object({
  nodeTitle: z.string(),
  nodeInput: z.string(),
  type: z.literal('string'),
  defaultValue: z.string(),
  label: z.string(),
})
export type ComfyStringInput = z.infer<typeof ComfyStringInputSchema>

const ComfyStringListInputSchema = z.object({
  nodeTitle: z.string(),
  nodeInput: z.string(),
  type: z.literal('stringList'),
  options: z.array(z.string()),
  defaultValue: z.string(),
  label: z.string(),
})

export type ComfyStringListInput = z.infer<typeof ComfyStringListInputSchema>

const ComfyBooleanInputSchema = z.object({
  nodeTitle: z.string(),
  nodeInput: z.string(),
  type: z.literal('boolean'),
  defaultValue: z.boolean(),
  label: z.string(),
})
export type ComfyBooleanInput = z.infer<typeof ComfyBooleanInputSchema>

const ComfyDynamicInputSchema = z.discriminatedUnion('type', [
  ComfyNumberInputSchema,
  ComfyImageInputSchema,
  ComfyVideoInputSchema,
  ComfyStringInputSchema,
  ComfyStringListInputSchema,
  ComfyBooleanInputSchema,
])
export type ComfyDynamicInput = z.infer<typeof ComfyDynamicInputSchema>

const ComfyUiWorkflowSchema = z.object({
  name: z.string(),
  category: z.enum(['create-images', 'edit-images', 'create-videos']).optional(),
  displayPriority: z.number().default(0),
  backend: z.literal('comfyui'),
  comfyUIRequirements: z.object({
    pythonPackages: z.array(z.string()).optional(),
    customNodes: z.array(z.string()),
    requiredModels: z.array(RequiredModelSchema),
  }),
  tags: z.array(z.string()),
  requiredModels: z.array(z.string()).optional(),
  requirements: z.array(WorkflowRequirementSchema),
  inputs: z.array(ComfyDynamicInputSchema),
  outputs: z.array(
    z.object({
      name: z.string(),
      type: z.literal('image'),
    }),
  ),
  defaultSettings: SettingsSchema.partial().optional(),
  displayedSettings: z.array(SettingsSchema.keyof()),
  modifiableSettings: z.array(SettingsSchema.keyof()),
  dependencies: z.array(z.unknown()).optional(),
  comfyUiApiWorkflow: ComfyUIApiWorkflowSchema,
})
export type ComfyUiWorkflow = z.infer<typeof ComfyUiWorkflowSchema>
const WorkflowSchema = z.discriminatedUnion('backend', [
  DefaultWorkflowSchema,
  ComfyUiWorkflowSchema,
])
export type Workflow = z.infer<typeof WorkflowSchema>

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

export const useImageGeneration = defineStore(
  'imageGeneration',
  () => {
    const predefinedWorkflows: Workflow[] = [
      {
        name: 'Standard',
        backend: 'default',
        tags: ['sd1.5'],
        requirements: [],
        inputs: [],
        outputs: [{ name: 'output_image', type: 'image' }],
        defaultSettings: {
          imageModel: 'Lykon/dreamshaper-8',
          inpaintModel: 'Lykon/dreamshaper-8-inpainting',
          resolution: '512x512',
          guidanceScale: 7,
          inferenceSteps: 20,
          batchSize: 4,
          scheduler: 'DPM++ SDE Karras',
        },
        displayedSettings: [
          'imageModel',
          'inpaintModel',
          'guidanceScale',
          'inferenceSteps',
          'scheduler',
        ],
        modifiableSettings: [
          'resolution',
          'seed',
          'inferenceSteps',
          'negativePrompt',
          'batchSize',
          'imagePreview',
          'safetyCheck',
        ],
      },
      {
        name: 'Standard - High Quality',
        backend: 'default',
        tags: ['sd1.5', 'hq'],
        requirements: [],
        inputs: [],
        outputs: [{ name: 'output_image', type: 'image' }],
        defaultSettings: {
          imageModel: 'Lykon/dreamshaper-8',
          inpaintModel: 'Lykon/dreamshaper-8-inpainting',
          resolution: '512x512',
          guidanceScale: 7,
          inferenceSteps: 50,
          batchSize: 1,
          scheduler: 'DPM++ SDE Karras',
        },
        displayedSettings: ['imageModel', 'inpaintModel', 'guidanceScale', 'scheduler'],
        modifiableSettings: [
          'resolution',
          'seed',
          'inferenceSteps',
          'negativePrompt',
          'batchSize',
          'imagePreview',
          'safetyCheck',
        ],
      },
      {
        name: 'Standard - Fast',
        backend: 'default',
        tags: ['sd1.5', 'fast'],
        requirements: [],
        inputs: [],
        outputs: [{ name: 'output_image', type: 'image' }],
        defaultSettings: {
          imageModel: 'Lykon/dreamshaper-8',
          inpaintModel: 'Lykon/dreamshaper-8-inpainting',
          resolution: '704x384',
          guidanceScale: 1,
          inferenceSteps: 6,
          batchSize: 4,
          scheduler: 'LCM',
          lora: 'latent-consistency/lcm-lora-sdv1-5',
        },
        displayedSettings: ['imageModel', 'inpaintModel', 'guidanceScale', 'scheduler', 'lora'],
        modifiableSettings: [
          'resolution',
          'seed',
          'inferenceSteps',
          'batchSize',
          'imagePreview',
          'safetyCheck',
        ],
      },
      {
        name: 'HD',
        backend: 'default',
        tags: ['sdxl', 'high-vram'],
        requirements: [],
        inputs: [],
        outputs: [{ name: 'output_image', type: 'image' }],
        defaultSettings: {
          imageModel: 'RunDiffusion/Juggernaut-XL-v9',
          inpaintModel: useI18N().state.ENHANCE_INPAINT_USE_IMAGE_MODEL,
          resolution: '1024x1024',
          guidanceScale: 7,
          inferenceSteps: 20,
          batchSize: 1,
          scheduler: 'DPM++ SDE',
          lora: 'None',
        },
        displayedSettings: ['imageModel', 'inpaintModel', 'guidanceScale', 'scheduler'],
        modifiableSettings: [
          'resolution',
          'seed',
          'inferenceSteps',
          'negativePrompt',
          'batchSize',
          'imagePreview',
        ],
      },
      {
        name: 'HD - High Quality',
        backend: 'default',
        tags: ['sdxl', 'high-vram', 'hq'],
        requirements: [],
        inputs: [],
        outputs: [{ name: 'output_image', type: 'image' }],
        defaultSettings: {
          imageModel: 'RunDiffusion/Juggernaut-XL-v9',
          inpaintModel: useI18N().state.ENHANCE_INPAINT_USE_IMAGE_MODEL,
          resolution: '1024x1024',
          guidanceScale: 7,
          inferenceSteps: 50,
          batchSize: 1,
          scheduler: 'DPM++ SDE',
          lora: 'None',
        },
        displayedSettings: ['imageModel', 'inpaintModel', 'guidanceScale', 'scheduler'],
        modifiableSettings: [
          'resolution',
          'seed',
          'inferenceSteps',
          'negativePrompt',
          'batchSize',
          'imagePreview',
        ],
      },
      {
        name: 'HD - Fast',
        backend: 'default',
        tags: ['sdxl', 'high-vram', 'fast'],
        requirements: [],
        inputs: [],
        outputs: [{ name: 'output_image', type: 'image' }],
        defaultSettings: {
          imageModel: 'RunDiffusion/Juggernaut-XL-v9',
          inpaintModel: useI18N().state.ENHANCE_INPAINT_USE_IMAGE_MODEL,
          resolution: '1024x1024',
          guidanceScale: 1,
          inferenceSteps: 6,
          batchSize: 1,
          scheduler: 'LCM',
          lora: 'latent-consistency/lcm-lora-sdxl',
        },
        displayedSettings: ['imageModel', 'inpaintModel', 'guidanceScale', 'scheduler'],
        modifiableSettings: ['resolution', 'seed', 'inferenceSteps', 'batchSize', 'imagePreview'],
      },
      {
        name: 'Manual',
        backend: 'default',
        tags: ['sd1.5', 'sdxl'],
        requirements: [],
        inputs: [],
        outputs: [{ name: 'output_image', type: 'image' }],
        displayedSettings: [],
        modifiableSettings: [
          'seed',
          'negativePrompt',
          'batchSize',
          'imagePreview',
          'safetyCheck',
          'width',
          'height',
          'imageModel',
          'inpaintModel',
          'inferenceSteps',
          'guidanceScale',
          'scheduler',
          'lora',
        ],
      },
    ]

    const comfyUi = useComfyUi()
    const stableDiffusion = useStableDiffusion()
    const backendServices = useBackendServices()
    const models = useModels()
    const i18nState = useI18N().state

    const hdWarningDismissed = ref(false)

    const workflows = ref<Workflow[]>(predefinedWorkflows)
    const activeWorkflowName = ref<string | null>('Standard - Fast')
    const lastUsedImageGenWorkflowName = ref<string>('Flux.1-Schnell Med Quality')
    const lastUsedImageEditWorkflowName = ref<string>('Edit By Prompt')

    const activeWorkflow = computed(() => {
      console.log('### activeWorkflowName', activeWorkflowName.value)
      return (
        workflows.value.find((w) => w.name === activeWorkflowName.value) ?? predefinedWorkflows[0]
      )
    })
    const processing = ref(false)
    const stopping = ref(false)

    const selectedGeneratedImageId = ref<string | null>(null)
    const selectedEditedImageId = ref<string | null>(null)

    // general settings
    const prompt = ref<string>(generalDefaultSettings.prompt)
    const seed = ref<number>(generalDefaultSettings.seed)
    const imagePreview = ref<boolean>(generalDefaultSettings.imagePreview)
    const safetyCheck = ref<boolean>(generalDefaultSettings.safetyCheck)
    const batchSize = ref<number>(globalDefaultSettings.batchSize) // TODO this should be imageCount instead, as we only support batchSize 1 due to memory constraints

    const resetActiveWorkflowSettings = () => {
      prompt.value = generalDefaultSettings.prompt
      seed.value = generalDefaultSettings.seed
      imagePreview.value = generalDefaultSettings.imagePreview
      safetyCheck.value = generalDefaultSettings.safetyCheck
      settingsPerWorkflow.value[activeWorkflowName.value ?? ''] = undefined
      comfyInputsPerWorkflow.value[activeWorkflowName.value ?? ''] = undefined
      loadSettingsForActiveWorkflow()
    }
    // model specific settings
    const negativePrompt = ref<string>(globalDefaultSettings.negativePrompt)
    const width = ref<number>(globalDefaultSettings.width)
    const height = ref<number>(globalDefaultSettings.height)
    const scheduler = ref<string>(globalDefaultSettings.scheduler)
    const imageModel = ref(globalDefaultSettings.imageModel)
    const inpaintModel = ref(
      activeWorkflow.value.defaultSettings?.inpaintModel ?? globalDefaultSettings.inpaintModel,
    )
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

    // TODO: Model Settings better (probably all settings should be an array of Settings, similar to comfyInputs) to better align ComfyUI and Default backends
    const settingIsRelevant = (setting: Setting) =>
      activeWorkflow.value.backend === 'default' ||
      activeWorkflow.value.displayedSettings.includes(setting) ||
      activeWorkflow.value.modifiableSettings.includes(setting)

    const getGenerationParameters = (): GenerationSettings => {
      const allSettings = {
        workflow: activeWorkflowName.value ?? 'unknown',
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
        Object.entries(allSettings).filter(([key]) => settingIsRelevant(key as Setting)),
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
    type ModifiableSettings = keyof typeof settings

    const backend = computed({
      get() {
        return activeWorkflow.value.backend
      },
      set(newValue) {
        const sortedWorkflowsForBackend = workflows.value
          .filter((w) => w.backend === newValue)
          .sort((a, b) => (b.displayPriority ?? 0) - (a.displayPriority ?? 0))
        activeWorkflowName.value =
          sortedWorkflowsForBackend.find((w) => w.name === lastWorkflowPerBackend.value[newValue])
            ?.name ??
          sortedWorkflowsForBackend[0]?.name ??
          activeWorkflowName.value
      },
    })
    const lastWorkflowPerBackend = ref<Record<Workflow['backend'], string | null>>({
      comfyui: null,
      default: null,
    })

    const comfyInputs = computed(() => {
      if (activeWorkflow.value.backend !== 'comfyui') return []
      const inputRef = (input: ComfyDynamicInput): NodeInputReference =>
        `${input.nodeTitle}.${input.nodeInput}`
      const savePerWorkflow = (
        input: ComfyDynamicInput,
        newValue: ComfyDynamicInput['defaultValue'],
      ) => {
        if (!activeWorkflowName.value) return
        comfyInputsPerWorkflow.value[activeWorkflowName.value] = {
          ...comfyInputsPerWorkflow.value[activeWorkflowName.value],
          [inputRef(input)]: newValue,
        }
        console.log('saving', { nodeTitle: input.nodeTitle, nodeInput: input.nodeInput, newValue })
      }
      const getSavedOrDefault = (input: ComfyDynamicInput) => {
        if (!activeWorkflowName.value) return input.defaultValue
        const saved = comfyInputsPerWorkflow.value[activeWorkflowName.value]?.[inputRef(input)]
        if (saved)
          console.log('got saved dynamic input', {
            nodeTitle: input.nodeTitle,
            nodeInput: input.nodeInput,
            saved,
          })
        return saved ?? input.defaultValue
      }

      return activeWorkflow.value.inputs.map((input) => {
        const _current = ref(getSavedOrDefault(input))

        const current = computed({
          get() {
            return _current.value
          },
          set(newValue) {
            _current.value = newValue
            savePerWorkflow(input, newValue)
          },
        })

        return { ...input, current }
      })
    })

    type WorkflowName = string
    type NodeInputReference = string // nodeTitle.nodeInput
    const comfyInputsPerWorkflow = ref<
      Record<
        WorkflowName,
        Record<NodeInputReference, ComfyDynamicInput['defaultValue']> | undefined
      >
    >({})
    const settingsPerWorkflow = ref<Record<WorkflowName, Workflow['defaultSettings']>>({})

    const isModifiable = (settingName: ModifiableSettings) =>
      activeWorkflow.value.modifiableSettings.includes(settingName)

    watch(
      [activeWorkflowName, workflows],
      () => {
        setTimeout(
          () =>
            (lastWorkflowPerBackend.value[activeWorkflow.value.backend] = activeWorkflowName.value),
        )
        loadSettingsForActiveWorkflow()
        if (activeWorkflow.value.backend === 'comfyui' && activeWorkflowName.value) {
          if (activeWorkflow.value.category === 'create-images') {
            lastUsedImageGenWorkflowName.value = activeWorkflowName.value
          } else if (activeWorkflow.value.category === 'edit-images') {
            lastUsedImageEditWorkflowName.value = activeWorkflowName.value
          }
        }
      },
      {},
    )

    watch(resolution, () => {
      const [width, height] = resolution.value.split('x').map(Number)
      settings.width.value = width
      settings.height.value = height
    })

    watch([inferenceSteps, width, height], () => {
      console.log('saving to settingsPerWorkflow')
      const saveToSettingsPerWorkflow = (settingName: ModifiableSettings) => {
        if (!activeWorkflowName.value) return
        if (isModifiable(settingName)) {
          settingsPerWorkflow.value[activeWorkflowName.value] = {
            ...settingsPerWorkflow.value[activeWorkflowName.value],
            [settingName]: settings[settingName].value,
          }
          console.log('saving', { settingName, value: settings[settingName].value })
        }
      }
      saveToSettingsPerWorkflow('seed')
      saveToSettingsPerWorkflow('inferenceSteps')
      saveToSettingsPerWorkflow('width')
      saveToSettingsPerWorkflow('height')
      saveToSettingsPerWorkflow('resolution')
      saveToSettingsPerWorkflow('batchSize')
      saveToSettingsPerWorkflow('negativePrompt')
      saveToSettingsPerWorkflow('lora')
      saveToSettingsPerWorkflow('scheduler')
      saveToSettingsPerWorkflow('guidanceScale')
      saveToSettingsPerWorkflow('imageModel')
      saveToSettingsPerWorkflow('inpaintModel')
    })

    const generatedImages = ref<MediaItem[]>([])
    const currentState = ref<GenerateState>('no_start')
    const stepText = ref('')

    function loadSettingsForActiveWorkflow() {
      console.log('loading settings for', activeWorkflowName.value)
      const getSavedOrDefault = (settingName: ModifiableSettings) => {
        if (!activeWorkflowName.value) return
        let saved = undefined
        if (isModifiable(settingName)) {
          saved = settingsPerWorkflow.value[activeWorkflowName.value]?.[settingName]
          console.log('got saved', { settingName, saved })
        }
        settings[settingName].value =
          saved ??
          activeWorkflow.value?.defaultSettings?.[settingName] ??
          globalDefaultSettings[settingName]
      }

      getSavedOrDefault('seed')
      getSavedOrDefault('inferenceSteps')
      getSavedOrDefault('width')
      getSavedOrDefault('height')
      getSavedOrDefault('resolution')
      getSavedOrDefault('batchSize')
      getSavedOrDefault('negativePrompt')
      getSavedOrDefault('lora')
      getSavedOrDefault('scheduler')
      getSavedOrDefault('guidanceScale')
      getSavedOrDefault('imageModel')
      getSavedOrDefault('inpaintModel')
    }

    function updateImage(newImage: MediaItem) {
      console.log('updating image', newImage)
      const existingImageIndex = generatedImages.value.findIndex((img) => img.id === newImage.id)
      if (existingImageIndex !== -1) {
        generatedImages.value.splice(existingImageIndex, 1, newImage)
      } else {
        generatedImages.value.push(newImage)
      }
    }

    async function loadWorkflowsFromIntel() {
      const syncResponse = await window.electronAPI.updateWorkflowsFromIntelRepo()
      await loadWorkflowsFromJson()
      return syncResponse
    }

    async function loadWorkflowsFromJson() {
      const workflowsFromFiles = await window.electronAPI.reloadImageWorkflows()
      const parsedWorkflows = workflowsFromFiles
        .map((workflow) => {
          try {
            return WorkflowSchema.parse(JSON.parse(workflow))
          } catch (error) {
            console.error('Failed to parse workflow', { error, workflow })
            return undefined
          }
        })
        .filter((wf) => wf !== undefined)
      workflows.value = [...predefinedWorkflows, ...parsedWorkflows]
    }

    async function getMissingModels(): Promise<DownloadModelParam[]> {
      if (activeWorkflow.value.backend === 'default') {
        return getMissingDefaultBackendModels()
      } else {
        return getMissingComfyuiBackendModels(activeWorkflow.value)
      }
    }

    async function getMissingComfyuiBackendModels(
      workflow: ComfyUiWorkflow,
    ): Promise<DownloadModelParam[]> {
      function extractDownloadModelParamsFromString(
        requiredModel: RequiredModel,
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
        workflow.comfyUIRequirements.requiredModels.map(extractDownloadModelParamsFromString)
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

    async function generate(mode: 'imageGen' | 'imageEdit' = 'imageGen', sourceImage?: string) {
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
      if (activeWorkflow.value.backend === 'default') {
        await stableDiffusion.generate(imageIds, mode, sourceImage)
      } else {
        await comfyUi.generate(imageIds, mode, sourceImage)
      }
    }

    function stopGeneration() {
      stableDiffusion.stop()
      comfyUi.stop()
    }

    function deleteImage(id: string) {
      generatedImages.value = generatedImages.value.filter((image) => image.id !== id)
    }

    function deleteAllImages() {
      generatedImages.value.length = 0
    }

    loadWorkflowsFromJson()

    watch(
      () => backendServices.info.find((item) => item.serviceName === 'comfyui-backend')?.isSetUp,
      (isSetUp) => {
        console.log('comfyui backend set up trigger')
        if (isSetUp) loadWorkflowsFromJson()
      },
    )

    return {
      hdWarningDismissed,
      backend,
      workflows,
      activeWorkflowName,
      activeWorkflow,
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
      settingsPerWorkflow,
      comfyInputsPerWorkflow,
      comfyInputs,
      lastWorkflowPerBackend,
      resetActiveWorkflowSettings,
      loadWorkflowsFromJson,
      loadWorkflowsFromIntel,
      getMissingModels,
      updateImage,
      generate,
      stopGeneration,
      deleteImage,
      deleteAllImages,
      getGenerationParameters,
      selectedGeneratedImageId,
      selectedEditedImageId,
      lastUsedImageGenWorkflowName,
      lastUsedImageEditWorkflowName
    }
  },
  {
    persist: {
      debug: true,
      pick: [
        'backend',
        'activeWorkflowName',
        'settingsPerWorkflow',
        'comfyInputsPerWorkflow',
        'hdWarningDismissed',
        'lastWorkflowPerBackend',
        'lastUsedImageGenWorkflowName',
        'lastUsedImageEditWorkflowName',
      ],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useImageGeneration, import.meta.hot))
}
