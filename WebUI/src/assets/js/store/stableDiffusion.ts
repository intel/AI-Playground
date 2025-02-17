import { defineStore } from 'pinia'
import { GeneratedImage, ImageInfoParameter, useImageGeneration } from './imageGeneration'
import { useGlobalSetup } from './globalSetup'
import * as Const from '../const'
import { useModels } from './models'
import * as util from '../util'
import { SSEProcessor } from '../sseProcessor'
import { useI18N } from './i18n'
import * as toast from '../toast'
import { DefaultBackendParams } from '@/assets/js/store/imageGeneration.ts'

type ImageInfoParamsSD = {
  size: string
  model_name: string
  output_seed: number
} & DefaultBackendParams

export const useStableDiffusion = defineStore(
  'stableDiffusion',
  () => {
    const imageGeneration = useImageGeneration()
    const globalSetup = useGlobalSetup()
    const i18nState = useI18N().state
    const models = useModels()

    let abortController: AbortController | null
    const generationParameters = ref<DefaultBackendParams>()
    let hashIds: string[] = []

    async function generate() {
      if (imageGeneration.processing) {
        return
      }
      try {
        imageGeneration.processing = true
        await checkModel()
        generationParameters.value = {
          mode: 0,
          device: globalSetup.modelSettings.graphics,
          prompt: imageGeneration.prompt,
          model_repo_id: `stableDiffusion:${imageGeneration.imageModel}`,
          negative_prompt: imageGeneration.negativePrompt,
          generate_number: imageGeneration.batchSize,
          inference_steps: imageGeneration.inferenceSteps,
          guidance_scale: imageGeneration.guidanceScale,
          seed: imageGeneration.seed,
          height: imageGeneration.height,
          width: imageGeneration.width,
          lora: imageGeneration.lora,
          scheduler: imageGeneration.scheduler,
          image_preview: imageGeneration.imagePreview,
          safe_check: imageGeneration.safeCheck,
        }
        hashIds = Array.from({ length: imageGeneration.batchSize }, () =>
          window.crypto.randomUUID(),
        )
        await sendGenerate()
      } catch (_error: unknown) {
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
        const result = await globalSetup.checkModelAlreadyLoaded(checkList)
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
      const data = JSON.parse(dataJson) as SDOutCallback
      switch (data.type) {
        case 'image_out':
          imageGeneration.currentState = 'image_out'
          if (!data.safe_check_pass) {
            data.image = '/src/assets/image/nsfw_result_detected.png'
          }
          const infoParams: ImageInfoParameter | undefined =
            generationParameters.value &&
            createInfoParamTable({
              ...generationParameters.value,
              size: data.params.size,
              model_name: data.params.model_name,
              output_seed: Number(data.params.seed),
            })
          const newImage: GeneratedImage = {
            id: hashIds[data.index],
            imageUrl: data.image,
            isLoading: false,
            infoParams: infoParams,
          }
          await imageGeneration.updateImage(newImage)
          break

        case 'step_end':
          imageGeneration.currentState = 'generating'
          imageGeneration.stepText = `${i18nState.COM_GENERATING} ${data.step}/${data.total_step}`
          const updatedImage: GeneratedImage = {
            id: hashIds[data.index],
            imageUrl: data.image ?? '',
            isLoading: true,
            infoParams: undefined,
          }
          if (data.image) {
            await imageGeneration.updateImage(updatedImage)
          }
          break
        case 'load_model':
          imageGeneration.currentState = 'load_model'
          break
        case 'load_model_components':
          imageGeneration.currentState =
            data.event == 'finish' ? 'generating' : 'load_model_components'
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

    async function sendGenerate() {
      try {
        imageGeneration.processing = true
        if (!abortController) {
          abortController = new AbortController()
        }

        const response = await fetch(`${useGlobalSetup().apiHost}/api/sd/generate`, {
          method: 'POST',
          body: util.convertToFormData(generationParameters.value),
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

    function createInfoParamTable(infoParams: ImageInfoParamsSD) {
      const mappingKeyToTranslatable: StringKV = {
        backend: 'BACKEND',
        model_name: 'DOWNLOADER_MODEL',
        prompt: 'INPUT_PROMPT',
        resolution: 'SETTINGS_MODEL_IMAGE_RESOLUTION',
        Device: 'DEVICE',
        size: 'SETTINGS_MODEL_IMAGE_SIZE',
        seed: 'SETTINGS_MODEL_SEED',
        negative_prompt: 'SETTINGS_MODEL_NEGATIVE_PROMPT',
        inference_steps: 'SETTINGS_MODEL_IMAGE_STEPS',
        guidance_scale: 'SETTINGS_MODEL_IMAGE_CFG',
        scheduler: 'SETTINGS_MODEL_SCHEDULER',
        lora: 'SETTINGS_MODEL_LORA',
        safe_check: 'SETTINGS_MODEL_SAFE_CHECK',
      }
      const mappingKeyToInfoParams: ImageInfoParameter = {
        backend: 'Default',
        model_name: infoParams.model_name,
        prompt: infoParams.prompt,
        resolution: infoParams.width + 'x' + infoParams.height,
        Device: infoParams.device,
        size: infoParams.size,
        seed: infoParams.output_seed,
        negative_prompt: infoParams.negative_prompt,
        inference_steps: infoParams.inference_steps,
        guidance_scale: infoParams.guidance_scale,
        scheduler: infoParams.scheduler,
        lora: infoParams.lora,
        safe_check: infoParams.safe_check,
      }
      return Object.fromEntries(
        Object.keys(mappingKeyToInfoParams).map((key) => [
          mappingKeyToTranslatable[key],
          mappingKeyToInfoParams[key],
        ]),
      )
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
