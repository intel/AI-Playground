import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import {
  REMOTE_DOWNLOAD_GRANT,
  VRAM_WARNING_GRANT_PREFIX,
  vramWarningGrantKey,
  type PermissionGrant,
  type PermissionGrantOrigin,
} from '@/types/permissionsIpc'

/**
 * Renderer projection of the kernel permission-grants file (step 13). Mutations
 * write through IPC; the file in main is source of truth. Legacy
 * `memoryAlertSuppress_*` flags and a leftover Pinia persist payload migrate
 * once on `init()`.
 */

export { REMOTE_DOWNLOAD_GRANT, VRAM_WARNING_GRANT_PREFIX, vramWarningGrantKey }
export type { PermissionGrant, PermissionGrantOrigin }

const LEGACY_PERSIST_KEY = 'permissionGrants'

function importLegacyMemoryAlerts(): Record<string, PermissionGrant> {
  const imported: Record<string, PermissionGrant> = {}
  try {
    if (typeof localStorage === 'undefined') return imported
    const legacyPrefix = 'memoryAlertSuppress_'
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(legacyPrefix)) continue
      stale.push(key)
      if (localStorage.getItem(key) !== '1') continue
      const presetName = key.slice(legacyPrefix.length)
      imported[vramWarningGrantKey(presetName)] = {
        key: vramWarningGrantKey(presetName),
        origin: 'remember',
        createdAt: Date.now(),
      }
    }
    for (const key of stale) localStorage.removeItem(key)
  } catch {
    // localStorage unavailable (tests, hardened contexts): start empty.
  }
  return imported
}

function leftoverPiniaGrants(): Record<string, PermissionGrant> {
  try {
    const raw = demoAwareStorage.getItem(LEGACY_PERSIST_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as { grants?: Record<string, PermissionGrant> }
    demoAwareStorage.removeItem(LEGACY_PERSIST_KEY)
    return parsed.grants && typeof parsed.grants === 'object' ? parsed.grants : {}
  } catch {
    return {}
  }
}

export const usePermissionGrants = defineStore('permissionGrants', () => {
  const grants = ref<Record<string, PermissionGrant>>({})

  const list = computed<PermissionGrant[]>(() =>
    Object.values(grants.value).sort((a, b) => b.createdAt - a.createdAt),
  )

  function has(key: string): boolean {
    return Boolean(grants.value[key])
  }

  function setLocal(next: PermissionGrant[]): void {
    const map: Record<string, PermissionGrant> = {}
    for (const grant of next) map[grant.key] = grant
    grants.value = map
  }

  async function refresh(): Promise<void> {
    const api = window.electronAPI?.permissions
    if (!api?.list) return
    const result = await api.list()
    if (result.success) setLocal(result.grants)
  }

  async function init(): Promise<void> {
    await refresh()
    const leftover = { ...leftoverPiniaGrants(), ...importLegacyMemoryAlerts() }
    if (Object.keys(leftover).length === 0) return
    const api = window.electronAPI?.permissions
    if (!api?.migrate) {
      grants.value = { ...leftover, ...grants.value }
      return
    }
    await api.migrate(leftover)
    await refresh()
  }

  function grant(key: string, origin: PermissionGrantOrigin): void {
    grants.value = {
      ...grants.value,
      [key]: { key, origin, createdAt: Date.now() },
    }
    const api = window.electronAPI?.permissions
    if (!api?.grant) return
    void api.grant(key, origin).then((result) => {
      if (result.success) void refresh()
    })
  }

  function revoke(key: string): void {
    const next = { ...grants.value }
    delete next[key]
    grants.value = next
    const api = window.electronAPI?.permissions
    if (!api?.revoke) return
    void api.revoke(key).then((result) => {
      if (result.success) void refresh()
    })
  }

  return { grants, list, has, grant, revoke, init }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePermissionGrants, import.meta.hot))
}
