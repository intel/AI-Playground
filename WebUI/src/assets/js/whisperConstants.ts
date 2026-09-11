/**
 * Models offered by the standalone (torch, non-OpenVINO) Whisper STT engine. Each
 * `repo` is a HuggingFace id transformers can load; they download to the shared STT
 * model dir via the standard download popup, and the whisper-backend resolves them
 * from there (see whisperBackendService.modelPathEnv / transcription_engine).
 */
export const WHISPER_STANDALONE_MODELS = [
  { repo: 'openai/whisper-base', label: 'Whisper base' },
  { repo: 'openai/whisper-small', label: 'Whisper small' },
  { repo: 'openai/whisper-large-v3-turbo', label: 'Whisper large v3 turbo' },
] as const

export type WhisperStandaloneModel = (typeof WHISPER_STANDALONE_MODELS)[number]['repo']

export const DEFAULT_WHISPER_STANDALONE_MODEL: WhisperStandaloneModel =
  WHISPER_STANDALONE_MODELS[0].repo

/**
 * Models offered by the OpenVINO (OVMS) Whisper STT engine — the pre-converted
 * IR exports from the `OpenVINO` HuggingFace org, which `ovms --task speech2text`
 * can serve directly. They download to the same shared STT dir as the standalone
 * ones and are launched by `openVINOBackendService.startTranscriptionServer`,
 * which takes the repo id (so the whole set works without backend changes).
 *
 * Deliberately the int8 exports only: they are the accuracy/size compromise the
 * app shipped for `whisper-base` and keep the list a size choice rather than a
 * size × quantization matrix. int4/fp16 variants of each exist upstream.
 */
export const WHISPER_OVMS_MODELS = [
  { repo: 'OpenVINO/whisper-tiny-int8-ov', label: 'Whisper tiny (int8)' },
  { repo: 'OpenVINO/whisper-base-int8-ov', label: 'Whisper base (int8)' },
  { repo: 'OpenVINO/whisper-small-int8-ov', label: 'Whisper small (int8)' },
  { repo: 'OpenVINO/whisper-large-v3-turbo-int8-ov', label: 'Whisper large v3 turbo (int8)' },
] as const

export type WhisperOvmsModel = (typeof WHISPER_OVMS_MODELS)[number]['repo']

/** `whisper-base-int8-ov` — the model the app served before it became selectable. */
export const DEFAULT_WHISPER_OVMS_MODEL: WhisperOvmsModel = 'OpenVINO/whisper-base-int8-ov'
