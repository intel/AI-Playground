import { acceptHMRUpdate, defineStore } from 'pinia'
import z from 'zod'
import { useComfyUi } from './comfyUi'
import { useStableDiffusion } from './stableDiffusion'
import { useI18N } from './i18n'
import * as Const from '../const'
import { useGlobalSetup } from './globalSetup'
import * as toast from '@/assets/js/toast.ts'

export type StableDiffusionSettings = {
  resolution: 'standard' | 'hd' | 'manual' // ~ modelSettings.resolution 0, 1, 3
  quality: 'standard' | 'high' | 'fast' // ~ modelSettings.quality 0, 1, 2
  imageModel: string
  inpaintModel: string
  negativePrompt: string
  batchSize: number // ~ modelSettings.generateNumber
  pickerResolution?: string
  width: number
  height: number
  guidanceScale: number
  inferenceSteps: number
  seed: number
  lora: string | null
  scheduler: string | null
  imagePreview: boolean
  safetyCheck: boolean
}

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

const ComfyStringInputSchema = z.object({
  nodeTitle: z.string(),
  nodeInput: z.string(),
  type: z.literal('string'),
  defaultValue: z.string(),
  label: z.string(),
})
export type ComfyStringInput = z.infer<typeof ComfyStringInputSchema>

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
  ComfyStringInputSchema,
  ComfyBooleanInputSchema,
])
type ComfyDynamicInput = z.infer<typeof ComfyDynamicInputSchema>
const ComfyUiWorkflowSchema = z.object({
  name: z.string(),
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
  safeCheck: true,
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
          scheduler: 'LCM',
          lora: 'latent-consistency/lcm-lora-sdxl',
        },
        displayedSettings: ['imageModel', 'inpaintModel', 'guidanceScale', 'scheduler'],
        modifiableSettings: [
          'resolution',
          'seed',
          'inferenceSteps',
          'batchSize',
          'imagePreview',
        ],
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
    const globalSetup = useGlobalSetup()
    const i18nState = useI18N().state

    const hdWarningDismissed = ref(false)

    const workflows = ref<Workflow[]>(predefinedWorkflows)
    const activeWorkflowName = ref<string | null>('Standard - Fast')
    const activeWorkflow = computed(() => {
      console.log('### activeWorkflowName', activeWorkflowName.value)
      return (
        workflows.value.find((w) => w.name === activeWorkflowName.value) ?? predefinedWorkflows[0]
      )
    })
    const processing = ref(false)
    const stopping = ref(false)

    // general settings
    const prompt = ref<string>(generalDefaultSettings.prompt)
    const seed = ref<number>(generalDefaultSettings.seed)
    const imagePreview = ref<boolean>(generalDefaultSettings.imagePreview)
    const safeCheck = ref<boolean>(generalDefaultSettings.safeCheck)
    const batchSize = ref<number>(globalDefaultSettings.batchSize) // TODO this should be imageCount instead, as we only support batchSize 1 due to memory constraints

    const resetActiveWorkflowSettings = () => {
      prompt.value = generalDefaultSettings.prompt
      seed.value = generalDefaultSettings.seed
      imagePreview.value = generalDefaultSettings.imagePreview
      safeCheck.value = generalDefaultSettings.safeCheck
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

    const imageUrls = ref<string[]>([])
    const currentState = ref<SDGenerateState>('no_start')
    const stepText = ref('')
    const previewIdx = ref(0)
    const generateIdx = ref(-999)

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

    async function updateDestImage(index: number, image: string) {
      if (index + 1 > imageUrls.value.length) {
        imageUrls.value.push(image)
      } else {
        imageUrls.value.splice(index, 1, image)
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
        await globalSetup.checkModelAlreadyLoaded(checkList)
      const modelsToBeLoaded = checkedModels.filter(
        (checkModelExistsResult) => !checkModelExistsResult.already_loaded,
      )
      for (const item of modelsToBeLoaded) {
        if (!(await globalSetup.checkIfHuggingFaceUrlExists(item.repo_id))) {
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

      const result = await globalSetup.checkModelAlreadyLoaded(checkList)
      return result.filter((checkModelExistsResult) => !checkModelExistsResult.already_loaded)
    }

    async function generate() {
      generateIdx.value = 0
      previewIdx.value = 0
      stepText.value = i18nState.COM_GENERATING
      if (activeWorkflow.value.backend === 'default') {
        stableDiffusion.generate()
      } else {
        comfyUi.generate()
      }
    }

    function stopGeneration() {
      stableDiffusion.stop()
      comfyUi.stop()
    }

    function reset() {
      currentState.value = 'no_start'
      stableDiffusion.generateParams.length = 0
      imageUrls.value.length = 0
      generateIdx.value = -999
      previewIdx.value = -1
    }

    loadWorkflowsFromJson()

    return {
      hdWarningDismissed,
      backend,
      workflows,
      activeWorkflowName,
      activeWorkflow,
      processing,
      prompt,
      imageUrls,
      currentState,
      stepText,
      stopping,
      previewIdx,
      generateIdx,
      imageModel,
      inpaintModel,
      lora,
      scheduler,
      guidanceScale,
      imagePreview,
      safeCheck,
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
      updateDestImage,
      generate,
      stopGeneration,
      reset,
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
      ],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useImageGeneration, import.meta.hot))
}
