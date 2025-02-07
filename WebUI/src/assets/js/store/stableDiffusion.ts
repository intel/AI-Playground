import { defineStore } from 'pinia'
import { useImageGeneration } from './imageGeneration'
import { useGlobalSetup } from './globalSetup'
import * as Const from '../const'
import { useModels } from './models'
import * as util from '../util'
import { SSEProcessor } from '../sseProcessor'
import { useI18N } from './i18n'
import * as toast from '../toast'
import { mapModeToText } from '@/lib/utils.ts'

type DefaultBackendParams = {
  mode: number
  device: string
  prompt: string
  model_repo_id: string
  negative_prompt: string
  generate_number: number
  inference_steps: number
  guidance_scale: number
  seed: number
  height: number
  width: number
  lora: string
  scheduler: string
  image_preview: boolean
  safe_check: boolean
}

type ImageInfoParams = {
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
    const defaultBackendParams = ref<DefaultBackendParams>()

    async function generate() {
      if (imageGeneration.processing) {
        return
      }
      try {
        imageGeneration.processing = true
        await checkModel()
        defaultBackendParams.value = {
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
          const infoParams: KVObject | undefined =
            defaultBackendParams.value &&
            createInfoParamTable({
              ...defaultBackendParams.value,
              size: data.params.size,
              model_name: data.params.model_name,
              output_seed: Number(data.params.seed),
            })
          await imageGeneration.updateImage(data.index, data.image, false, infoParams)
          break

        case 'step_end':
          imageGeneration.currentState = 'generating'
          imageGeneration.stepText = `${i18nState.COM_GENERATING} ${data.step}/${data.total_step}`
          if (data.image) {
            await imageGeneration.updateImage(data.index, data.image, true)
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
          body: util.convertToFormData(defaultBackendParams.value),
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

    function createInfoParamTable(infoParams: ImageInfoParams) {
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
      const mappingKeyToInfoParams: StringOrNumberOrBooleanKV = {
        backend: 'Default',
        model_name: infoParams.model_name,
        prompt: infoParams.prompt,
        resolution: infoParams.width + 'x' + infoParams.height,
        Device: infoParams.device,
        mode: mapModeToText(infoParams.mode),
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

    function reset() {
      defaultBackendParams.value = undefined
    }

    return {
      generate,
      stop,
      reset,
    }
  },
  {
    persist: {
      pick: ['settings', 'hdWarningDismissed'],
    },
  },
)
