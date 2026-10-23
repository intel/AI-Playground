import * as toast from '@/assets/js/toast.ts'
import { useModels } from './models'

export * from '@/lib/comfyResolutions'

function extractDownloadModelParamsFromString(requiredModel: {
  type: string
  model: string
  additionalLicenceLink?: string
}) {
  return {
    repo_id: requiredModel.model,
    type: requiredModel.type,
    backend: 'comfyui' as const,
    additionalLicenseLink: requiredModel.additionalLicenceLink,
  }
}

export async function getMissingComfyuiBackendModels(
  requiredModels: { type: string; model: string; additionalLicenceLink?: string }[],
): Promise<DownloadModelParam[]> {
  const models = useModels()

  const checkList = requiredModels.map(extractDownloadModelParamsFromString)
  const checkedModels = await models.checkModelAlreadyLoaded(checkList)
  const modelsToBeLoaded = checkedModels.filter(
    (checkModelExistsResult) => !checkModelExistsResult.already_loaded,
  )
  for (const item of modelsToBeLoaded) {
    if (!(await models.checkIfHuggingFaceUrlExists(item.repo_id))) {
      // Throw so callers (ensureModelsAreAvailable / WorkflowResult.generateImage)
      // see the failure and abort. Returning [] previously made the caller
      // think nothing was missing, so generation continued and OVMS attempted
      // to clone the unavailable repo itself.
      const message = `declared model ${item.repo_id} does not exist or is not accessible with the configured HF token. Aborting generation.`
      toast.error(message)
      throw new Error(message)
    }
  }
  return modelsToBeLoaded
}
