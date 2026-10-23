import type { ConfigChange } from '@/assets/js/tools/configureHomeAgentLogic'
import type { LlmBackend } from '@/assets/js/store/textInference'

/**
 * Main → renderer questions a chat tool needs answered.
 *
 * Chat tool bodies run in main. A handful of things genuinely belong to the
 * window, and this is how main asks for them rather than handing the whole tool
 * back: the speech engine seam (`speechIO`), where a missing voice model opens
 * the download prompt; Chromium's audio decoder, which turns a non-WAV
 * attachment into something an STT server takes; the Home Agent confirmation
 * card; and writing an approved settings change into the live stores.
 *
 * The wire shape is `artifact:request`'s: main sends, the current window
 * replies by `requestId`, and `{ progress: true }` reports a phase without
 * settling.
 */

export type SpeechVoiceSelection = {
  /** Preset speaker id (Qwen3 `custom_voice`). */
  speaker?: string
  language?: string
  mode?: 'custom_voice' | 'voice_design'
  /** Speaking-style hint, or the description a `voice_design` voice is built from. */
  instruct?: string
  /** One of the user's saved voices, by name; overrides speaker/mode/instruct. */
  voiceName?: string
  /** Persist speaker/language/mode as the user's default (Qwen3 only). */
  rememberAsDefault?: boolean
}

/** A synthesized clip as the engine seam hands it back. */
export type SpeechClipPayload = {
  audioBase64: string
  mediaType: string
  /** The voice actually used — an external engine may override the selection. */
  voice: string
  engine: 'qwen3' | 'kokoro' | 'external'
  /** Qwen3 only: the mode that ran, which includes `voice_clone` for a saved voice. */
  mode?: 'custom_voice' | 'voice_design' | 'voice_clone'
  /** Qwen3 only: the language the sidecar reports. */
  language?: string
}

/** What applying an approved Home Agent change reports back. */
export type HomeAgentApplyResult = {
  /** A model / backend / device / context change means the backend reloads. */
  backendChanged: boolean
}

export type ChatAskBody =
  | { kind: 'speech-synthesize'; text: string; voice: SpeechVoiceSelection }
  | { kind: 'speech-transcribe'; audioBase64: string; mediaType?: string }
  | {
      kind: 'home-agent-confirm'
      conversationKey: string
      toolCallId?: string
      summaryMarkdown: string
    }
  | { kind: 'home-agent-apply'; targetBackend: LlmBackend; changes: ConfigChange[] }

export type ChatAskPayload = ChatAskBody & { requestId: string }

/** Phases a long request reports while it runs, for the tool's activity. */
export type ChatAskPhase = 'loading-model' | 'generating' | 'awaiting-confirmation' | 'applying'

export type ChatAnswerPayload =
  | { requestId: string; progress: true; phase?: ChatAskPhase }
  | { requestId: string; result: unknown }
  | { requestId: string; error: string }
