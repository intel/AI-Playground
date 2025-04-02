import { acceptHMRUpdate, defineStore } from 'pinia'
import { GenerationSettings, Image, useImageGeneration } from './imageGeneration'
import { useGlobalSetup } from './globalSetup'
import * as Const from '../const'
import { useModels } from './models'
import * as util from '../util'
import { SSEProcessor } from '../sseProcessor'
import { useI18N } from './i18n'
import * as toast from '../toast'
import { z } from 'zod'
import nsfwPlaceholder from '/src/assets/image/nsfw_result_detected.png?inline'

const LoadModelCallbackSchema = z.object({
  type: z.literal('load_model'),
  event: z.union([z.literal('start'), z.literal('finish')]),
})

const LoadModelComponentsCallbackSchema = z.object({
  type: z.literal('load_model_components'),
  event: z.union([z.literal('start'), z.literal('finish')]),
})

const SDOutImageCallbackSchema = z.object({
  type: z.literal('image_out'),
  index: z.number(),
  image: z.string(),
  safe_check_pass: z.boolean(),
  params: z.object({
    seed: z.number(),
  }),
})

const SDStepEndCallbackSchema = z.object({
  type: z.literal('step_end'),
  index: z.number(),
  step: z.number(),
  total_step: z.number(),
  image: z.string().nullable().optional(),
})

const ErrorOutCallbackSchema = z.object({
  type: z.literal('error'),
  err_type: z.enum([
    'not_enough_disk_space',
    'runtime_error',
    'download_exception',
    'unknown_exception',
  ]),
  requires_space: z.string(),
  free_space: z.string(),
})

const SDOutCallbackSchema = z.discriminatedUnion('type', [
  LoadModelCallbackSchema,
  LoadModelComponentsCallbackSchema,
  SDOutImageCallbackSchema,
  SDStepEndCallbackSchema,
  ErrorOutCallbackSchema,
])

export type SDOutCallback = z.infer<typeof SDOutCallbackSchema>

// zod schema for DefaultBackendParams
const DefaultBackendParamsSchema = z.object({
  mode: z.number(),
  device: z.number(),
  prompt: z.string(),
  negative_prompt: z.string(),
  model_repo_id: z.string(),
  generate_number: z.number(),
  inference_steps: z.number(),
  guidance_scale: z.number(),
  seed: z.number(),
  height: z.number(),
  width: z.number(),
  lora: z.string(),
  scheduler: z.string(),
  image_preview: z.boolean(),
  safe_check: z.boolean(),
})
type DefaultBackendParams = z.infer<typeof DefaultBackendParamsSchema>

export const useStableDiffusion = defineStore(
  'stableDiffusion',
  () => {
    const imageGeneration = useImageGeneration()
    const globalSetup = useGlobalSetup()
    const i18nState = useI18N().state
    const models = useModels()

    let abortController: AbortController | null
    let queuedImages: Image[] = []

    const toBackendParams = (params: GenerationSettings): DefaultBackendParams => {
      return DefaultBackendParamsSchema.parse({
        mode: 0,
        device: params.device,
        prompt: params.prompt,
        negative_prompt: params.negativePrompt,
        model_repo_id: `stableDiffusion:${params.imageModel}`,
        generate_number: params.batchSize,
        inference_steps: params.inferenceSteps,
        guidance_scale: params.guidanceScale,
        seed: params.seed,
        height: params.height,
        width: params.width,
        lora: params.lora,
        scheduler: params.scheduler,
        image_preview: params.imagePreview,
        safe_check: params.safetyCheck,
      })
    }

    async function generate(imageIds: string[]) {
      if (imageGeneration.processing) {
        return
      }
      try {
        imageGeneration.processing = true
        await checkModel()
        queuedImages = Array.from({ length: imageGeneration.batchSize }, (_, i) => ({
          id: imageIds[i],
          imageUrl:
            'data:image/svg+xml,%3C%3Fxml%20version%3D%221.0%22%20encoding%3D%22UTF-8%22%3F%3E%3Csvg%20width%3D%2224px%22%20height%3D%2224px%22%20viewBox%3D%220%200%2024%2024%22%20stroke-width%3D%221.5%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20color%3D%22%23000000%22%3E%3Cpath%20d%3D%22M12%2012C15.866%2012%2019%208.86599%2019%205H5C5%208.86599%208.13401%2012%2012%2012ZM12%2012C15.866%2012%2019%2015.134%2019%2019H5C5%2015.134%208.13401%2012%2012%2012Z%22%20stroke%3D%22%23000000%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3C%2Fpath%3E%3Cpath%20d%3D%22M5%202L12%202L19%202%22%20stroke%3D%22%23000000%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3C%2Fpath%3E%3Cpath%20d%3D%22M5%2022H12L19%2022%22%20stroke%3D%22%23000000%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E',
          state: 'queued',
          settings: imageGeneration.getGenerationParameters(),
        }))
        await sendGenerate(imageGeneration.getGenerationParameters())
      } catch (error: unknown) {
        console.error(error)
      } finally {
        imageGeneration.processing = false
      }
    }

    async function checkModel() {
      return new Promise<void>(async (resolve, _reject) => {
        const checkList: CheckModelAlreadyLoadedParameters[] = [
          {
            repo_id: globalSetup.modelSettings.sd_model,
            type: Const.MODEL_TYPE_STABLE_DIFFUSION,
            backend: 'default',
          },
        ]
        if (globalSetup.modelSettings.lora != 'None') {
          checkList.push({
            repo_id: globalSetup.modelSettings.lora,
            type: Const.MODEL_TYPE_LORA,
            backend: 'default',
          })
        }
        if (globalSetup.modelSettings.imagePreview) {
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
        const downloadList: CheckModelAlreadyLoadedParameters[] = []
        for (const item of result) {
          if (!item.already_loaded) {
            downloadList.push({ repo_id: item.repo_id, type: item.type, backend: 'default' })
          }
        }
        await models.download(downloadList)
        resolve()
      })
    }

    function finishGenerate() {
      imageGeneration.processing = false
    }

    async function dataProcess(line: string) {
      util.log(`SD data: ${line}`)
      const dataJson = line.slice(5)
      const data = SDOutCallbackSchema.parse(JSON.parse(dataJson))
      const mediaUrlBase = await window.electronAPI.getMediaUrlBase()
      let currentImage: Image
      switch (data.type) {
        case 'image_out':
          imageGeneration.currentState = 'image_out'
          currentImage = queuedImages[data.index]
          currentImage.state = 'done'
          currentImage.settings.seed = data.params.seed
          currentImage.imageUrl = mediaUrlBase + data.image
          if (!data.safe_check_pass) {
            currentImage.imageUrl = nsfwPlaceholder
          }

          imageGeneration.updateImage(currentImage)
          break

        case 'step_end':
          imageGeneration.currentState = 'generating'
          imageGeneration.stepText = `${i18nState.COM_GENERATING} ${data.step}/${data.total_step}`
          currentImage = queuedImages[data.index]
          currentImage.state = 'generating'
          if (data.image) {
            currentImage.imageUrl = data.image
          }
          imageGeneration.updateImage(currentImage)
          break
        case 'load_model':
          imageGeneration.currentState = 'load_model'
          break
        case 'load_model_components':
          if (data.event !== 'finish') {
            imageGeneration.currentState = 'load_model_components'
          } else {
            imageGeneration.currentState = 'generating'
            currentImage = queuedImages[0]
            imageGeneration.updateImage({
              ...currentImage,
              state: 'generating',
            })
          }
          break
        case 'error':
          imageGeneration.processing = false
          imageGeneration.currentState = 'error'

          switch (data.err_type) {
            case 'not_enough_disk_space':
              toast.error(
                i18nState.ERR_NOT_ENOUGH_DISK_SPACE.replace(
                  '{requires_space}',
                  data.requires_space,
                ).replace('{free_space}', data.free_space),
              )
              break
            case 'download_exception':
              toast.error(i18nState.ERR_DOWNLOAD_FAILED)
              break
            case 'runtime_error':
              toast.error(i18nState.ERROR_RUNTIME_ERROR)
              break
            case 'unknown_exception':
              toast.error(i18nState.ERROR_GENERATE_UNKONW_EXCEPTION)
              break
          }
          break
      }
    }

    async function sendGenerate(generationParams: GenerationSettings) {
      try {
        imageGeneration.processing = true
        if (!abortController) {
          abortController = new AbortController()
        }

        const response = await fetch(`${useGlobalSetup().apiHost}/api/sd/generate`, {
          method: 'POST',
          body: util.convertToFormData(toBackendParams(generationParams)),
          signal: abortController.signal,
        })
        const reader = response.body!.getReader()
        await new SSEProcessor(reader, dataProcess, finishGenerate).start()
      } finally {
        imageGeneration.processing = false
      }
    }

    async function stop() {
      if (imageGeneration.processing && !imageGeneration.stopping) {
        imageGeneration.stopping = true
        await fetch(`${globalSetup.apiHost}/api/sd/stopGenerate`)
        if (abortController) {
          abortController.abort()
          abortController = null
        }
        imageGeneration.processing = false
        imageGeneration.stopping = false
      }
    }

    return {
      generate,
      stop,
    }
  },
  {
    persist: {
      pick: ['settings', 'hdWarningDismissed'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useStableDiffusion, import.meta.hot))
}
