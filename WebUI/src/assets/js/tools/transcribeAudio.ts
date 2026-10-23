import { tool } from 'ai'
import { z } from 'zod'

// Schema + description only: the body runs in main (`chat/chatSpeechTools.ts`),
// which finds the attachment on the turn's own messages and asks this side only
// to decode and transcribe it.

const TranscribeAudioOutputSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  transcript: z.string().optional(),
})

export const transcribeAudio = tool({
  description:
    'Speech-to-text (STT): transcribe the most recent audio attachment in the conversation into ' +
    'text using the local Whisper model. Call this whenever the user attaches a voice message or ' +
    'audio file and wants it transcribed, or refers to "what was said" in an audio clip.',
  inputSchema: z.object({
    // No inputs: the audio is taken from the latest audio attachment in the chat.
    // A required-but-empty object keeps the schema valid across providers.
  }),
  outputSchema: TranscribeAudioOutputSchema,
})
