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
import { voicePreviewSentence } from '@/lib/ttsVoicePreview'
import { seedForVoice, stableVoiceSeed } from '@/lib/ttsVoiceSeed'
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
      if (mode === 'voice_design') return QWEN3_TTS_MODEL_REPOS.voiceDesign
      if (mode === 'voice_clone') return QWEN3_TTS_MODEL_REPOS.voiceClone
      return QWEN3_TTS_MODEL_REPOS.customVoice
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
          voiceCloneModel?: string
          status: { loadedModelIds: string[] }
        }>
        const data = payload.data
        if (!data) return false
        const resolved = mode ?? defaultMode.value
        const targetId =
          resolved === 'voice_design'
            ? data.voiceDesignModel
            : resolved === 'voice_clone'
              ? data.voiceCloneModel
              : data.customVoiceModel
        // An older sidecar doesn't report the clone model; treat that as "not resident"
        // so the caller loads it explicitly rather than assuming it is ready.
        if (!targetId) return false
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
      /**
       * Explicit voice-design seed, taking precedence over the one derived from the
       * saved voice / description. Used to preview an unsaved voice with exactly the
       * seed shown on the form, so what the user hears is what gets saved.
       */
      seed?: number
      /**
       * Draw a new speaker from `instruct` instead of reproducing the active saved
       * voice. Set when creating or re-saving a voice — see the clone routing below.
       */
      designNewVoice?: boolean
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
        mode === 'voice_design' && args.seed !== undefined
          ? args.seed
          : mode === 'voice_design' && saved
            ? seedForVoice(saved)
            : mode === 'voice_design' && resolvedInstruct
              ? stableVoiceSeed('', resolvedInstruct)
              : undefined

      // A saved voice with a preview is reproduced by cloning that recording rather
      // than by re-running the sampled design. The seed above can only pin a single
      // generation: hand voice design the same seed and different words and it draws
      // a different speaker, which is exactly what made saved voices drift. Cloning
      // conditions on the audio, so the voice the user approved is the voice they get
      // for any text. Voices saved before previews existed have nothing to clone from,
      // so they keep the seeded design path.
      //
      // `designNewVoice` opts out: when the caller is *creating* a voice, the active
      // voice is usually the one being replaced, and cloning its old preview would
      // re-render the very speaker the user is trying to redraw — so a rolled seed
      // would appear to do nothing.
      const cloneRef =
        !args.designNewVoice && mode === 'voice_design' && saved?.previewFilePath
          ? { path: saved.previewFilePath, text: voicePreviewSentence(saved.name) }
          : undefined
      if (cloneRef) mode = 'voice_clone'
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
        refAudioPath: cloneRef?.path,
        refText: cloneRef?.text,
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
    async function saveWavToDisk(
      audioBase64: string,
      suggestedName: string,
      options?: { overwrite?: boolean },
    ): Promise<string> {
      const result = await window.electronAPI.saveGeneratedAudio(
        audioBase64,
        suggestedName,
        options,
      )
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
      // Keep the existing preview when the caller doesn't supply a fresh one, so a
      // rename-free re-save doesn't silently leave the card with no Play audio.
      const previewFilePath = voice.previewFilePath ?? existing?.previewFilePath
      const entry: Qwen3TtsSavedVoice = {
        name,
        instruct,
        language: voice.language,
        seed,
        previewFilePath,
      }
      if (idx >= 0) savedVoices.value.splice(idx, 1, entry)
      else savedVoices.value.push(entry)
      // Keep an active selection of this voice in sync with the edited description.
      if (defaultVoiceName.value.toLowerCase() === name.toLowerCase()) {
        defaultInstruct.value = instruct
      }
    }

    /**
     * Forget a saved voice, and with it the preview WAV that was generated for it —
     * leaving the file behind would litter the audio folder with takes belonging to
     * voices that no longer exist.
     *
     * Skipped when another saved voice still points at the same file: two names can
     * slugify to a single preview filename, and the survivor still needs it. A failed
     * delete only warns — the voice is gone either way, and a stuck file must not be
     * able to keep it in the list.
     */
    async function deleteVoice(name: string): Promise<void> {
      const n = name.trim().toLowerCase()
      const removed = savedVoices.value.find((v) => v.name.toLowerCase() === n)
      savedVoices.value = savedVoices.value.filter((v) => v.name.toLowerCase() !== n)
      if (defaultVoiceName.value.toLowerCase() === n) defaultVoiceName.value = ''

      const previewFilePath = removed?.previewFilePath
      if (!previewFilePath) return
      if (savedVoices.value.some((v) => v.previewFilePath === previewFilePath)) return
      try {
        const result = await window.electronAPI.deleteGeneratedAudio(previewFilePath)
        if (!result.success) {
          console.warn(`Could not delete voice preview ${previewFilePath}: ${result.error}`)
        }
      } catch (error) {
        console.warn(`Could not delete voice preview ${previewFilePath}:`, error)
      }
    }

    /**
     * Restore the voice/language/mode choices to their defaults — the Audio mode's
     * equivalent of "Reset Preset Settings" for the chat and workflow panels.
     *
     * Saved voices are deliberately kept: they are content the user created (each with
     * a preview recording on disk), not a setting, so a reset points back at a built-in
     * speaker rather than destroying them.
     */
    function resetToDefaults(): void {
      defaultSpeaker.value = 'Ryan'
      defaultLanguage.value = 'Auto'
      defaultMode.value = 'custom_voice'
      defaultInstruct.value = ''
      defaultVoiceName.value = ''
    }

    function resolveVoice(name: string): Qwen3TtsSavedVoice | undefined {
      const n = name.trim().toLowerCase()
      return savedVoices.value.find((v) => v.name.toLowerCase() === n)
    }

    return {
      defaultSpeaker,
      defaultLanguage,
      defaultMode,
      defaultInstruct,
      defaultVoiceName,
      savedVoices,
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
      deleteVoice,
      resetToDefaults,
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
