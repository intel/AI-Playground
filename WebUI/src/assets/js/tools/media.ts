import { tool } from 'ai'
import { z } from 'zod'
import { MediaAgentMediaSchema } from '../agents/mediaAgent'
import { slimMediaModelOutput } from '@/lib/mediaModelOutput'

// ── Thin media delegation tool ────────────────────────────────────────────────
//
// The only media surface the parent chat model sees when tool delegation is
// enabled (textInference.toolDelegationEnabled): a natural-language request.
// Chat parent turns run that specialist in main (`electron/chat/chatMediaTool.ts`);
// this object is schema-only so the turn request can serialize it.
//
// UI vs model payload: `output` keeps the condensed `images[]` (the Chat
// renderer and the Agent Mode workspace saver consume it), while
// `toModelOutput` sends only the summary, the step lines and slim image refs.
// A vision model also receives the image as a following user message; a model
// without vision does not. Either way the settings payload stays off the wire.

export const MediaToolOutputSchema = z
  .object({
    images: z.array(MediaAgentMediaSchema),
    steps: z.array(z.string()),
    summary: z.string(),
    success: z.boolean().optional(),
    message: z.string().optional(),
  })
  .passthrough()

export type MediaToolOutput = z.infer<typeof MediaToolOutputSchema>

const MEDIA_TOOL_DESCRIPTION =
  'Create or transform media (images, videos, 3D models) via a media specialist. Describe the ' +
  'desired result in natural language; the specialist picks the workflow and parameters and ' +
  'can chain steps in one call (e.g. "generate an image of a castle and turn it into a 3D ' +
  'model", "animate this photo into a short video"). For requests that transform an existing ' +
  'image, the most recent image in the conversation (uploaded or generated) is used as the ' +
  'source. Only use this tool when the user explicitly asks to create or transform media.'

export const media = tool({
  description: MEDIA_TOOL_DESCRIPTION,
  inputSchema: z.object({
    request: z
      .string()
      .describe(
        'The media request in natural language. Include everything relevant: subject, style, ' +
          'aspect ratio or size wishes, quality level, and any follow-up transformation ' +
          '(edit / animate / convert to 3D).',
      ),
  }),
  outputSchema: MediaToolOutputSchema,
  toModelOutput: ({ output }) => slimMediaModelOutput(output),
})

export { slimMediaModelOutput }
