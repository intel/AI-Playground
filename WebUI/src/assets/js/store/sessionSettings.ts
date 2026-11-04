import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useErrors } from '@/assets/js/store/errors'
import { useSessions } from '@/assets/js/store/sessions'
import { usePresets, type ChatPreset, type Preset } from '@/assets/js/store/presets'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import { useTextInference } from '@/assets/js/store/textInference'
import {
  presetSettingsKey,
  useImageGenerationPresets,
} from '@/assets/js/store/imageGenerationPresets'
import { HOME_AGENT_CHAT_PRESET_NAME } from '@/assets/js/store/conversations'
import { usesSessionSettings, type SettingsBag } from '@/lib/agentSessionSettings'
import {
  asSent,
  blockingProblems,
  chatBagProblems,
  keepUneditedValues,
  variantProblems,
  withBag,
  withoutBag,
  withVariant,
} from '@/lib/sessionSettings'
import type { SessionSettingsProblem } from '@/lib/sessionSettingsProblems'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type {
  PresetSessionSettings,
  SessionSettingsBag,
  SessionSettingsMap,
} from '@/types/sessionSettings'

/** Settings are JSON on disk; this also unwraps the reactive proxies `structuredClone` rejects. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type ComfyValues = { settings: Record<string, unknown>; inputs: Record<string, unknown> }

/**
 * Session Settings for every preset (ADR-0004): binds the chat and ComfyUI settings
 * stores to the open Session, so a preset's first use in a Session copies its Default
 * Settings and coming back to it restores what the Session last used. The Agent
 * preset's settings are bound by the agent store but kept here too; the Home Agent
 * preset, machine-level settings and the TTS voice stay global.
 */
export const useSessionSettings = defineStore('sessionSettings', () => {
  const errors = useErrors()
  const sessions = useSessions()
  const presets = usePresets()
  const presetSwitching = usePresetSwitching()
  const textInference = useTextInference()
  const imageGeneration = useImageGenerationPresets()
  const agentMode = useAgentMode()

  const settings = ref<SessionSettingsMap>({})
  /** The Session `settings` were read for; null while they are being read. */
  const loadedSessionId = ref<string | null>(null)
  const loading = ref<Promise<void>>(Promise.resolve())
  const ready = computed(
    () => loadedSessionId.value !== null && loadedSessionId.value === sessions.openSessionId,
  )

  function presetNamed(name: string | null | undefined): Preset | undefined {
    return name ? presets.presets.find((preset) => preset.name === name) : undefined
  }

  const activePreset = computed(() => presetNamed(presets.activePresetName))

  /** Presets whose settings this store keeps per Session. */
  function heldHere(preset: Preset | undefined): preset is Preset {
    if (!preset || preset.name === HOME_AGENT_CHAT_PRESET_NAME) return false
    return !(preset.type === 'chat' && usesSessionSettings(preset as ChatPreset))
  }

  function variantNames(preset: Preset): string[] {
    return (preset.variants ?? []).map((variant) => variant.name)
  }

  /** The settings key the owning store uses: comfy falls back to the first variant. */
  function settingsKeyOf(preset: Preset): string {
    const variant =
      presets.activeVariantName[preset.name] ??
      (preset.type === 'comfy' ? variantNames(preset)[0] : undefined)
    return presetSettingsKey(preset.name, variant)
  }

  function bagOf(presetName: string, settingsKey: string): SessionSettingsBag | undefined {
    return settings.value[presetName]?.bags[settingsKey]
  }

  const pendingWrites = new Set<string>()

  function update(presetName: string, entry: PresetSessionSettings): void {
    settings.value = { ...settings.value, [presetName]: entry }
    const sessionId = loadedSessionId.value
    if (!sessionId) return
    const writeKey = JSON.stringify([sessionId, presetName])
    if (pendingWrites.has(writeKey)) return
    pendingWrites.add(writeKey)
    queueMicrotask(() => {
      pendingWrites.delete(writeKey)
      void write(sessionId, presetName)
    })
  }

  async function write(sessionId: string, presetName: string): Promise<void> {
    if (loadedSessionId.value !== sessionId) return
    const entry = settings.value[presetName]
    if (!entry) return
    try {
      const result = await window.electronAPI.sessions.writePresetSettings(
        sessionId,
        presetName,
        clone(entry),
      )
      if (!result.success) throw new Error(result.error)
    } catch (error) {
      errors.report(error, {
        code: 'sessions/settings-write-failed',
        category: 'backend',
        surface: 'toast',
      })
    }
  }

  function setBag(presetName: string, settingsKey: string, bag: SessionSettingsBag): void {
    update(presetName, withBag(settings.value[presetName], settingsKey, bag))
  }

  /** Live chat values right after a sent bag loaded; values still equal to them were not edited. */
  let baseline: { key: string; values: SettingsBag; edited: Set<string> } | null = null

  function activeChat(): { name: string; key: string } | null {
    const preset = activePreset.value
    if (!ready.value || !heldHere(preset) || preset.type !== 'chat') return null
    return { name: preset.name, key: settingsKeyOf(preset) }
  }

  textInference.bindPresetSessionSettings({
    applies: (preset) => ready.value && heldHere(preset),
    load: () => {
      const chat = activeChat()
      const bag = chat ? bagOf(chat.name, chat.key) : undefined
      baseline = null
      return bag ? clone(bag.values) : null
    },
    save: (values, _embeddingBackend, fromLoad) => {
      const chat = activeChat()
      if (!chat) return
      const stored = bagOf(chat.name, chat.key)
      const fromDefaults = stored?.fromDefaults ?? true
      if (fromLoad || !stored || fromDefaults || baseline?.key !== chat.key) {
        setBag(chat.name, chat.key, { values: clone(values), fromDefaults })
        return
      }
      const kept = keepUneditedValues(stored.values, values, baseline.values, baseline.edited)
      baseline.edited = kept.edited
      setBag(chat.name, chat.key, { values: kept.values, fromDefaults })
    },
    pinned: () => {
      const chat = activeChat()
      return chat ? bagOf(chat.name, chat.key)?.fromDefaults === false : false
    },
    loaded: (values) => {
      const chat = activeChat()
      if (chat) baseline = { key: chat.key, values: clone(values), edited: new Set() }
    },
  })

  /** The comfy preset owning a settings key, when the open Session holds its settings. */
  function comfyPresetFor(settingsKey: string): Preset | undefined {
    if (!ready.value) return undefined
    const preset = activePreset.value
    if (heldHere(preset) && preset.type === 'comfy' && settingsKeyOf(preset) === settingsKey) {
      return preset
    }
    return Object.keys(settings.value)
      .map((name) => presetNamed(name))
      .find((candidate) => heldHere(candidate) && bagOf(candidate.name, settingsKey) !== undefined)
  }

  function comfyValues(bag: SessionSettingsBag): ComfyValues {
    const values = bag.values as Partial<ComfyValues>
    return { settings: { ...values.settings }, inputs: { ...values.inputs } }
  }

  imageGeneration.bindSessionSettings({
    use: (settingsKey, defaults) => {
      const preset = comfyPresetFor(settingsKey)
      if (!preset) return null
      const stored = bagOf(preset.name, settingsKey)
      if (stored) return comfyValues(stored)
      setBag(preset.name, settingsKey, { values: clone(defaults), fromDefaults: true })
      return defaults
    },
    peek: (settingsKey) => {
      const preset = comfyPresetFor(settingsKey)
      const stored = preset ? bagOf(preset.name, settingsKey) : undefined
      return stored ? comfyValues(stored) : null
    },
    write: (settingsKey, values) => {
      const preset = comfyPresetFor(settingsKey)
      const stored = preset ? bagOf(preset.name, settingsKey) : undefined
      if (!preset || !stored) return
      setBag(preset.name, settingsKey, { ...stored, values: clone(values) })
    },
  })

  // The Agent preset's settings keep ADR-0001's shape and rules in the agent store; only
  // where they live is shared: one bag in the open Session, keyed by the preset name.
  agentMode.bindSessionSettingsPort({
    read: (presetName) => {
      const bag = ready.value ? bagOf(presetName, presetName) : undefined
      return bag
        ? { settings: clone(bag.values) as AgentSessionSettings, sent: !bag.fromDefaults }
        : undefined
    },
    write: (presetName, values, sent) => {
      if (!ready.value) return
      setBag(presetName, presetName, { values: clone(values), fromDefaults: !sent })
    },
    drop: (presetName) => {
      if (ready.value) update(presetName, withoutBag(settings.value[presetName], presetName))
    },
    readStored: async (sessionId, presetName) => {
      if (sessionId === loadedSessionId.value) {
        const bag = bagOf(presetName, presetName)
        return bag ? (clone(bag.values) as AgentSessionSettings) : null
      }
      try {
        const result = await window.electronAPI.sessions.readSettings(sessionId)
        if (!result.success) throw new Error(result.error)
        const bag = result.settings[presetName]?.bags[presetName]
        return bag ? (bag.values as AgentSessionSettings) : null
      } catch (error) {
        errors.report(error, {
          code: 'sessions/settings-read-failed',
          category: 'backend',
          surface: 'toast',
        })
        return null
      }
    },
    whenLoaded: () => loading.value,
  })

  function validSessionVariant(preset: Preset): string | undefined {
    const variant = settings.value[preset.name]?.variant
    return variant && variantNames(preset).includes(variant) ? variant : undefined
  }

  presetSwitching.bindSessionVariant((presetName) => {
    const preset = presetNamed(presetName)
    return ready.value && heldHere(preset) ? validSessionVariant(preset) : undefined
  })

  // A variant is recorded on first use and when the user picks one; a stored variant the
  // preset no longer offers is kept, so it blocks sending (below) instead of being replaced.
  watch(
    () => [loadedSessionId.value, presets.activePresetName, activeVariantOfActivePreset()] as const,
    ([sessionId, presetName, variant], previous) => {
      const preset = activePreset.value
      if (!ready.value || !heldHere(preset) || !variant) return
      const stored = settings.value[preset.name]?.variant
      if (stored === variant) return
      const pickedHere = previous?.[0] === sessionId && previous?.[1] === presetName
      if (stored && !pickedHere) return
      update(preset.name, withVariant(settings.value[preset.name], variant))
    },
  )

  function activeVariantOfActivePreset(): string | undefined {
    const name = presets.activePresetName
    return name ? presets.activeVariantName[name] : undefined
  }

  function reloadActivePreset(): void {
    const preset = activePreset.value
    if (!heldHere(preset)) return
    const variant = validSessionVariant(preset)
    if (variant && variant !== presets.activeVariantName[preset.name]) {
      void presetSwitching.switchVariant(variant, {
        skipModeSwitch: true,
        skipMemoryAlert: true,
        skipLastUsedUpdate: true,
      })
      return
    }
    if (preset.type === 'chat') textInference.loadSettingsForActivePreset()
    else imageGeneration.loadSettingsForActivePreset()
  }

  async function load(sessionId: string | null): Promise<void> {
    loadedSessionId.value = null
    settings.value = {}
    baseline = null
    if (!sessionId) return
    try {
      const result = await window.electronAPI.sessions.readSettings(sessionId)
      if (!result.success) throw new Error(result.error)
      if (sessions.openSessionId !== sessionId) return
      settings.value = result.settings
      loadedSessionId.value = sessionId
    } catch (error) {
      errors.report(error, {
        code: 'sessions/settings-read-failed',
        category: 'backend',
        surface: 'toast',
      })
      return
    }
    reloadActivePreset()
  }

  watch(
    () => sessions.openSessionId,
    (id) => {
      loading.value = load(id)
    },
    { immediate: true, flush: 'sync' },
  )

  /** The active preset's bag in the open Session, with its preset and key. */
  function activeBag(): {
    preset: Preset
    key: string
    bag: SessionSettingsBag | undefined
  } | null {
    const preset = activePreset.value
    if (!ready.value || !heldHere(preset)) return null
    const key = settingsKeyOf(preset)
    return { preset, key, bag: bagOf(preset.name, key) }
  }

  /** Whether the active preset's settings belong to the open Session (not Agent, not Home Agent). */
  const holdsActivePreset = computed(() => activeBag() !== null)

  /** What blocks sending: unusable settings the Session already sent with (ADR-0001's rule). */
  const problems = computed<SessionSettingsProblem[]>(() => {
    const active = activeBag()
    if (!active) return []
    const found = variantProblems(settings.value[active.preset.name], variantNames(active.preset))
    const chat = active.preset as ChatPreset
    if (active.bag && chat.type === 'chat' && !chat.ttsPreset && !chat.sttPreset) {
      found.push(...chatBagProblems(active.bag.values, textInference.settingsAvailability))
    }
    return blockingProblems(active.bag, found)
  })

  /** A turn is being sent with the active preset: its settings are the Session's own from now on. */
  function markSent(): void {
    const active = activeBag()
    if (!active?.bag || !active.bag.fromDefaults) return
    setBag(active.preset.name, active.key, asSent(active.bag))
  }

  /** "Save as default": the active preset's settings in this Session become its Default Settings. */
  function saveAsDefault(): boolean {
    const active = activeBag()
    if (!active?.bag) return false
    const values = clone(active.bag.values)
    if (active.preset.type === 'chat') {
      textInference.settingsPerPreset = { ...textInference.settingsPerPreset, [active.key]: values }
    } else {
      const comfy = comfyValues(active.bag)
      imageGeneration.settingsPerPreset = {
        ...imageGeneration.settingsPerPreset,
        [active.key]: comfy.settings,
      }
      imageGeneration.comfyInputsPerPreset = {
        ...imageGeneration.comfyInputsPerPreset,
        [active.key]: comfy.inputs,
      }
    }
    return true
  }

  /** "Reset to default": the Session takes the Default Settings again, repaired like a first use. */
  function resetToDefault(): boolean {
    const active = activeBag()
    if (!active) return false
    update(active.preset.name, withoutBag(settings.value[active.preset.name], active.key))
    baseline = null
    if (active.preset.type === 'chat') textInference.loadSettingsForActivePreset()
    else imageGeneration.loadSettingsForActivePreset()
    return true
  }

  /** Settles once the open Session's settings are read and applied. */
  function whenLoaded(): Promise<void> {
    return loading.value
  }

  return {
    settings,
    ready,
    holdsActivePreset,
    problems,
    markSent,
    saveAsDefault,
    resetToDefault,
    whenLoaded,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSessionSettings, import.meta.hot))
}
