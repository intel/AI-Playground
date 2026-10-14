import fs from 'fs'
import { safeStorage } from 'electron'
import type { CloudProviderInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import { ipcFail } from '../typedIpc'
import { setAllowedUpstreams, type CloudProxy } from '../../adapters/cloudProxy'

/**
 * The provider-key file helpers and Cloud Mode proxy lookup the four
 * cloudProvider handlers close over. All three stay in main.ts: the lazy
 * proxy singleton is also torn down by main's shutdown registration.
 */
export type CloudProviderDeps = {
  cloudProviderKeyPath: (providerId: string) => string
  readCloudProviderKey: (providerId: string) => string | null
  getCloudProxy: () => Promise<CloudProxy>
}

export function buildCloudProviderRegistry(deps: CloudProviderDeps) {
  // Cloud Mode provider API keys: encrypted at rest via safeStorage and never
  // persisted in the renderer. Each provider's key lives in its own file keyed
  // by provider id, mirroring the Home Agent channel-secret layout.
  // Reading/decryption happens in main only (readCloudProviderKey); the proxy
  // attaches the bearer token so the plaintext key never reaches the renderer.
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

    // Loopback URL of the Cloud Mode proxy. The renderer points its
    // OpenAI-compatible client and model-list fetch at this URL and tags each
    // request with X-Cloud-Upstream / X-Cloud-Provider (see cloudProxy.ts).
    'cloudProvider:getProxyUrl': async () => {
      return (await deps.getCloudProxy()).url
    },

    'cloudProvider:getAuthToken': async () => {
      return (await deps.getCloudProxy()).authToken
    },

    'cloudProvider:setAllowedUpstreams': (_event, entries) => {
      setAllowedUpstreams(entries)
      return { success: true as const }
    },
  } satisfies InvokeHandlerMap<CloudProviderInvokeName>
}
