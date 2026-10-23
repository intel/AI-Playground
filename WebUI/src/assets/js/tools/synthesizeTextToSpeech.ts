import { tool } from 'ai'
import { z } from 'zod'
import { QWEN3_TTS_LANGUAGES, QWEN3_TTS_SPEAKERS } from '@/assets/js/qwen3TtsConstants'
import { ToolConversationContextSchema } from './toolContext'

// Schema + description only: the body runs in main (`chat/chatSpeechTools.ts`),
// which reaches back here for the engine call alone — that is where a missing
// voice model opens the download prompt.

const speakerIds = QWEN3_TTS_SPEAKERS.map((s) => s.id) as [string, ...string[]]
const languageIds = QWEN3_TTS_LANGUAGES as [string, ...string[]]

const SynthesizeSpeechOutputSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  savedFilePath: z.string().optional(),
  speaker: z.string().optional(),
  language: z.string().optional(),
  // Reports the mode that actually ran, which includes `voice_clone`: a saved voice
  // is reproduced by cloning its preview, chosen by the store rather than the caller.
  mode: z.enum(['custom_voice', 'voice_design', 'voice_clone']).optional(),
})

export const synthesizeTextToSpeech = tool({
  description:
    'Text-to-speech (TTS): speak `text` aloud and save a playable WAV file. Call this whenever ' +
    'the user wants text read/said out loud, narrated, voiced, or turned into audio — do not just ' +
    "reply with the text. Voice: a saved voice by name via `voiceName` (the user's named voices, " +
    'e.g. "read this in Tammy\'s voice"), or mode "custom_voice" + `speaker` (Vivian, Ryan, Serena, …), ' +
    'or mode "voice_design" + a natural-language `instruct` (timbre, age, accent, emotion); `instruct` ' +
    'also sets tone. `language`: a known value or Auto. `rememberAsDefault: true` saves the voice/language default.',
  inputSchema: z.object({
    text: z.string().min(1).describe('The exact words to speak aloud (the full script or passage)'),
    language: z
      .enum(languageIds)
      .optional()
      .describe('Target language (Auto lets the model adapt)'),
    speaker: z
      .enum(speakerIds)
      .optional()
      .describe('Preset speaker for custom_voice mode (Ryan, Vivian, Aiden, …)'),
    voiceName: z
      .string()
      .optional()
      .describe(
        "Name of one of the user's saved voices (case-insensitive). Overrides speaker/mode/instruct " +
          'with that saved voice description. Use when the user refers to a voice by name.',
      ),
    instruct: z
      .string()
      .optional()
      .describe('Speaking style instructions (tone, emotion, pace) or voice-design description'),
    mode: z
      .enum(['custom_voice', 'voice_design'])
      .optional()
      .describe('custom_voice = named speaker; voice_design = free-form voice from instruct'),
    outputFileName: z
      .string()
      .optional()
      .describe(
        'Optional short label appended to the auto-generated file name (conversation + date)',
      ),
    rememberAsDefault: z
      .boolean()
      .optional()
      .describe('When true, save speaker/language/mode as the user default for later synthesis'),
  }),
  outputSchema: SynthesizeSpeechOutputSchema,
  contextSchema: ToolConversationContextSchema,
})
