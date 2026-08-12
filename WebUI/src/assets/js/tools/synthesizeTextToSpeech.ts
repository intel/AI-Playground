import { tool } from 'ai'
import { z } from 'zod'
import { useActivities } from '../store/activities'
import { useConversations } from '../store/conversations'
import { useQwen3TextToSpeech } from '../store/qwen3TextToSpeech'
import { QWEN3_TTS_LANGUAGES, QWEN3_TTS_SPEAKERS } from '@/assets/js/qwen3TtsConstants'
import type { Qwen3TtsLanguage, Qwen3TtsSpeakerId } from '@/assets/js/qwen3TtsConstants'
import { buildTtsAudioFileName, conversationLabelForTtsFile } from '@/lib/ttsAudioFileName'

function conversationKeyFor(experimentalContext: unknown): string {
  const ctx = experimentalContext as { conversationKey?: string } | undefined
  return ctx?.conversationKey ?? useConversations().activeKey
}

const speakerIds = QWEN3_TTS_SPEAKERS.map((s) => s.id) as [string, ...string[]]
const languageIds = QWEN3_TTS_LANGUAGES as [string, ...string[]]

const SynthesizeSpeechOutputSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  savedFilePath: z.string().optional(),
  speaker: z.string().optional(),
  language: z.string().optional(),
  mode: z.enum(['custom_voice', 'voice_design']).optional(),
})

type SynthesizeSpeechOutput = z.infer<typeof SynthesizeSpeechOutputSchema>

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
  execute: async (args, options): Promise<SynthesizeSpeechOutput> => {
    const qwen3 = useQwen3TextToSpeech()
    const activities = useActivities()
    const conversations = useConversations()
    const conversationKey = conversationKeyFor(options.experimental_context)
    const scope = {
      kind: 'chat' as const,
      conversationKey,
    }

    // Two visible phases: loading the model (slow on the first call / may prompt the
    // install popup) then generating the audio file. Uses begin/update/end so the
    // status line changes mid-flight; the activity is always ended (even on throw).
    // A saved voice always resolves to voice_design; otherwise use the given mode.
    const loadMode = args.voiceName ? 'voice_design' : args.mode
    // Begin the activity FIRST — before the isModelLoaded probe and backend
    // start, which can each take a moment — so the "Loading voice model…"
    // indicator is visible for the whole load rather than only once synthesis
    // begins. The label is downgraded below when the model is already resident.
    const activityId = activities.begin({
      category: 'tools',
      label: 'Loading voice model…',
      scope,
    })
    try {
      if (args.rememberAsDefault) {
        await qwen3.applyUserVoicePreference({
          speaker: args.speaker as Qwen3TtsSpeakerId | undefined,
          language: args.language as Qwen3TtsLanguage | undefined,
          mode: args.mode,
        })
      }

      const alreadyLoaded = await qwen3.isModelLoaded(loadMode)
      if (!alreadyLoaded) {
        await qwen3.ensureModelLoaded(loadMode)
      }
      activities.update(activityId, { label: 'Generating audio file…' })

      const result = await qwen3.synthesize({
        text: args.text,
        language: args.language as Qwen3TtsLanguage | undefined,
        speaker: args.speaker as Qwen3TtsSpeakerId | undefined,
        instruct: args.instruct,
        mode: args.mode,
        voiceName: args.voiceName,
      })

      const label = conversationLabelForTtsFile({
        conversationKey,
        messages: conversations.conversationList[conversationKey],
        threadMeta: conversations.getThreadMeta(conversationKey),
      })
      const fileName = buildTtsAudioFileName({
        conversationKey,
        conversationLabel: label,
        userSlug: args.outputFileName,
      })
      const savedFilePath = await qwen3.saveWavToDisk(result.audioBase64, fileName)

      activities.end(activityId, 'done')
      return {
        ok: true,
        message:
          `Synthesized ${result.mode} speech (${result.language}, ${result.speaker}). ` +
          `Saved to ${savedFilePath}. The audio player is shown in the chat.`,
        savedFilePath,
        speaker: result.speaker,
        language: result.language,
        mode: result.mode,
      }
    } catch (error) {
      activities.end(activityId, 'failed')
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message }
    }
  },
  toModelOutput: ({ output }) => {
    if (!output.ok) {
      return { type: 'error-text', value: output.message }
    }
    return {
      type: 'text',
      value: `${output.message}${output.savedFilePath ? ` File: ${output.savedFilePath}` : ''}`,
    }
  },
})
