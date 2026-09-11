import { tool, type ModelMessage } from 'ai'
import type { ToolResultOutput } from '@ai-sdk/provider-utils'
import { z } from 'zod'
import { runMediaAgent, MediaAgentMediaSchema } from '../agents/mediaAgent'
import { findSourceImage } from './comfyUiImageEdit'
import { queueMediaRequest } from './mediaPipeline'
import { createChatModel } from '@/lib/chatModel'
import { useActivities } from '../store/activities'
import { useConversations } from '../store/conversations'
import { useI18N } from '../store/i18n'

// ── Thin media delegation tool ────────────────────────────────────────────────
//
// The only media surface the parent chat model sees when tool delegation is
// enabled (textInference.toolDelegationEnabled): a natural-language request,
// executed by the nested media agent (agents/mediaAgent.ts) on the same
// model/endpoint. The heavy workflow catalog and the comfy tool schemas stay
// entirely inside the nested run.
//
// UI vs model payload: `output` keeps the full comfy-shaped `images[]` (the
// Chat renderer and the Agent Mode workspace saver consume it), while
// `toModelOutput` sends only the summary, the step lines and slim image refs —
// enough for the model to describe results and for a follow-up edit to find
// the produced image (see findLatestImageInConversation), without re-sending
// bulky settings payloads on every later turn.

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
  execute: async (args, { messages, abortSignal, toolCallId }): Promise<MediaToolOutput> => {
    const activities = useActivities()
    const conversations = useConversations()
    const i18nState = useI18N().state
    const sourceImage = findSourceImage((messages ?? []) as ModelMessage[]) ?? undefined
    return await activities.track(
      {
        category: 'tools',
        label: i18nState.COM_ACTIVITY_CREATING_MEDIA,
        scope: { kind: 'chat', conversationKey: conversations.activeKey },
      },
      // One request at a time: a model that asks for several images in one step
      // gets parallel tool calls from the AI SDK, and they all share one ComfyUI
      // and one generation store (see mediaPipeline.ts).
      () =>
        queueMediaRequest(
          () =>
            runMediaAgent({
              request: args.request,
              sourceImage,
              model: createChatModel(),
              abortSignal,
              // Keys the live timeline to this tool part (see mediaAgentRuns).
              runId: toolCallId,
            }),
          abortSignal,
        ),
    )
  },
  toModelOutput: ({ output }) => slimMediaModelOutput(output),
})

/**
 * Model-facing condensation of a media tool result: summary + step lines +
 * slim image refs (id/type/url only — no settings payloads). Used both live
 * (`toModelOutput`) and when replaying persisted history (the chat store's
 * request post-processing), so the rich UI output never reaches the model.
 */
export function slimMediaModelOutput(output: MediaToolOutput): ToolResultOutput {
  if (output.success === false || output.images.length === 0) {
    return {
      type: 'error-text',
      value: output.message ?? output.summary ?? 'Media generation failed.',
    }
  }
  return {
    type: 'json',
    value: {
      summary: output.summary,
      steps: output.steps,
      images: output.images.map((item) => {
        const slim: Record<string, string> = { id: item.id, type: item.type }
        if (item.imageUrl) slim.imageUrl = item.imageUrl
        if (item.videoUrl) slim.videoUrl = item.videoUrl
        if (item.model3dUrl) slim.model3dUrl = item.model3dUrl
        return slim
      }),
    },
  }
}
