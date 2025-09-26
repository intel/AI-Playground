import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { appLoggerInstance } from './logging/logger.ts'
import { externalResourcesDir } from './util.ts'
import z from 'zod'
import { ModelSchema } from '../src/types/shared.ts'
import { LocalSettings } from './main.ts'

const BackendVersionSchema = z.object({ releaseTag: z.string().optional(), version: z.string() })
type BackendVersion = z.infer<typeof BackendVersionSchema>
const BackendVersionsSchema = z.object({
  'ai-backend': BackendVersionSchema.optional(),
  'comfyui-backend': BackendVersionSchema,
  'llamacpp-backend': BackendVersionSchema,
  'openvino-backend': BackendVersionSchema,
  'ollama-backend': BackendVersionSchema,
})
type BackendVersions = z.infer<typeof BackendVersionsSchema>

const getRemoteBaseUrl = (settings?: LocalSettings): string => {
  const remoteRepository = settings?.remoteRepository ?? 'intel/ai-playground'
  const appVersion = app.getVersion()
  return `https://raw.githubusercontent.com/${remoteRepository}/refs/heads/${appVersion}/WebUI/external/`
}

const getRemoteVersionsUrl = (settings?: LocalSettings): string => {
  return `${getRemoteBaseUrl(settings)}backend-versions.json`
}

const getRemoteModelsUrl = (settings?: LocalSettings): string => {
  return `${getRemoteBaseUrl(settings)}models.json`
}

const loadLocalVersions = async (): Promise<BackendVersions> => {
  const versionsFilePath = path.join(externalResourcesDir(), 'backend-versions.json')

  try {
    if (await fs.promises.stat(versionsFilePath)) {
      const versionsData = await fs.promises.readFile(versionsFilePath, 'utf-8')
      const versions = JSON.parse(versionsData)
      appLoggerInstance.info(`Loaded backend versions from ${versionsFilePath}`, 'backend-version')
      return versions
    } else {
      appLoggerInstance.warn(
        `Backend versions file not found at ${versionsFilePath}`,
        'backend-version',
      )
      throw new Error('Backend versions file not found')
    }
  } catch (error) {
    appLoggerInstance.error(`Failed to load backend versions: ${error}`, 'backend-version')
    throw new Error('Failed to load backend versions')
  }
}

const cachedRemoteVersions = null as BackendVersions | null
const fetchRemoteVersions = async (remoteUrl: string): Promise<BackendVersions | null> => {
  if (cachedRemoteVersions) {
    appLoggerInstance.info(`Using cached remote versions`, 'backend-version')
    return cachedRemoteVersions
  }

  try {
    appLoggerInstance.info(`Fetching backend versions from ${remoteUrl}`, 'backend-version')

    const response = await fetch(remoteUrl)
    if (!response.ok) {
      appLoggerInstance.warn(
        `Failed to fetch remote versions: ${response.status} ${response.statusText}`,
        'backend-version',
      )
      return null
    }

    const remoteVersionsText = await response.text()
    const remoteVersions = BackendVersionsSchema.parse(JSON.parse(remoteVersionsText))

    appLoggerInstance.info('Successfully fetched backend versions from remote', 'backend-version')
    return remoteVersions
  } catch (error) {
    appLoggerInstance.error(`Failed to fetch versions from remote: ${error}`, 'backend-version')
    return null
  }
}

let fetchRemotePromise: Promise<BackendVersions | null> | null = null
let loadLocalPromise: Promise<BackendVersions> | null = null
export const resolveBackendVersion = async (
  serviceName: BackendServiceName,
  settings?: LocalSettings,
): Promise<BackendVersion | undefined> => {
  try {
    const remoteUrl = getRemoteVersionsUrl(settings)
    if (!fetchRemotePromise) {
      fetchRemotePromise = fetchRemoteVersions(remoteUrl)
    }
    const remoteVersions = await fetchRemotePromise
    if (remoteVersions && remoteVersions[serviceName]) {
      appLoggerInstance.info(
        `Using remote version for ${serviceName}: ${JSON.stringify(remoteVersions[serviceName])}`,
        'backend-version',
      )
      return remoteVersions[serviceName]
    }
  } catch (error) {
    appLoggerInstance.warn(
      `Failed to get remote version for ${serviceName}: ${error}`,
      'backend-version',
    )
  }

  if (!loadLocalPromise) {
    loadLocalPromise = loadLocalVersions()
  }
  const localVersion = (await loadLocalPromise)[serviceName]
  if (localVersion) {
    appLoggerInstance.info(
      `Using local version for ${serviceName}: ${JSON.stringify(localVersion)}`,
      'backend-version',
    )
    return localVersion
  }

  appLoggerInstance.warn(`No version found for ${serviceName}`, 'backend-version')
  return undefined
}

const loadLocalModels = async () => {
  const modelsFilePath = path.join(externalResourcesDir(), 'models.json')
  try {
    const modelsData = await fs.promises.readFile(modelsFilePath, 'utf-8')
    const models = z.array(ModelSchema).parse(JSON.parse(modelsData))
    appLoggerInstance.info(`Loaded backend models from ${modelsFilePath}`, 'models')
    return models
  } catch (error) {
    // handle ENOENT
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      appLoggerInstance.warn(`Models file not found at ${modelsFilePath}`, 'models')
      throw new Error('Models file not found')
    }
    appLoggerInstance.error(`Failed to load models: ${error}`, 'models')
    throw new Error('Failed to load models')
  }
}

let cachedRemoteModels = null as z.infer<typeof ModelSchema>[] | null
const fetchRemoteModels = async (
  remoteUrl: string,
): Promise<z.infer<typeof ModelSchema>[] | null> => {
  if (cachedRemoteModels) {
    appLoggerInstance.info(`Using cached remote models`, 'models')
    return cachedRemoteModels
  }

  try {
    appLoggerInstance.info(`Fetching models from ${remoteUrl}`, 'models')

    const response = await fetch(remoteUrl)
    if (!response.ok) {
      appLoggerInstance.warn(
        `Failed to fetch remote models: ${response.status} ${response.statusText}`,
        'models',
      )
      return null
    }

    const remoteModelsText = await response.text()
    const remoteModels = z.array(ModelSchema).parse(JSON.parse(remoteModelsText))

    appLoggerInstance.info('Successfully fetched models from remote', 'models')
    cachedRemoteModels = remoteModels
    return remoteModels
  } catch (error) {
    appLoggerInstance.error(`Failed to fetch models from remote: ${error}`, 'models')
    return null
  }
}

let fetchRemoteModelsPromise: Promise<z.infer<typeof ModelSchema>[] | null> | null = null
let loadLocalModelsPromise: Promise<z.infer<typeof ModelSchema>[]> | null = null
export const resolveModels = async (
  settings?: LocalSettings,
): Promise<z.infer<typeof ModelSchema>[]> => {
  try {
    const remoteUrl = getRemoteModelsUrl(settings)
    if (!fetchRemoteModelsPromise) {
      fetchRemoteModelsPromise = fetchRemoteModels(remoteUrl)
    }
    const remoteModels = await fetchRemoteModelsPromise
    if (remoteModels) {
      appLoggerInstance.info(`Using remote models (${remoteModels.length} models)`, 'models')
      return remoteModels
    }
  } catch (error) {
    appLoggerInstance.warn(`Failed to get remote models: ${error}`, 'models')
  }

  if (!loadLocalModelsPromise) {
    loadLocalModelsPromise = loadLocalModels()
  }
  const localModels = await loadLocalModelsPromise
  appLoggerInstance.info(`Using local models (${localModels.length} models)`, 'models')
  return localModels
}
