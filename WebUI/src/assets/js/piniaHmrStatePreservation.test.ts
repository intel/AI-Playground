import { describe, expect, it } from 'vitest'
import { createPinia, defineStore, setActivePinia, type Pinia, type Store } from 'pinia'
import { createPersistedState } from 'pinia-plugin-persistedstate'
import { createApp, ref } from 'vue'
import { preserveStateAcrossHmr } from './piniaHmrStatePreservation'

/**
 * What `acceptHMRUpdate` does for a changed store module: call the store
 * function of the new module with the already registered store as the hot
 * argument. Not part of Pinia's public types.
 */
type HotSwap = (pinia: Pinia, hot: Store) => void

/** Pinia only installs its plugins once it is attached to an app, as in `main.ts`. */
function createPiniaWithPlugins(...plugins: Parameters<Pinia['use']>[0][]): Pinia {
  const pinia = createPinia()
  plugins.forEach((plugin) => pinia.use(plugin))
  createApp({}).use(pinia)
  setActivePinia(pinia)
  return pinia
}

function createStorage() {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

/** Stand-in for a store file being edited: same id, freshly initialized state. */
function defineAgentModeStore(options: { addedInThisEdit?: boolean } = {}) {
  return defineStore(
    'agentMode',
    () => ({
      sessions: ref<Record<string, { title: string; messages: string[] }>>({}),
      workspaceDir: ref(''),
      ...(options.addedInThisEdit ? { defaultCapabilities: ref(['media']) } : {}),
    }),
    { persist: true },
  )
}

describe('preserveStateAcrossHmr', () => {
  it('keeps record entries — and their persisted copy — across a hot swap', async () => {
    const storage = createStorage()
    const pinia = createPiniaWithPlugins(createPersistedState({ storage }), preserveStateAcrossHmr)

    const store = defineAgentModeStore()()
    store.sessions = { s1: { title: 'Haiku about rain', messages: ['hi'] } }
    store.workspaceDir = '/work'

    // Editing the store file re-runs its setup, so `sessions` arrives empty.
    ;(defineAgentModeStore() as unknown as HotSwap)(pinia, store)

    expect(store.sessions).toEqual({ s1: { title: 'Haiku about rain', messages: ['hi'] } })
    expect(store.workspaceDir).toBe('/work')

    // The persistence plugin saves the store right after a hot update; that
    // write is what used to make the loss permanent.
    await Promise.resolve()
    expect(storage.getItem('agentMode')).toContain('Haiku about rain')
  })

  it('still adopts state the edited store adds', () => {
    const pinia = createPiniaWithPlugins(preserveStateAcrossHmr)

    const store = defineAgentModeStore()()
    store.sessions = { s1: { title: 'Kept', messages: [] } }
    ;(defineAgentModeStore({ addedInThisEdit: true }) as unknown as HotSwap)(pinia, store)

    expect((store as unknown as { defaultCapabilities: string[] }).defaultCapabilities).toEqual([
      'media',
    ])
    expect(Object.keys(store.sessions)).toEqual(['s1'])
  })
})
