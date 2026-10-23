import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// The renderer half of the kernel-owned preferences file (step 8, §6.1):
// hydration, the one-shot legacy upload, and the debounced write-through —
// driven against the real helper with fakes at the IPC and storage seams.

const preferencesApi = vi.hoisted(() => ({
  read: vi.fn(
    async (): Promise<
      { success: true; sections: Record<string, unknown> } | { success: false; error: string }
    > => ({ success: true, sections: {} }),
  ),
  migrate: vi.fn(
    async (
      _section: string,
      _payload: unknown,
    ): Promise<{ success: true } | { success: false; error: string }> => ({ success: true }),
  ),
  write: vi.fn(
    async (
      _section: string,
      _value: unknown,
    ): Promise<{ success: true } | { success: false; error: string }> => ({ success: true }),
  ),
}))

const storage = vi.hoisted(() => ({ data: new Map<string, string>() }))

const errorsReport = vi.hoisted(() => vi.fn())

vi.mock('@/assets/js/demoAwareStorage', () => ({
  demoAwareStorage: {
    getItem: (key: string) => storage.data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.data.set(key, value)
    },
    removeItem: (key: string) => {
      storage.data.delete(key)
    },
  },
}))

vi.mock('@/assets/js/store/errors', () => ({
  useErrors: () => ({ report: errorsReport }),
}))

const { makeFileBackedPreference } = await import('@/lib/fileBackedPreferences')

let windowListeners: Record<string, Array<() => void>>

function makeHarness(legacyKey?: string) {
  const selected = ref<string | null>(null)
  const enabled = ref(false)
  const config = ref({ enabled: false, apiKey: '' })
  const prefs = makeFileBackedPreference({
    section: 'theme',
    refs: { selected, enabled, config },
    legacyKey,
  })
  return { prefs, selected, enabled, config }
}

const advanceFlush = () => vi.advanceTimersByTimeAsync(350)

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  storage.data.clear()
  preferencesApi.read.mockImplementation(async () => ({
    success: true as const,
    sections: {} as Record<string, unknown>,
  }))
  preferencesApi.migrate.mockImplementation(async () => ({ success: true as const }))
  preferencesApi.write.mockImplementation(async () => ({ success: true as const }))
  windowListeners = {}
  ;(globalThis as Record<string, unknown>).window = {
    __AIPG_DEMO_MODE__: false,
    electronAPI: { preferences: preferencesApi },
    addEventListener: (event: string, handler: () => void) => {
      ;(windowListeners[event] ??= []).push(handler)
    },
    removeEventListener: (event: string, handler: () => void) => {
      windowListeners[event] = (windowListeners[event] ?? []).filter((h) => h !== handler)
    },
  }
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as Record<string, unknown>).window
})

describe('file-backed preferences', () => {
  it('hydrates the section from the file', async () => {
    preferencesApi.read.mockImplementation(async () => ({
      success: true as const,
      sections: { theme: { selected: 'dark' } },
    }))
    const { prefs, selected, enabled } = makeHarness()
    await prefs.init()
    expect(selected.value).toBe('dark')
    expect(enabled.value).toBe(false)
    expect(prefs.hydrated.value).toBe(true)
  })

  it('leaves defaults when the section is absent and writes nothing', async () => {
    const { prefs, selected } = makeHarness()
    await prefs.init()
    expect(selected.value).toBeNull()
    await advanceFlush()
    expect(preferencesApi.write).not.toHaveBeenCalled()
  })

  it('uploads the legacy payload once and drops the key', async () => {
    storage.data.set(
      'theme',
      JSON.stringify({ selected: 'bmg', enabled: true, unrelated: 'field' }),
    )
    const { prefs, selected, enabled } = makeHarness('theme')
    await prefs.init()
    expect(selected.value).toBe('bmg')
    expect(enabled.value).toBe(true)
    expect(preferencesApi.migrate).toHaveBeenCalledTimes(1)
    expect(preferencesApi.migrate.mock.calls[0]).toEqual([
      'theme',
      { selected: 'bmg', enabled: true },
    ])
    expect(storage.data.has('theme')).toBe(false)
    expect(preferencesApi.write).not.toHaveBeenCalled()
  })

  it('keeps the legacy key and reports when the upload is refused', async () => {
    storage.data.set('theme', JSON.stringify({ selected: 'bmg' }))
    preferencesApi.migrate.mockImplementation(async () => ({
      success: false as const,
      error: 'bad section',
    }))
    const { prefs, selected } = makeHarness('theme')
    await prefs.init()
    expect(selected.value).toBe('bmg')
    expect(storage.data.has('theme')).toBe(true)
    expect(errorsReport).toHaveBeenCalledTimes(1)
    expect(errorsReport.mock.calls[0][1]).toMatchObject({ code: 'preferences/migrate-failed' })
  })

  it('reports a thrown migrate after a successful read and keeps the leftover key', async () => {
    storage.data.set('theme', JSON.stringify({ selected: 'bmg' }))
    preferencesApi.migrate.mockImplementation(async () => {
      throw new Error('no handler')
    })
    const { prefs, selected } = makeHarness('theme')
    await prefs.init()
    expect(selected.value).toBe('bmg')
    expect(storage.data.has('theme')).toBe(true)
    expect(errorsReport).toHaveBeenCalledTimes(1)
    expect(errorsReport.mock.calls[0][1]).toMatchObject({ code: 'preferences/migrate-failed' })
  })

  it('boots defaults and does not touch the leftover key when the read fails', async () => {
    storage.data.set('theme', JSON.stringify({ selected: 'bmg' }))
    preferencesApi.read.mockImplementation(async () => {
      throw new Error('no answer')
    })
    const { prefs, selected } = makeHarness('theme')
    await prefs.init()
    expect(selected.value).toBeNull()
    expect(preferencesApi.migrate).not.toHaveBeenCalled()
    expect(storage.data.has('theme')).toBe(true)
    expect(errorsReport).toHaveBeenCalledTimes(1)
    expect(errorsReport.mock.calls[0][1]).toMatchObject({ code: 'preferences/read-failed' })
  })

  it('drops a legacy key that holds no payload worth keeping', async () => {
    storage.data.set('theme', JSON.stringify({ otherStoreField: true }))
    const { prefs } = makeHarness('theme')
    await prefs.init()
    expect(preferencesApi.migrate).not.toHaveBeenCalled()
    expect(storage.data.has('theme')).toBe(false)
  })

  it('writes a changed section through, once', async () => {
    const { prefs, selected } = makeHarness()
    await prefs.init()
    selected.value = 'dark'
    await advanceFlush()
    expect(preferencesApi.write).toHaveBeenCalledTimes(1)
    expect(preferencesApi.write.mock.calls[0]).toEqual([
      'theme',
      { selected: 'dark', enabled: false, config: { enabled: false, apiKey: '' } },
    ])
    // No further change: the next flush is a no-op. (A fresh object, as a
    // real settings form would deliver — Vue does not trigger on re-setting
    // the identical reference.)
    selected.value = 'dark'
    await advanceFlush()
    expect(preferencesApi.write).toHaveBeenCalledTimes(1)
  })

  it('sees a deep mutation inside an object ref', async () => {
    const { prefs, config } = makeHarness()
    await prefs.init()
    config.value.enabled = true
    await advanceFlush()
    expect(preferencesApi.write).toHaveBeenCalledTimes(1)
    const written = preferencesApi.write.mock.calls[0][1] as { config: { enabled: boolean } }
    expect(written.config.enabled).toBe(true)
  })

  it('sends a structured-cloneable payload, not the live Vue proxy', async () => {
    preferencesApi.write.mockImplementation(async (_section, value) => {
      structuredClone(value)
      return { success: true as const }
    })
    const { prefs, config } = makeHarness()
    await prefs.init()
    config.value.enabled = true
    await advanceFlush()
    expect(preferencesApi.write).toHaveBeenCalledTimes(1)
    const written = preferencesApi.write.mock.calls[0][1] as { config: { enabled: boolean } }
    expect(written.config.enabled).toBe(true)
    expect(written.config).not.toBe(config.value)
  })

  it('reports a thrown write instead of leaving an unhandled rejection', async () => {
    const { prefs, selected } = makeHarness()
    await prefs.init()
    preferencesApi.write.mockImplementationOnce(async () => {
      throw new Error('An object could not be cloned.')
    })
    selected.value = 'dark'
    await advanceFlush()
    expect(errorsReport).toHaveBeenCalledTimes(1)
    expect(errorsReport.mock.calls[0][1]).toMatchObject({ code: 'preferences/write-failed' })
  })

  it('retries after a rejected write on the next change', async () => {
    const { prefs, selected } = makeHarness()
    await prefs.init()
    preferencesApi.write.mockImplementationOnce(async () => ({
      success: false as const,
      error: 'disk full',
    }))
    selected.value = 'dark'
    await advanceFlush()
    expect(errorsReport).toHaveBeenCalledTimes(1)
    expect(errorsReport.mock.calls[0][1]).toMatchObject({ code: 'preferences/write-failed' })
    selected.value = 'bmg'
    await advanceFlush()
    expect(preferencesApi.write).toHaveBeenCalledTimes(2)
    expect(preferencesApi.write.mock.calls[1][1]).toMatchObject({ selected: 'bmg' })
  })

  it('drops the legacy key after a successful write-through (the rescue path)', async () => {
    storage.data.set('theme', JSON.stringify({ selected: 'bmg' }))
    preferencesApi.migrate.mockImplementation(async () => ({
      success: false as const,
      error: 'refused',
    }))
    const { prefs, selected } = makeHarness('theme')
    await prefs.init()
    expect(storage.data.has('theme')).toBe(true)
    selected.value = 'dark'
    await advanceFlush()
    expect(preferencesApi.write).toHaveBeenCalledTimes(1)
    expect(storage.data.has('theme')).toBe(false)
  })

  it('flushes immediately on beforeunload so a quit does not drop the debounce window', async () => {
    const { prefs, selected } = makeHarness()
    await prefs.init()
    selected.value = 'dark'
    expect(preferencesApi.write).not.toHaveBeenCalled()
    for (const handler of windowListeners.beforeunload ?? []) handler()
    await vi.advanceTimersByTimeAsync(0)
    expect(preferencesApi.write).toHaveBeenCalledTimes(1)
  })

  it('stops watching after dispose', async () => {
    const { prefs, selected } = makeHarness()
    await prefs.init()
    prefs.dispose()
    selected.value = 'dark'
    await advanceFlush()
    for (const handler of windowListeners.beforeunload ?? []) handler()
    expect(preferencesApi.write).not.toHaveBeenCalled()
  })

  it('is init-idempotent', async () => {
    const { prefs } = makeHarness()
    await Promise.all([prefs.init(), prefs.init()])
    expect(preferencesApi.read).toHaveBeenCalledTimes(1)
  })

  it('slims only its own keys out of a shared legacy key', async () => {
    storage.data.set(
      'theme',
      JSON.stringify({ selected: 'bmg', enabled: true, someoneElsesField: { a: 1 } }),
    )
    const selected = ref<string | null>(null)
    const enabled = ref(false)
    const prefs = makeFileBackedPreference({
      section: 'theme',
      refs: { selected, enabled },
      legacyKey: 'theme',
      legacySlim: true,
    })
    await prefs.init()
    expect(preferencesApi.migrate).toHaveBeenCalledTimes(1)
    expect(selected.value).toBe('bmg')
    const key = JSON.parse(storage.data.get('theme') ?? '{}') as Record<string, unknown>
    expect(key).toEqual({ someoneElsesField: { a: 1 } })
  })

  it('drops the legacy key in slim mode when it runs empty', async () => {
    storage.data.set('theme', JSON.stringify({ selected: 'bmg', enabled: true }))
    const selected = ref<string | null>(null)
    const enabled = ref(false)
    const prefs = makeFileBackedPreference({
      section: 'theme',
      refs: { selected, enabled },
      legacyKey: 'theme',
      legacySlim: true,
    })
    await prefs.init()
    expect(storage.data.has('theme')).toBe(false)
  })

  it('leaves a slim-mode key alone when it holds none of its fields', async () => {
    storage.data.set('theme', JSON.stringify({ someoneElsesField: true }))
    const selected = ref<string | null>(null)
    const prefs = makeFileBackedPreference({
      section: 'theme',
      refs: { selected },
      legacyKey: 'theme',
      legacySlim: true,
    })
    await prefs.init()
    expect(preferencesApi.migrate).not.toHaveBeenCalled()
    expect(storage.data.has('theme')).toBe(true)
    expect(JSON.parse(storage.data.get('theme') ?? '{}')).toEqual({ someoneElsesField: true })
  })

  it('slims its keys out after a successful write-through (the rescue path)', async () => {
    storage.data.set('theme', JSON.stringify({ selected: 'bmg', someoneElsesField: { a: 1 } }))
    preferencesApi.migrate.mockImplementation(async () => ({
      success: false as const,
      error: 'refused',
    }))
    const selected = ref<string | null>(null)
    const prefs = makeFileBackedPreference({
      section: 'theme',
      refs: { selected },
      legacyKey: 'theme',
      legacySlim: true,
    })
    await prefs.init()
    selected.value = 'dark'
    await advanceFlush()
    expect(preferencesApi.write).toHaveBeenCalledTimes(1)
    const key = JSON.parse(storage.data.get('theme') ?? '{}') as Record<string, unknown>
    expect(key).toEqual({ someoneElsesField: { a: 1 } })
  })

  it('writes the toFile transform and diffs against it', async () => {
    const mask = ref<Record<string, unknown>>({})
    const prefs = makeFileBackedPreference({
      section: 'theme',
      refs: { mask },
      legacyKey: undefined,
      toFile: (section) => ({
        mask: Object.fromEntries(
          Object.entries(section.mask as Record<string, unknown>).filter(
            ([, value]) => !(typeof value === 'string' && value.startsWith('data:image/')),
          ),
        ),
      }),
    })
    await prefs.init()
    mask.value = { keep: 'x', scrub: 'data:image/png;base64,AAAA' }
    await advanceFlush()
    expect(preferencesApi.write).toHaveBeenCalledTimes(1)
    expect(preferencesApi.write.mock.calls[0][1]).toEqual({ mask: { keep: 'x' } })
    // A change confined to the scrubbed field never reaches the file.
    mask.value.scrub = 'data:image/png;base64,BBBB'
    await advanceFlush()
    expect(preferencesApi.write).toHaveBeenCalledTimes(1)
  })

  it('fills leftover keys the file section does not yet hold, without overlaying present keys', async () => {
    storage.data.set(
      'theme',
      JSON.stringify({ selected: 'stale', enabled: true, someoneElsesField: { a: 1 } }),
    )
    preferencesApi.read.mockImplementation(async () => ({
      success: true as const,
      sections: { theme: { selected: 'file', config: { enabled: true, apiKey: 'k' } } },
    }))
    const { prefs, selected, enabled, config } = makeHarness('theme')
    // Pinia persist of the remaining pick can drop the new field from the blob
    // before init; the construction snapshot is what we fill from.
    storage.data.set('theme', JSON.stringify({ someoneElsesField: { a: 1 } }))
    await prefs.init()
    expect(selected.value).toBe('file')
    expect(enabled.value).toBe(true)
    expect(config.value).toEqual({ enabled: true, apiKey: 'k' })
    expect(preferencesApi.migrate).not.toHaveBeenCalled()
    await advanceFlush()
    expect(preferencesApi.write).toHaveBeenCalledTimes(1)
    expect(preferencesApi.write.mock.calls[0]).toEqual([
      'theme',
      { selected: 'file', enabled: true, config: { enabled: true, apiKey: 'k' } },
    ])
  })

  it('migrates a leftover captured at construction even if the key is rewritten before init', async () => {
    storage.data.set(
      'theme',
      JSON.stringify({ selected: 'bmg', enabled: true, someoneElsesField: { a: 1 } }),
    )
    const selected = ref<string | null>(null)
    const enabled = ref(false)
    const prefs = makeFileBackedPreference({
      section: 'theme',
      refs: { selected, enabled },
      legacyKey: 'theme',
      legacySlim: true,
    })
    // Pinia persist of the remaining pick replaces the whole key.
    storage.data.set('theme', JSON.stringify({ someoneElsesField: { a: 1 } }))
    await prefs.init()
    expect(preferencesApi.migrate).toHaveBeenCalledTimes(1)
    expect(preferencesApi.migrate.mock.calls[0]).toEqual([
      'theme',
      { selected: 'bmg', enabled: true },
    ])
    expect(selected.value).toBe('bmg')
    expect(JSON.parse(storage.data.get('theme') ?? '{}')).toEqual({ someoneElsesField: { a: 1 } })
  })

  it('scrubs the migrate payload with toFile and still hydrates the leftover as stored', async () => {
    const leftover = { mask: { keep: 'x', scrub: 'data:image/png;base64,AAAA' } }
    storage.data.set('theme', JSON.stringify(leftover))
    const mask = ref<Record<string, unknown>>({})
    const prefs = makeFileBackedPreference({
      section: 'theme',
      refs: { mask },
      legacyKey: 'theme',
      toFile: (section) => ({
        mask: Object.fromEntries(
          Object.entries(section.mask as Record<string, unknown>).filter(
            ([, value]) => !(typeof value === 'string' && value.startsWith('data:image/')),
          ),
        ),
      }),
    })
    await prefs.init()
    expect(mask.value).toEqual(leftover.mask)
    expect(preferencesApi.migrate.mock.calls[0][1]).toEqual({ mask: { keep: 'x' } })
  })

  it('routes through an injected api instead of the preferences channels', async () => {
    const injected = {
      read: vi.fn(
        async (): Promise<
          { success: true; sections: Record<string, unknown> } | { success: false; error: string }
        > => ({ success: true, sections: { machine: { flag: true } } }),
      ),
      migrate: vi.fn(
        async (
          _section: string,
          _payload: unknown,
        ): Promise<{ success: true } | { success: false; error: string }> => ({ success: true }),
      ),
      write: vi.fn(
        async (
          _section: string,
          _value: unknown,
        ): Promise<{ success: true } | { success: false; error: string }> => ({ success: true }),
      ),
    }
    const flag = ref(false)
    const prefs = makeFileBackedPreference({
      section: 'machine',
      refs: { flag },
      api: injected,
    })
    await prefs.init()
    expect(injected.read).toHaveBeenCalledTimes(1)
    expect(flag.value).toBe(true)
    expect(preferencesApi.read).not.toHaveBeenCalled()
    flag.value = false
    await advanceFlush()
    expect(injected.write).toHaveBeenCalledWith('machine', { flag: false })
    expect(preferencesApi.write).not.toHaveBeenCalled()
  })

  it('scopes the reported error codes to the injected store', async () => {
    const injected = {
      read: vi.fn(
        async (): Promise<
          { success: true; sections: Record<string, unknown> } | { success: false; error: string }
        > => ({ success: false, error: 'unreadable' }),
      ),
      migrate: vi.fn(
        async (
          _section: string,
          _payload: unknown,
        ): Promise<{ success: true } | { success: false; error: string }> => ({ success: true }),
      ),
      write: vi.fn(
        async (
          _section: string,
          _value: unknown,
        ): Promise<{ success: true } | { success: false; error: string }> => ({ success: true }),
      ),
    }
    const prefs = makeFileBackedPreference({
      section: 'machine',
      refs: { flag: ref(false) },
      api: injected,
      errorScope: 'backend-launch-settings',
    })
    await prefs.init()
    expect(errorsReport).toHaveBeenCalledTimes(1)
    expect(errorsReport.mock.calls[0][1]).toMatchObject({
      code: 'backend-launch-settings/read-failed',
    })
  })

  it('re-reads after a successful alwaysMigrateLegacy upload so leftover cannot overlay the file', async () => {
    storage.data.set('machine', JSON.stringify({ flag: true }))
    let fileFlag = false
    const injected = {
      read: vi.fn(
        async (): Promise<
          { success: true; sections: Record<string, unknown> } | { success: false; error: string }
        > => ({ success: true, sections: { machine: { flag: fileFlag } } }),
      ),
      migrate: vi.fn(
        async (
          _section: string,
          payload: unknown,
        ): Promise<{ success: true } | { success: false; error: string }> => {
          fileFlag = (payload as { flag: boolean }).flag
          return { success: true }
        },
      ),
      write: vi.fn(
        async (
          _section: string,
          _value: unknown,
        ): Promise<{ success: true } | { success: false; error: string }> => ({ success: true }),
      ),
    }
    const flag = ref(false)
    const prefs = makeFileBackedPreference({
      section: 'machine',
      refs: { flag },
      legacyKey: 'machine',
      alwaysMigrateLegacy: true,
      api: injected,
    })
    await prefs.init()
    expect(injected.migrate).toHaveBeenCalledWith('machine', { flag: true })
    expect(injected.read).toHaveBeenCalledTimes(2)
    expect(flag.value).toBe(true)
    expect(storage.data.has('machine')).toBe(false)
  })

  it('keeps a present alwaysMigrateLegacy section when leftover differs', async () => {
    storage.data.set('machine', JSON.stringify({ flag: false }))
    const injected = {
      read: vi.fn(
        async (): Promise<
          { success: true; sections: Record<string, unknown> } | { success: false; error: string }
        > => ({ success: true, sections: { machine: { flag: true } } }),
      ),
      migrate: vi.fn(
        async (
          _section: string,
          _payload: unknown,
        ): Promise<{ success: true } | { success: false; error: string }> => ({ success: true }),
      ),
      write: vi.fn(
        async (
          _section: string,
          _value: unknown,
        ): Promise<{ success: true } | { success: false; error: string }> => ({ success: true }),
      ),
    }
    const flag = ref(false)
    const prefs = makeFileBackedPreference({
      section: 'machine',
      refs: { flag },
      legacyKey: 'machine',
      alwaysMigrateLegacy: true,
      api: injected,
    })
    await prefs.init()
    expect(flag.value).toBe(true)
    expect(injected.migrate).toHaveBeenCalledWith('machine', { flag: false })
    expect(injected.read).toHaveBeenCalledTimes(2)
    expect(storage.data.has('machine')).toBe(false)
  })

  it('does not overlay leftover over a present alwaysMigrateLegacy section when upload is refused', async () => {
    storage.data.set('machine', JSON.stringify({ flag: true }))
    const injected = {
      read: vi.fn(
        async (): Promise<
          { success: true; sections: Record<string, unknown> } | { success: false; error: string }
        > => ({ success: true, sections: { machine: { flag: false } } }),
      ),
      migrate: vi.fn(
        async (
          _section: string,
          _payload: unknown,
        ): Promise<{ success: true } | { success: false; error: string }> => ({
          success: false,
          error: 'refused',
        }),
      ),
      write: vi.fn(
        async (
          _section: string,
          _value: unknown,
        ): Promise<{ success: true } | { success: false; error: string }> => ({ success: true }),
      ),
    }
    const flag = ref(false)
    const prefs = makeFileBackedPreference({
      section: 'machine',
      refs: { flag },
      legacyKey: 'machine',
      alwaysMigrateLegacy: true,
      api: injected,
    })
    await prefs.init()
    expect(flag.value).toBe(false)
    expect(storage.data.has('machine')).toBe(true)
    flag.value = true
    await advanceFlush()
    expect(injected.write).toHaveBeenCalledTimes(1)
    expect(storage.data.has('machine')).toBe(true)
  })

  it('overlays leftover in memory for a demo session after alwaysMigrateLegacy upload', async () => {
    ;(window as unknown as { __AIPG_DEMO_MODE__: boolean }).__AIPG_DEMO_MODE__ = true
    storage.data.set('machine', JSON.stringify({ flag: true }))
    const injected = {
      read: vi.fn(
        async (): Promise<
          { success: true; sections: Record<string, unknown> } | { success: false; error: string }
        > => ({ success: true, sections: { machine: { flag: false } } }),
      ),
      migrate: vi.fn(
        async (
          _section: string,
          _payload: unknown,
        ): Promise<{ success: true } | { success: false; error: string }> => ({ success: true }),
      ),
      write: vi.fn(
        async (
          _section: string,
          _value: unknown,
        ): Promise<{ success: true } | { success: false; error: string }> => ({ success: true }),
      ),
    }
    const flag = ref(false)
    const prefs = makeFileBackedPreference({
      section: 'machine',
      refs: { flag },
      legacyKey: 'machine',
      alwaysMigrateLegacy: true,
      api: injected,
    })
    await prefs.init()
    expect(flag.value).toBe(true)
    expect(injected.read).toHaveBeenCalledTimes(1)
    expect(storage.data.has('machine')).toBe(false)
  })
})
