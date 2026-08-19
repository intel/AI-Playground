import type { Qwen3TtsSavedVoice, Qwen3TtsSynthesisMode } from '@/assets/js/qwen3TtsConstants'

/**
 * Speaker name shown in "Synthesized … speech (language, NAME)" and echoed by the
 * sidecar. Voice-design uses a saved voice's name (or "custom"); leftover preset
 * speakers like Ryan/Vivian must not leak through just because they are the last
 * custom_voice default.
 */
export function resolveTtsSpeakerLabel(opts: {
  mode: Qwen3TtsSynthesisMode
  /** Explicit saved-voice name (tool `voiceName` or the settings selection). */
  voiceName?: string
  instruct?: string
  savedVoices: ReadonlyArray<Pick<Qwen3TtsSavedVoice, 'name' | 'instruct'>>
  speaker?: string
  defaultSpeaker: string
}): string {
  const findByName = (name: string) => {
    const n = name.trim().toLowerCase()
    if (!n) return undefined
    return opts.savedVoices.find((v) => v.name.toLowerCase() === n)
  }

  const named = opts.voiceName?.trim()
  if (named) {
    return findByName(named)?.name ?? named
  }

  if (opts.mode === 'voice_design') {
    if (opts.instruct) {
      const match = opts.savedVoices.find((v) => v.instruct === opts.instruct)
      if (match) return match.name
    }
    return 'custom'
  }

  return opts.speaker || opts.defaultSpeaker
}
