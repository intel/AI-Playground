import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, getActivePinia, setActivePinia, type Pinia } from 'pinia'

// Session Settings for every preset (ADR-0004), driven through the Session Settings
// store against the real Session module in a temp dir. The chat and ComfyUI settings
// stores are stand-ins honouring the binding contracts the real stores implement.

type Bag = Record<string, unknown>

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getSessionsDemoDir: () => dirs.demo,
}))
vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/assets/js/toast', () => ({
  show: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}))
vi.mock('@/assets/js/store/conversations', () => ({ HOME_AGENT_CHAT_PRESET_NAME: 'Home Agent' }))

const fakes = await vi.hoisted(async () => {
  const { reactive } = await import('vue')
  type Preset = { type: 'chat' | 'comfy'; name: string; variants?: { name: string }[] }
  const catalog: Preset[] = [
    { type: 'comfy', name: 'Fast Image', variants: [{ name: 'Fast' }, { name: 'Quality' }] },
    { type: 'chat', name: 'Chat' },
    { type: 'chat', name: 'Home Agent' },
  ]
  const presets = reactive({
    presets: catalog,
    activePresetName: null as string | null,
    activeVariantName: {} as Record<string, string>,
  })
  const keyOf = (name: string) => {
    const variant = presets.activeVariantName[name]
    return variant ? `${name}:${variant}` : name
  }

  type ChatBinding = {
    applies: (preset: Preset) => boolean
    load: (d: Bag, e: string) => Bag | null
    save: (b: Bag, e: string, fromLoad?: boolean) => void
    pinned: () => boolean
    loaded: (b: Bag, e: string) => void
  }
  const chat = {
    binding: null as ChatBinding | null,
    settingsPerPreset: {} as Record<string, Bag>,
    live: {} as Bag,
    settingsAvailability: {
      models: [
        { name: 'Qwen3-9B', type: 'llamaCPP' },
        { name: 'Fallback', type: 'llamaCPP' },
      ],
      embeddingModels: [],
      services: [{ backend: 'llamaCPP', isSetUp: true, devices: [] }],
      cloudEnabled: false,
      cloudProviderIds: [],
      embeddingBackend: 'llamaCPP',
    },
    bindPresetSessionSettings(binding: ChatBinding) {
      chat.binding = binding
    },
    activeBinding() {
      const preset = catalog.find((p) => p.name === presets.activePresetName)!
      return chat.binding?.applies(preset) ? chat.binding : null
    },
    loadSettingsForActivePreset() {
      const key = keyOf(presets.activePresetName!)
      const defaults = chat.settingsPerPreset[key] ?? {}
      const binding = chat.activeBinding()
      const inSession = binding?.load(defaults, 'llamaCPP') ?? null
      const pinned = inSession !== null && binding!.pinned()
      const saved = { ...(inSession ?? defaults) }
      const models = saved.selectedModels as Record<string, string> | undefined
      const model = models?.llamaCPP
      if (!pinned && model && !chat.settingsAvailability.models.some((m) => m.name === model)) {
        saved.selectedModels = { llamaCPP: 'Fallback' }
      }
      chat.live = saved
      if (binding && (!inSession || !pinned)) binding.save({ ...chat.live }, 'llamaCPP', true)
      if (pinned) binding!.loaded({ ...chat.live }, 'llamaCPP')
    },
    set(key: string, value: unknown) {
      chat.live = { ...chat.live, [key]: value }
      const binding = chat.activeBinding()
      if (binding) binding.save({ ...chat.live }, 'llamaCPP')
      else chat.settingsPerPreset[keyOf(presets.activePresetName!)] = { ...chat.live }
    },
  }

  type ComfyValues = { settings: Bag; inputs: Bag }
  type ComfyBinding = {
    use: (key: string, defaults: ComfyValues) => ComfyValues | null
    peek: (key: string) => ComfyValues | null
    write: (key: string, values: ComfyValues) => void
  }
  const comfy = {
    binding: null as ComfyBinding | null,
    settingsPerPreset: {} as Record<string, Bag>,
    comfyInputsPerPreset: {} as Record<string, Bag>,
    seed: -1,
    bindSessionSettings(binding: ComfyBinding) {
      comfy.binding = binding
    },
    loadSettingsForActivePreset() {
      const key = keyOf(presets.activePresetName!)
      comfy.binding?.use(key, {
        settings: { ...comfy.settingsPerPreset[key] },
        inputs: { ...comfy.comfyInputsPerPreset[key] },
      })
      const saved = comfy.binding?.peek(key)?.settings ?? comfy.settingsPerPreset[key]
      comfy.seed = (saved?.seed as number | undefined) ?? -1
    },
    setSeed(seed: number) {
      comfy.seed = seed
      const key = keyOf(presets.activePresetName!)
      const inSession = comfy.binding?.peek(key)
      if (inSession) comfy.binding!.write(key, { ...inSession, settings: { seed } })
      else comfy.settingsPerPreset[key] = { seed }
    },
  }

  let sessionVariant: ((name: string) => string | undefined) | null = null
  const switching = {
    bindSessionVariant(resolver: typeof sessionVariant) {
      sessionVariant = resolver
    },
    async switchPreset(name: string, options: { variant?: string } = {}) {
      presets.activePresetName = name
      const preset = catalog.find((p) => p.name === name)!
      const variant = options.variant ?? sessionVariant?.(name)
      if (variant) presets.activeVariantName[name] = variant
      else if (preset.variants && !presets.activeVariantName[name]) {
        presets.activeVariantName[name] = preset.variants[0].name
      }
      if (preset.type === 'chat') chat.loadSettingsForActivePreset()
      else comfy.loadSettingsForActivePreset()
      return { success: true }
    },
    switchVariant(variant: string) {
      return switching.switchPreset(presets.activePresetName!, { variant })
    },
  }
  return { presets, chat, comfy, switching }
})

vi.mock('@/assets/js/store/presets', () => ({ usePresets: () => fakes.presets }))
vi.mock('@/assets/js/store/textInference', () => ({ useTextInference: () => fakes.chat }))
vi.mock('@/assets/js/store/imageGenerationPresets', () => ({
  useImageGenerationPresets: () => fakes.comfy,
  presetSettingsKey: (name: string, variant?: string | null) =>
    variant ? `${name}:${variant}` : name,
}))
vi.mock('@/assets/js/store/presetSwitching', () => ({ usePresetSwitching: () => fakes.switching }))

type AgentPort = {
  read: (preset: string) => { settings: Record<string, unknown>; sent: boolean } | undefined
  write: (preset: string, settings: Record<string, unknown>, sent: boolean) => void
  drop: (preset: string) => void
  readStored: (sessionId: string, preset: string) => Promise<Record<string, unknown> | null>
}
const agent = vi.hoisted(() => ({ port: null as unknown }))
vi.mock('@/assets/js/store/agentMode', () => ({
  useAgentMode: () => ({
    bindSessionSettingsPort: (port: unknown) => {
      agent.port = port
    },
  }),
}))
const agentPort = () => agent.port as AgentPort

const sessionModule = await import('../../session/sessions')
const settingsModule = await import('../../session/sessionSettings')
const { useSessions } = await import('@/assets/js/store/sessions')
const { useSessionSettings } = await import('@/assets/js/store/sessionSettings')

/** Lets queued Session writes and reads reach the disk. */
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 30))

function ok<T extends object>(run: () => Promise<T>) {
  return async () => ({ success: true as const, ...(await run()) })
}

async function onDisk(sessionId: string): Promise<Record<string, unknown>> {
  const file = path.join(dirs.real, sessionId, 'session.json')
  return JSON.parse(await fs.readFile(file, 'utf8')).settings
}

async function setUp() {
  const sessions = useSessions()
  await sessions.init()
  const store = useSessionSettings()
  await store.whenLoaded()
  return { sessions, store }
}

async function openSession(sessions: ReturnType<typeof useSessions>, id: string | null) {
  if (id) await sessions.open(id)
  else await sessions.create()
  await useSessionSettings().whenLoaded()
  await flushPromises()
}

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-settings-store-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  sessionModule.setSessionDeps({ isDemoMode: () => false })
  vi.stubGlobal('window', {
    electronAPI: {
      sessions: {
        list: ok(async () => ({ sessions: await sessionModule.listSessions() })),
        create: ok(async () => ({ session: await sessionModule.createSession() })),
        open: (id: string) => ok(async () => ({ session: await sessionModule.openSession(id) }))(),
        rename: vi.fn(),
        delete: vi.fn(),
        readSettings: (id: string) =>
          ok(async () => ({ settings: await settingsModule.readSessionSettings(id) }))(),
        writePresetSettings: (id: string, name: string, entry: never) =>
          ok(async () => settingsModule.writePresetSettings(id, name, entry).then(() => ({})))(),
      },
    },
  })
  fakes.presets.activePresetName = 'Fast Image'
  fakes.presets.activeVariantName = { 'Fast Image': 'Fast' }
  fakes.chat.settingsPerPreset = { Chat: { selectedModels: { llamaCPP: 'Qwen3-9B' } } }
  fakes.comfy.settingsPerPreset = { 'Fast Image:Fast': { seed: 42 } }
  fakes.comfy.comfyInputsPerPreset = {}
  setActivePinia(createPinia())
})

afterEach(async () => {
  await flushPromises()
  const pinia = getActivePinia() as
    (Pinia & { _s: Map<string, { $dispose: () => void }> }) | undefined
  pinia?._s.forEach((store) => store.$dispose())
  vi.unstubAllGlobals()
  sessionModule.resetSessionsForTest()
  await fs.rm(path.dirname(dirs.real), { recursive: true, force: true })
})

describe('Session Settings for every preset', () => {
  it('copies the Default Settings the first time a preset runs in a Session', async () => {
    const { sessions } = await setUp()
    await flushPromises()

    expect(fakes.comfy.seed).toBe(42)
    expect(await onDisk(sessions.openSessionId!)).toEqual({
      'Fast Image': {
        variant: 'Fast',
        bags: {
          'Fast Image:Fast': { values: { settings: { seed: 42 }, inputs: {} }, fromDefaults: true },
        },
      },
    })
  })

  it('keeps the seed across Image Gen → Chat → Image Gen and leaves the defaults alone', async () => {
    await setUp()
    fakes.comfy.setSeed(7)
    await fakes.switching.switchPreset('Chat')
    await fakes.switching.switchPreset('Fast Image')

    expect(fakes.comfy.seed).toBe(7)
    expect(fakes.comfy.settingsPerPreset['Fast Image:Fast']).toEqual({ seed: 42 })
  })

  it('isolates Sessions from each other, variant included', async () => {
    const { sessions } = await setUp()
    const first = sessions.openSessionId!
    fakes.comfy.setSeed(7)
    await fakes.switching.switchVariant('Quality')
    fakes.comfy.setSeed(8)

    await openSession(sessions, null)
    expect(fakes.presets.activeVariantName['Fast Image']).toBe('Quality')
    await fakes.switching.switchVariant('Fast')
    expect(fakes.comfy.seed).toBe(42)

    await openSession(sessions, first)
    expect(fakes.presets.activeVariantName['Fast Image']).toBe('Quality')
    expect(fakes.comfy.seed).toBe(8)
  })

  it('gives later Sessions what was saved as default, and resets to it', async () => {
    const { sessions, store } = await setUp()
    fakes.comfy.setSeed(7)
    expect(store.saveAsDefault()).toBe(true)
    expect(fakes.comfy.settingsPerPreset['Fast Image:Fast']).toEqual({ seed: 7 })

    await openSession(sessions, null)
    expect(fakes.comfy.seed).toBe(7)

    fakes.comfy.setSeed(9)
    store.resetToDefault()
    expect(fakes.comfy.seed).toBe(7)
    await flushPromises()
    const bag = (await onDisk(sessions.openSessionId!))['Fast Image'] as {
      bags: Record<string, unknown>
    }
    expect(bag.bags['Fast Image:Fast']).toEqual({
      values: { settings: { seed: 7 }, inputs: {} },
      fromDefaults: true,
    })
  })

  it('repairs unusable defaults silently and never blocks on them', async () => {
    fakes.chat.settingsPerPreset = { Chat: { selectedModels: { llamaCPP: 'Removed' } } }
    const { store } = await setUp()
    await fakes.switching.switchPreset('Chat')

    expect(fakes.chat.live.selectedModels).toEqual({ llamaCPP: 'Fallback' })
    expect(store.problems).toEqual([])
  })

  it("blocks sending on a Session's own settings once they became unusable", async () => {
    const { sessions, store } = await setUp()
    await fakes.switching.switchPreset('Chat')
    fakes.chat.set('backend', 'llamaCPP')
    store.markSent()
    await flushPromises()
    const id = sessions.openSessionId!

    fakes.chat.settingsAvailability.models = [{ name: 'Fallback', type: 'llamaCPP' }]
    await openSession(sessions, null)
    await openSession(sessions, id)

    expect(fakes.chat.live.selectedModels).toEqual({ llamaCPP: 'Qwen3-9B' })
    expect(store.problems).toEqual([{ field: 'model', value: 'Qwen3-9B' }])
    fakes.chat.settingsAvailability.models.push({ name: 'Qwen3-9B', type: 'llamaCPP' })
  })

  it('keeps the Home Agent preset on its global settings', async () => {
    const { sessions } = await setUp()
    await fakes.switching.switchPreset('Home Agent')
    fakes.chat.set('temperature', 0.1)
    await flushPromises()

    expect(fakes.chat.settingsPerPreset['Home Agent']).toEqual({ temperature: 0.1 })
    expect(await onDisk(sessions.openSessionId!)).not.toHaveProperty('Home Agent')
  })

  it("keeps the Agent preset's Session Settings in session.json like every other preset's", async () => {
    const { sessions } = await setUp()
    const first = sessions.openSessionId!
    const settings = { capabilities: ['files', 'shell'], planningThinkingOnly: false }

    agentPort().write('Agent', settings, false)
    await flushPromises()
    expect((await onDisk(first)).Agent).toEqual({
      bags: { Agent: { values: settings, fromDefaults: true } },
    })

    agentPort().write('Agent', settings, true)
    await flushPromises()
    expect(agentPort().read('Agent')).toEqual({ settings, sent: true })

    await openSession(sessions, null)
    expect(agentPort().read('Agent')).toBeUndefined()
    expect(await agentPort().readStored(first, 'Agent')).toEqual(settings)

    await openSession(sessions, first)
    agentPort().drop('Agent')
    await flushPromises()
    expect((await onDisk(first)).Agent).toEqual({ bags: {} })
  })
})
