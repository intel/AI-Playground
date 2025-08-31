import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { appLoggerInstance } from '../logging/logger.ts'
import { externalResourcesDir } from '../util.ts'
import z from 'zod'

const BackendVersionSchema = z.object({ releaseTag: z.string().optional(), version: z.string() })
type BackendVersion = z.infer<typeof BackendVersionSchema>
const BackendVersionsSchema = z.object({
  'ai-backend': BackendVersionSchema.optional(),
  'comfyui-backend': BackendVersionSchema,
  'llamacpp-backend': BackendVersionSchema,
  'openvino-backend': BackendVersionSchema,
  'ollama-backend': BackendVersionSchema
})
type BackendVersions = z.infer<typeof BackendVersionsSchema>

export const getRemoteVersionsUrl = (settings?: LocalSettings): string => {
  const remoteRepository = settings?.remoteRepository ?? 'intel/ai-playground'
  const appVersion = app.getVersion()
  return `https://raw.githubusercontent.com/${remoteRepository}/refs/heads/${appVersion}/WebUI/external/backend-versions.json`
}

export const loadLocalVersions = async (): Promise<BackendVersions> => {
  const versionsFilePath = path.join(externalResourcesDir(), 'backend-versions.json')
  
  try {
    if (await fs.promises.stat(versionsFilePath)) {
      const versionsData = await fs.promises.readFile(versionsFilePath, 'utf-8')
      const versions = JSON.parse(versionsData)
      appLoggerInstance.info(`Loaded backend versions from ${versionsFilePath}`, 'backend-version-manager')
      return versions
    } else {
      appLoggerInstance.warn(`Backend versions file not found at ${versionsFilePath}`, 'backend-version-manager')
      throw new Error('Backend versions file not found')
    }
  } catch (error) {
    appLoggerInstance.error(`Failed to load backend versions: ${error}`, 'backend-version-manager')
    throw new Error('Failed to load backend versions')
  }
}

let cachedRemoteVersions = null as BackendVersions | null
const fetchRemoteVersions = async (remoteUrl: string): Promise<BackendVersions | null> => {
  if (cachedRemoteVersions) {
    appLoggerInstance.info(`Using cached remote versions`, 'backend-version-manager')
    return cachedRemoteVersions
  }

  try {
    appLoggerInstance.info(`Fetching backend versions from ${remoteUrl}`, 'backend-version-manager')
    
    const response = await fetch(remoteUrl)
    if (!response.ok) {
      appLoggerInstance.warn(`Failed to fetch remote versions: ${response.status} ${response.statusText}`, 'backend-version-manager')
      return null
    }

    const remoteVersionsText = await response.text()
    const remoteVersions = BackendVersionsSchema.parse(JSON.parse(remoteVersionsText))

    appLoggerInstance.info('Successfully fetched backend versions from remote', 'backend-version-manager')
    return remoteVersions
  } catch (error) {
    appLoggerInstance.error(`Failed to fetch versions from remote: ${error}`, 'backend-version-manager')
    return null
  }
}

let fetchRemotePromise: Promise<BackendVersions | null> | null = null
let loadLocalPromise: Promise<BackendVersions> | null = null
export const resolveBackendVersion = async (
  serviceName: BackendServiceName,
  settings?: LocalSettings
): Promise<BackendVersion | undefined> => {

  try {
    const remoteUrl = getRemoteVersionsUrl(settings)
    if (!fetchRemotePromise) {
      fetchRemotePromise = fetchRemoteVersions(remoteUrl)
    }
    const remoteVersions = await fetchRemotePromise
    if (remoteVersions && remoteVersions[serviceName]) {
      appLoggerInstance.info(`Using remote version for ${serviceName}: ${JSON.stringify(remoteVersions[serviceName])}`, 'backend-version-manager')
      return remoteVersions[serviceName]
    }
  } catch (error) {
    appLoggerInstance.warn(`Failed to get remote version for ${serviceName}: ${error}`, 'backend-version-manager')
  }

  if (!loadLocalPromise) {
    loadLocalPromise = loadLocalVersions()
  }
  const localVersion = (await loadLocalPromise)[serviceName]
  if (localVersion) {
    appLoggerInstance.info(`Using local version for ${serviceName}: ${JSON.stringify(localVersion)}`, 'backend-version-manager')
    return localVersion
  }

  appLoggerInstance.warn(`No version found for ${serviceName}`, 'backend-version-manager')
  return undefined
}
