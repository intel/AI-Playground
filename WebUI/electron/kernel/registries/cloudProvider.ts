import fs from 'fs'
import { safeStorage } from 'electron'
import type { CloudProviderInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import { ipcFail } from '../typedIpc'
import { fetchCloudUpstream } from '../../adapters/cloudUpstream'

/**
 * The provider-key file helpers the cloudProvider handlers close over.
 * Decryption stays in main.ts; this registry only calls it.
 */
export type CloudProviderDeps = {
  cloudProviderKeyPath: (providerId: string) => string
  readCloudProviderKey: (providerId: string) => string | null
}

export function buildCloudProviderRegistry(deps: CloudProviderDeps) {
  // Cloud Mode provider API keys: encrypted at rest via safeStorage and never
  // persisted in the renderer. Each provider's key lives in its own file keyed
  // by provider id, mirroring the Home Agent channel-secret layout.
  // Reading/decryption happens in main only (readCloudProviderKey). Chat, agent
  // turns, and the model list attach that key when they call the provider.
  return {
    'cloudProvider:saveKey': (_event, providerId, key) => {
      try {
        const raw = (key ?? '').trim()
        if (!raw) {
          // Empty key clears any stored secret.
          try {
            fs.unlinkSync(deps.cloudProviderKeyPath(providerId))
          } catch {
            /* nothing to remove */
          }
          return { success: true as const }
        }
        const blob = safeStorage.encryptString(raw).toJSON()
        fs.writeFileSync(deps.cloudProviderKeyPath(providerId), JSON.stringify(blob), 'utf-8')
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },

    'cloudProvider:getKey': (_event, providerId) => deps.readCloudProviderKey(providerId),

    'cloudProvider:deleteKey': (_event, providerId) => {
      try {
        fs.unlinkSync(deps.cloudProviderKeyPath(providerId))
      } catch {
        /* already gone */
      }
      return { success: true as const }
    },

    'cloudProvider:listModels': async (_event, providerId, baseUrl, authStyle) => {
      try {
        const response = await fetchCloudUpstream({
          providerId,
          baseUrl,
          authStyle,
          url: '/v1/models',
          getKey: deps.readCloudProviderKey,
        })
        const body = await response.text()
        if (!response.ok) {
          return {
            success: false as const,
            error: `HTTP ${response.status}`,
            status: response.status,
            body,
          }
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          return { success: false as const, error: 'invalid json', body }
        }
        const data = (parsed as { data?: unknown }).data
        if (!Array.isArray(data)) {
          return { success: false as const, error: 'invalid json', body }
        }
        return { success: true as const, data: data as Record<string, unknown>[] }
      } catch (e) {
        return { success: false as const, error: e instanceof Error ? e.message : String(e) }
      }
    },
  } satisfies InvokeHandlerMap<CloudProviderInvokeName>
}
