import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, watch } from 'vue'
import type { FileUIPart } from 'ai'
import { useErrors } from '@/assets/js/store/errors'
import { useSessions } from '@/assets/js/store/sessions'
import { useSessionSettings } from '@/assets/js/store/sessionSettings'
import { usePresets, type ChatPreset } from '@/assets/js/store/presets'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import {
  audioMediaType,
  decideDefaultInput,
  pickedDefaultInput,
  type DefaultInputState,
  type DefaultInputTrigger,
} from '@/lib/sessionDefaultInputs'
import type { NewestArtifact } from '@/types/sessionIpc'

type DefaultInputMode = 'imageEdit' | 'video' | 'stt'

type Target = {
  sessionId: string
  /** One per Session and preset (and variant, whose inputs are kept apart). */
  key: string
  mode: DefaultInputMode
  mediaType: 'image' | 'audio'
}

/**
 * Default inputs from the Session History: Image Edit and image-taking Video presets
 * start with the Session's newest image, Speech-to-Text with its newest audio, filled
 * on activation and after each new matching artifact unless the user picked one since.
 */
export const useSessionDefaultInputs = defineStore('sessionDefaultInputs', () => {
  const errors = useErrors()
  const sessions = useSessions()
  const sessionSettings = useSessionSettings()
  const presets = usePresets()
  const imageGeneration = useImageGenerationPresets()
  const chat = useOpenAiCompatibleChat()

  const states = new Map<string, DefaultInputState>()
  const newestKnown = new Map<string, string | null>()
  const pendingPicks = new Map<string, DefaultInputMode>()
  let autoAttached: FileUIPart | null = null

  const target = computed<Target | null>(() => {
    const sessionId = sessions.openSessionId
    const preset = presets.activePreset
    if (!sessionId || !preset) return null
    if (preset.type === 'chat' && (preset as ChatPreset).sttPreset) {
      return { sessionId, key: `${sessionId}\n${preset.name}`, mode: 'stt', mediaType: 'audio' }
    }
    const mode = imageGeneration.defaultImageInputMode
    if (!mode || !sessionSettings.ready) return null
    const variant = presets.activeVariantName[preset.name] ?? ''
    return { sessionId, key: `${sessionId}\n${preset.name}\n${variant}`, mode, mediaType: 'image' }
  })

  function knownKey(t: Pick<Target, 'sessionId' | 'mediaType'>): string {
    return `${t.sessionId}\n${t.mediaType}`
  }

  async function lookup(t: Target): Promise<NewestArtifact | null | undefined> {
    try {
      const result = await window.electronAPI.sessions.newestArtifact(t.sessionId, t.mediaType)
      if (!result.success) throw new Error(result.error)
      return result.artifact
    } catch (error) {
      errors.report(error, {
        code: 'sessions/newest-artifact-failed',
        category: 'backend',
        surface: 'silent',
      })
      return undefined
    }
  }

  function attachAudio(artifact: NewestArtifact): void {
    const filename = artifact.path.split('/').pop() ?? artifact.path
    const part: FileUIPart = {
      type: 'file',
      mediaType: audioMediaType(filename),
      url: artifact.url,
      filename,
    }
    const previous = autoAttached
    autoAttached = part
    chat.fileInput = [...chat.fileInput.filter((existing) => existing.url !== previous?.url), part]
  }

  function detachAudio(): void {
    const previous = autoAttached
    if (!previous) return
    autoAttached = null
    chat.fileInput = chat.fileInput.filter((existing) => existing.url !== previous.url)
  }

  function apply(t: Target, artifact: NewestArtifact): boolean {
    if (t.mode === 'stt') {
      attachAudio(artifact)
      return true
    }
    return imageGeneration.fillDefaultReference(artifact.url)
  }

  async function evaluate(trigger: DefaultInputTrigger): Promise<void> {
    const t = target.value
    if (!t) return
    const artifact = await lookup(t)
    if (artifact === undefined || target.value?.key !== t.key) return
    newestKnown.set(knownKey(t), artifact?.entryId ?? null)
    if (pendingPicks.get(t.sessionId) === t.mode) {
      pendingPicks.delete(t.sessionId)
      states.set(t.key, pickedDefaultInput(undefined))
    }
    const decision = decideDefaultInput(states.get(t.key), artifact?.entryId ?? null, trigger)
    states.set(t.key, decision.next)
    if (decision.fill && artifact && !apply(t, artifact)) states.delete(t.key)
  }

  function markPicked(mode: DefaultInputMode): void {
    const t = target.value
    if (t && t.mode === mode) {
      states.set(t.key, pickedDefaultInput(newestKnown.get(knownKey(t))))
      return
    }
    const sessionId = sessions.openSessionId
    if (sessionId) pendingPicks.set(sessionId, mode)
  }

  watch(
    () => target.value?.key,
    () => {
      detachAudio()
      void evaluate('activation')
    },
    { immediate: true },
  )

  watch(
    () => sessions.openTimeline,
    () => void evaluate('update'),
  )

  watch(
    () => imageGeneration.inputPick,
    (pick) => {
      if (pick && (pick.mode === 'imageEdit' || pick.mode === 'video')) markPicked(pick.mode)
    },
  )

  watch(
    () => chat.fileInput,
    (parts) => {
      if (!autoAttached || parts.some((part) => part.url === autoAttached?.url)) return
      autoAttached = null
      markPicked('stt')
    },
  )

  return {}
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSessionDefaultInputs, import.meta.hot))
}
