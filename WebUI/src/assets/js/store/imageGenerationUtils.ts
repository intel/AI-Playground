import * as toast from '@/assets/js/toast.ts'
import { useModels } from './models'
import type { CheckModelAlreadyLoadedParameters, DownloadModelParam } from '../env'

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

function extractDownloadModelParamsFromString(
  requiredModel: { type: string; model: string; additionalLicenceLink?: string },
): CheckModelAlreadyLoadedParameters {
  return {
    type: requiredModel.type,
    repo_id: requiredModel.model,
    backend: 'comfyui',
    additionalLicenseLink: requiredModel.additionalLicenceLink,
  }
}

export async function getMissingComfyuiBackendModels(
  requiredModels: { type: string; model: string; additionalLicenceLink?: string }[],
): Promise<DownloadModelParam[]> {
  const models = useModels()

  const checkList: CheckModelAlreadyLoadedParameters[] = requiredModels.map(extractDownloadModelParamsFromString)
  const checkedModels = await models.checkModelAlreadyLoaded(checkList)
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

