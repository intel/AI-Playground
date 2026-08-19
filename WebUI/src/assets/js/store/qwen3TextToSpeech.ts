import { defineStore } from 'pinia'
import { ref } from 'vue'
import { acceptHMRUpdate } from 'pinia'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices } from './backendServices'
import { useModels } from './models'
import { useDialogStore } from './dialogs'
import * as toast from '@/assets/js/toast'
import { createAppError } from '../errors/appError'
import { qwen3TtsFetch } from '@/lib/loopbackAuth'
import { resolveTtsSpeakerLabel } from '@/lib/ttsSpeakerLabel'
import { randomVoiceSeed, seedForVoice, stableVoiceSeed } from '@/lib/ttsVoiceSeed'
import { QWEN3_TTS_MODEL_REPOS } from '@/assets/js/qwen3TtsConstants'
import type {
  Qwen3TtsApiResponse,
  Qwen3TtsLanguage,
  Qwen3TtsSavedVoice,
  Qwen3TtsSpeakerId,
  Qwen3TtsSynthesisMode,
  Qwen3TtsSynthesizeResult,
} from '@/assets/js/qwen3TtsConstants'

export const useQwen3TextToSpeech = defineStore(
  'qwen3TextToSpeech',
  () => {
    const backendServices = useBackendServices()

    /** Default voice when the agent omits `speaker`. User can change in settings or chat. */
    const defaultSpeaker = ref<Qwen3TtsSpeakerId>('Ryan')
    const defaultLanguage = ref<Qwen3TtsLanguage>('Auto')
    /** `voice_design` uses natural-language voice descriptions via `instruct`. */
    const defaultMode = ref<Qwen3TtsSynthesisMode>('custom_voice')
    /** Free-form voice description used when `mode === 'voice_design'` and no per-call
     *  `instruct` is supplied (e.g. the direct-synthesis TTS preset). */
    const defaultInstruct = ref<string>('')
    /** Name of the saved voice currently selected in settings. Empty when a preset
     *  speaker is active. Independent of `defaultSpeaker`, which is only a preset id. */
    const defaultVoiceName = ref<string>('')

    /** User-created named voice directions, reusable from settings, chat, and the agent. */
    const savedVoices = ref<Qwen3TtsSavedVoice[]>([])

    /** The HF repo backing a synthesis mode. Each mode has its own weights, so we
     *  only prompt to download the one the user is actually about to use. */
    function modelRepoForMode(mode: Qwen3TtsSynthesisMode): string {
      return mode === 'voice_design'
        ? QWEN3_TTS_MODEL_REPOS.voiceDesign
        : QWEN3_TTS_MODEL_REPOS.customVoice
    }

    /** Whether the weights for a mode are present on disk (defaults to the current mode). */
    async function isModelInstalled(
      mode: Qwen3TtsSynthesisMode = defaultMode.value,
    ): Promise<boolean> {
      const models = useModels()
      return models.checkQwenTtsModelExists(modelRepoForMode(mode))
    }

    /**
     * Ensure the weights for a specific mode are downloaded, prompting the standard
     * model-download popup only when that mode's model is missing. Custom-voice and
     * voice-design are separate models, so creating a designed voice never pulls the
     * custom-voice model and vice-versa. Resolves once installed; rejects if the user
     * cancels or the download fails.
     */
    async function ensureModelInstalled(
      mode: Qwen3TtsSynthesisMode = defaultMode.value,
    ): Promise<void> {
      const models = useModels()
      const dialogs = useDialogStore()
      const missing = await models.getMissingQwenTtsModels([modelRepoForMode(mode)])
      if (missing.length === 0) return
      await new Promise<void>((resolve, reject) => {
        dialogs.showDownloadDialog(
          missing,
          () => resolve(),
          (reason) =>
            reject(
              reason instanceof Error
                ? reason
                : new Error('Text To Speech model download was cancelled'),
            ),
        )
      })
      // If the service was already running (e.g. started from the device picker
      // before the model existed), restart it so it picks up the freshly
      // downloaded weights via QWEN3_TTS_MODEL on the next spawn.
      const info = backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')
      if (info?.status === 'running') {
        await backendServices.stopService('qwen3-tts-backend')
        await backendServices.startService('qwen3-tts-backend')
      }
    }

    async function ensureBackendRunning(): Promise<string> {
      const info = backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')
      if (!info?.isSetUp) {
        throw new Error(
          'Text To Speech is not installed. Install it from Settings → Installation Management, then try again.',
        )
      }
      // Note: the per-mode model download is handled by ensureModelInstalled(mode),
      // called by ensureModelLoaded()/synthesize() so we only fetch the model the
      // user actually needs — not both. Starting the service does not download.
      if (info.status !== 'running') {
        const startStatus = await backendServices.startService('qwen3-tts-backend')
        // The startup guard (LongLivedPythonApiService.assertReadyToStart) rejects
        // a half-provisioned env (e.g. torch missing) with a 'failed' status
        // instead of a fake-healthy server. Surface that here as an actionable
        // reinstall message — otherwise we'd POST to /api/load against a backend
        // that never started and report an opaque connection error.
        if (startStatus !== 'running') {
          const details = backendServices.getServiceErrorDetails('qwen3-tts-backend')
          const hint = details?.stderr ? ` (${details.stderr.split('\n')[0].trim()})` : ''
          throw createAppError({
            category: 'inference',
            code: 'inference/tts-failed',
            userMessage:
              `Text To Speech failed to start — its environment may be incomplete. ` +
              `Reinstall it from Settings → Installation Management, then try again.${hint}`,
          })
        }
      }
      const running = backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')
      const baseUrl = running?.baseUrl
      if (!baseUrl) {
        throw new Error('Text To Speech backend URL is not available')
      }
      return baseUrl.replace(/\/$/, '')
    }

    /**
     * Whether the model for a mode is already resident in the running backend, so
     * the caller can skip the "loading model" status phase when it would be a no-op.
     * Returns false (i.e. "will need loading") if the backend isn't running yet.
     */
    async function isModelLoaded(mode?: Qwen3TtsSynthesisMode): Promise<boolean> {
      const info = backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')
      if (!info?.isSetUp || info.status !== 'running' || !info.baseUrl) return false
      try {
        const baseUrl = info.baseUrl.replace(/\/$/, '')
        const response = await qwen3TtsFetch(`${baseUrl}/api/config`, { method: 'GET' })
        const payload = (await response.json()) as Qwen3TtsApiResponse<{
          customVoiceModel: string
          voiceDesignModel: string
          status: { loadedModelIds: string[] }
        }>
        const data = payload.data
        if (!data) return false
        const targetId =
          (mode ?? defaultMode.value) === 'voice_design'
            ? data.voiceDesignModel
            : data.customVoiceModel
        return data.status.loadedModelIds.includes(targetId)
      } catch {
        return false
      }
    }

    /**
     * Ask the backend to load the model for a mode (without generating). Lets the
     * caller show a distinct "loading model" phase before "generating audio".
     */
    async function ensureModelLoaded(mode?: Qwen3TtsSynthesisMode): Promise<void> {
      const m = mode ?? defaultMode.value
      // Only prompt for the model this mode needs.
      await ensureModelInstalled(m)
      const baseUrl = await ensureBackendRunning()
      const response = await qwen3TtsFetch(`${baseUrl}/api/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: m }),
      })
      const payload = (await response.json()) as Qwen3TtsApiResponse<unknown>
      if (!response.ok || payload.code !== 0) {
        throw new Error(
          payload.message ?? `Failed to load Text To Speech model (${response.status})`,
        )
      }
    }

    async function synthesize(args: {
      text: string
      language?: Qwen3TtsLanguage
      speaker?: Qwen3TtsSpeakerId
      instruct?: string
      mode?: Qwen3TtsSynthesisMode
      /** Name of a saved voice; overrides mode/instruct with the saved description. */
      voiceName?: string
    }): Promise<Qwen3TtsSynthesizeResult> {
      let mode = args.mode ?? defaultMode.value
      let language = args.language ?? defaultLanguage.value
      let instruct = args.instruct
      // A named voice is a saved voice_design description; it wins over mode/instruct.
      let saved = args.voiceName ? resolveVoice(args.voiceName) : undefined
      if (args.voiceName) {
        if (!saved) {
          throw new Error(`No saved Text To Speech voice named "${args.voiceName}"`)
        }
        mode = 'voice_design'
        instruct = saved.instruct
        if (saved.language) language = saved.language
      } else if (mode === 'voice_design' && defaultVoiceName.value) {
        // Settings-driven path (TTS preset / "Speak"): the active voice is the one
        // selected in settings, so it supplies the seed that keeps it recognisable.
        saved = resolveVoice(defaultVoiceName.value)
      }
      // For voice_design fall back to the saved description when the caller omits one.
      const resolvedInstruct =
        instruct ?? (mode === 'voice_design' ? defaultInstruct.value : undefined)
      // Voice-design ignores the preset speaker id; label with the saved voice name
      // instead of the leftover custom_voice default.
      const speaker = resolveTtsSpeakerLabel({
        mode,
        voiceName:
          args.voiceName?.trim() || (mode === 'voice_design' ? defaultVoiceName.value.trim() : ''),
        instruct: resolvedInstruct,
        savedVoices: savedVoices.value,
        speaker: args.speaker,
        defaultSpeaker: defaultSpeaker.value,
      })
      // Voice design samples a speaker from the description, so an unseeded run
      // invents a new person every time. Pin the saved voice's seed (falling back
      // to one derived from its description) so a saved voice stays itself across
      // separate generations. Preset speakers already have a fixed timbre, so they
      // keep their natural prosody variation.
      const seed =
        mode === 'voice_design' && saved
          ? seedForVoice(saved)
          : mode === 'voice_design' && resolvedInstruct
            ? stableVoiceSeed('', resolvedInstruct)
            : undefined
      // Only the model for the resolved mode is required.
      await ensureModelInstalled(mode)
      const baseUrl = await ensureBackendRunning()
      const body = {
        text: args.text,
        language,
        speaker,
        instruct: resolvedInstruct,
        mode,
        seed,
      }
      const response = await qwen3TtsFetch(`${baseUrl}/api/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = (await response.json()) as Qwen3TtsApiResponse<Qwen3TtsSynthesizeResult>
      if (!response.ok || payload.code !== 0 || !payload.data) {
        throw new Error(payload.message ?? `Text To Speech synthesis failed (${response.status})`)
      }
      // Sidecar echoes `speaker`; keep the resolved label if it ever diverges.
      return { ...payload.data, speaker }
    }

    /** Persist WAV bytes under Documents/AI-Playground/audio and return the absolute path. */
    async function saveWavToDisk(audioBase64: string, suggestedName: string): Promise<string> {
      const result = await window.electronAPI.saveGeneratedAudio(audioBase64, suggestedName)
      if (!result.success || !result.filePath) {
        throw new Error(result.error ?? 'Failed to save audio file')
      }
      return result.filePath
    }

    function isBackendSetUp(): boolean {
      return (
        backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')?.isSetUp === true
      )
    }

    async function applyUserVoicePreference(args: {
      speaker?: Qwen3TtsSpeakerId
      language?: Qwen3TtsLanguage
      mode?: Qwen3TtsSynthesisMode
    }): Promise<void> {
      if (args.speaker) defaultSpeaker.value = args.speaker
      if (args.language) defaultLanguage.value = args.language
      if (args.mode) defaultMode.value = args.mode
      if (args.mode === 'custom_voice') defaultVoiceName.value = ''
      toast.success('Updated default Text To Speech voice settings for this session')
    }

    /** Select a saved voice as the active voice_design default. */
    function applySavedVoice(name: string): boolean {
      const voice = resolveVoice(name)
      if (!voice) return false
      defaultMode.value = 'voice_design'
      defaultInstruct.value = voice.instruct
      defaultVoiceName.value = voice.name
      if (voice.language) defaultLanguage.value = voice.language
      return true
    }

    /** Select a built-in preset speaker (custom_voice mode). */
    function applyPresetSpeaker(speaker: Qwen3TtsSpeakerId): void {
      defaultMode.value = 'custom_voice'
      defaultSpeaker.value = speaker
      defaultVoiceName.value = ''
    }

    /** Create or update a named voice direction (matched case-insensitively by name). */
    function saveVoice(voice: Qwen3TtsSavedVoice): void {
      const name = voice.name.trim()
      const instruct = voice.instruct.trim()
      if (!name || !instruct) return
      const idx = savedVoices.value.findIndex((v) => v.name.toLowerCase() === name.toLowerCase())
      const existing = idx >= 0 ? savedVoices.value[idx] : undefined
      // Pin a seed so the voice sounds the same every time it is used. Keep the
      // existing one when only re-saving the same description; a rewritten
      // description is a different voice, so it gets a fresh seed.
      const seed =
        voice.seed ??
        (existing && existing.instruct.trim() === instruct
          ? seedForVoice(existing)
          : stableVoiceSeed(name, instruct))
      const entry: Qwen3TtsSavedVoice = { name, instruct, language: voice.language, seed }
      if (idx >= 0) savedVoices.value.splice(idx, 1, entry)
      else savedVoices.value.push(entry)
      // Keep an active selection of this voice in sync with the edited description.
      if (defaultVoiceName.value.toLowerCase() === name.toLowerCase()) {
        defaultInstruct.value = instruct
      }
    }

    /**
     * Give a saved voice a new random seed — i.e. draw a different speaker for the
     * same description. The escape hatch when the pinned voice sounds wrong (too
     * slow, wrong gender, odd prosody) instead of it silently changing on its own.
     */
    function rerollVoiceSeed(name: string): number | undefined {
      const idx = savedVoices.value.findIndex(
        (v) => v.name.toLowerCase() === name.trim().toLowerCase(),
      )
      if (idx < 0) return undefined
      const seed = randomVoiceSeed()
      savedVoices.value.splice(idx, 1, { ...savedVoices.value[idx], seed })
      return seed
    }

    function deleteVoice(name: string): void {
      const n = name.trim().toLowerCase()
      savedVoices.value = savedVoices.value.filter((v) => v.name.toLowerCase() !== n)
      if (defaultVoiceName.value.toLowerCase() === n) defaultVoiceName.value = ''
    }

    function resolveVoice(name: string): Qwen3TtsSavedVoice | undefined {
      const n = name.trim().toLowerCase()
      return savedVoices.value.find((v) => v.name.toLowerCase() === n)
    }

    /** Mirrors `isQwen3TtsEnabled` from settings.json (dev: settings-dev.json). */
    const isFeatureEnabled = ref(false)

    async function initFeatureFlag() {
      try {
        const localSettings = await window.electronAPI.getLocalSettings()
        isFeatureEnabled.value = !!localSettings.isQwen3TtsEnabled
      } catch (e) {
        console.error('qwen3TextToSpeech.initFeatureFlag failed:', e)
        isFeatureEnabled.value = false
      }
    }
    void initFeatureFlag()

    return {
      defaultSpeaker,
      defaultLanguage,
      defaultMode,
      defaultInstruct,
      defaultVoiceName,
      savedVoices,
      isFeatureEnabled,
      synthesize,
      saveWavToDisk,
      ensureBackendRunning,
      ensureModelInstalled,
      ensureModelLoaded,
      isModelLoaded,
      isModelInstalled,
      isBackendSetUp,
      applyUserVoicePreference,
      applySavedVoice,
      applyPresetSpeaker,
      saveVoice,
      rerollVoiceSeed,
      deleteVoice,
      resolveVoice,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: [
        'defaultSpeaker',
        'defaultLanguage',
        'defaultMode',
        'defaultInstruct',
        'defaultVoiceName',
        'savedVoices',
      ],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useQwen3TextToSpeech, import.meta.hot))
}
