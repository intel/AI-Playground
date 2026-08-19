export type Qwen3TtsSpeakerId =
  | 'Vivian'
  | 'Serena'
  | 'Uncle_Fu'
  | 'Dylan'
  | 'Eric'
  | 'Ryan'
  | 'Aiden'
  | 'Ono_Anna'
  | 'Sohee'

export type Qwen3TtsLanguage =
  | 'Auto'
  | 'Chinese'
  | 'English'
  | 'Japanese'
  | 'Korean'
  | 'German'
  | 'French'
  | 'Russian'
  | 'Portuguese'
  | 'Spanish'
  | 'Italian'

export type Qwen3TtsSynthesisMode = 'custom_voice' | 'voice_design'

/**
 * HuggingFace repos backing the two synthesis modes. These are downloaded via the
 * standard model-download popup (like every other model) and loaded locally by the
 * qwen3-tts sidecar — never auto-downloaded on service install. Keep in sync with
 * the env defaults in `qwen3-tts/tts_engine.py` (`QWEN3_TTS_MODEL` / `QWEN3_TTS_VOICE_DESIGN_MODEL`).
 */
export const QWEN3_TTS_MODEL_REPOS = {
  customVoice: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
  voiceDesign: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
} as const

export const QWEN3_TTS_MODEL_REPO_LIST: string[] = [
  QWEN3_TTS_MODEL_REPOS.customVoice,
  QWEN3_TTS_MODEL_REPOS.voiceDesign,
]

/** Named voice direction a user saves and reuses (settings, chat, and the agent). */
export type Qwen3TtsSavedVoice = {
  name: string
  instruct: string
  language?: Qwen3TtsLanguage
  /**
   * Sampling seed pinned to this voice. Voice-design synthesis is sampled, so the
   * same description otherwise yields a different-sounding person on every call.
   * Persisting a seed makes a saved voice reproducible across generations; the
   * user can re-roll it from settings when they dislike the result.
   */
  seed?: number
}

export const QWEN3_TTS_SPEAKERS: Array<{
  id: Qwen3TtsSpeakerId
  description: string
  nativeLanguage: string
}> = [
  {
    id: 'Vivian',
    description: 'Bright, slightly edgy young female voice.',
    nativeLanguage: 'Chinese',
  },
  { id: 'Serena', description: 'Warm, gentle young female voice.', nativeLanguage: 'Chinese' },
  {
    id: 'Uncle_Fu',
    description: 'Seasoned male voice with a low, mellow timbre.',
    nativeLanguage: 'Chinese',
  },
  { id: 'Dylan', description: 'Youthful Beijing male voice.', nativeLanguage: 'Chinese (Beijing)' },
  { id: 'Eric', description: 'Lively Chengdu male voice.', nativeLanguage: 'Chinese (Sichuan)' },
  { id: 'Ryan', description: 'Dynamic male voice.', nativeLanguage: 'English' },
  { id: 'Aiden', description: 'Sunny American male voice.', nativeLanguage: 'English' },
  { id: 'Ono_Anna', description: 'Playful Japanese female voice.', nativeLanguage: 'Japanese' },
  { id: 'Sohee', description: 'Warm Korean female voice.', nativeLanguage: 'Korean' },
]

export const QWEN3_TTS_LANGUAGES: Qwen3TtsLanguage[] = [
  'Auto',
  'Chinese',
  'English',
  'Japanese',
  'Korean',
  'German',
  'French',
  'Russian',
  'Portuguese',
  'Spanish',
  'Italian',
]

export type Qwen3TtsApiResponse<T> = {
  code: number
  data?: T
  message?: string
}

export type Qwen3TtsSynthesizeResult = {
  audioBase64: string
  sampleRate: number
  mediaType: string
  speaker: string
  language: string
  mode: Qwen3TtsSynthesisMode
}
