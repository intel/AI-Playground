import { NoSuchToolError, tool, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import { z } from 'zod'
import { comfyUI, getAvailableWorkflows, repairCreateToolInput } from '../tools/comfyUi'
import {
  comfyUiImageEdit,
  executeImageEdit,
  getAvailableEditWorkflows,
  repairEditToolInput,
} from '../tools/comfyUiImageEdit'
import { useTextInference } from '../store/textInference'
import { useMediaAgentRuns } from '../store/mediaAgentRuns'
import type { MediaItem } from '../store/imageGenerationPresets'
import { imageUrlToDataUri } from '@/lib/utils'
import { chatTraceContext } from '@/lib/chatModel'
import { noteChatTraceContext } from '@/lib/laminarTelemetry'
import {
  createToolAgent,
  type ToolAgentEvent,
  type ToolAgentRunOptions,
  type ToolAgentStep,
} from './toolAgent'

// ── Media agent ───────────────────────────────────────────────────────────────
//
// The nested "media specialist": it owns the two heavy ComfyUI tools (whose
// descriptions carry the live workflow catalog, preset guidance and resolution
// rules — 1-2k tokens) and runs a short tool loop on the SAME model/endpoint
// as the parent conversation. The parent only sees the thin `media` tool and
// this agent's condensed result, so the catalog, tool schemas and intermediate
// tool payloads never enter (or pollute) the parent context.
//
// Chaining (e.g. "generate a castle image, then turn it into a 3D model")
// works through the nested conversation itself: comfyUiImageEdit discovers its
// source image from the message history, where the previous comfyUI tool
// result (with its aipg-media:// URL) already lives. A parent-provided source
// image (chat conversation image, or an Agent Mode workspace file) is injected
// as a leading user message carrying the image, so it acts as the fallback
// source when this run has not produced anything yet.

/** Comfy-shaped media entry (same wire shape the comfy tools return). */
export const MediaAgentMediaSchema = z
  .object({
    id: z.string(),
    type: z.enum(['image', 'video', 'model3d']),
    imageUrl: z.string().optional(),
    videoUrl: z.string().optional(),
    model3dUrl: z.string().optional(),
    mode: z.string(),
    settings: z.record(z.string(), z.unknown()),
  })
  .passthrough()

export type MediaAgentMedia = z.infer<typeof MediaAgentMediaSchema>

export type MediaAgentResult = {
  /** All media produced across the run, in creation order ("images" to match the comfy tool result shape consumed by the UI and the workspace saver). */
  images: MediaAgentMedia[]
  /** One human-readable line per inner tool call. */
  steps: string[]
  /** The specialist's own closing report. */
  summary: string
  success?: boolean
  message?: string
}

export type MediaAgentOptions = {
  /** The delegated request, verbatim. */
  request: string
  /**
   * Optional source image for transform requests: a data URI or an
   * aipg-media:// URL. Used when the run itself has not generated one yet.
   */
  sourceImage?: string
  model: LanguageModel
  abortSignal?: AbortSignal
  /**
   * Delegating tool call id. When set, the run reports live progress to the
   * mediaAgentRuns store so the UI can show a timeline while this call is
   * still pending.
   */
  runId?: string
}

const MEDIA_AGENT_SYSTEM = [
  'You are the media specialist of AI Playground. You receive one delegated media request,',
  'fulfill it with your tools, and report back. Do not ask questions — make sensible choices.',
  '',
  '- Use comfyUI to create images or videos from a text prompt.',
  '- Use comfyUiImageEdit to transform the most recent image: edit it, animate it into a video,',
  '  or convert it into a 3D model. The most recent image (generated earlier in this',
  '  conversation, or provided with the request) is picked up as the source automatically.',
  '- Chain tools when the request needs it, e.g. first generate an image with comfyUI, then',
  '  convert that image with comfyUiImageEdit.',
  '- Expand terse prompts into detailed, high-quality generation prompts (subject, composition,',
  '  style, lighting, mood, quality tags).',
  '- If a tool call fails with an actionable error, correct the parameters and retry once;',
  '  otherwise stop and report the failure.',
  '- When done, reply with a short plain-text report of what you created and which workflows',
  '  you used. Do not include URLs, file paths or markdown images — they are delivered',
  '  separately.',
].join('\n')

function dataUriMessage(dataUri: string): ModelMessage {
  const mediaType = /^data:(image\/[a-z+.-]+);/i.exec(dataUri)?.[1] ?? 'image/png'
  return {
    role: 'user',
    content: [{ type: 'file', mediaType, data: dataUri }],
  }
}

/**
 * Inner tool set. Reuses the real chat tools under their original names —
 * comfyUiImageEdit's source-image discovery keys off those names in the
 * nested message history. Respects the same user gating as chat
 * (per-tool toggles + per-workflow sub-checkboxes).
 */
function buildMediaAgentTools(sourceMessage: ModelMessage | null): ToolSet {
  const textInference = useTextInference()
  const tools: ToolSet = {}
  if (textInference.isBuiltinToolEnabled('comfyUI') && getAvailableWorkflows().length > 0) {
    tools.comfyUI = comfyUI
  }
  if (
    textInference.isBuiltinToolEnabled('comfyUiImageEdit') &&
    getAvailableEditWorkflows().length > 0
  ) {
    // Same contract as the chat tool, but the source-image search space is the
    // NESTED history plus the parent-provided source message (prepended, so
    // media produced later in this run wins the backwards search).
    tools.comfyUiImageEdit = tool({
      description: comfyUiImageEdit.description,
      inputSchema: comfyUiImageEdit.inputSchema,
      outputSchema: comfyUiImageEdit.outputSchema,
      execute: async (args, options) => {
        const history = (options?.messages ?? []) as ModelMessage[]
        const messages = sourceMessage ? [sourceMessage, ...history] : history
        return await executeImageEdit(args as Parameters<typeof executeImageEdit>[0], messages)
      },
    })
  }
  return tools
}

const repairToolCall: NonNullable<ToolAgentRunOptions['repairToolCall']> = async ({
  toolCall,
  error,
}) => {
  if (NoSuchToolError.isInstance(error)) return null
  const repaired =
    toolCall.toolName === 'comfyUiImageEdit'
      ? repairEditToolInput(toolCall.input)
      : toolCall.toolName === 'comfyUI'
        ? repairCreateToolInput(toolCall.input)
        : null
  if (repaired === null) return null
  return { ...toolCall, input: repaired }
}

/** Media entries out of one inner tool output (comfy result shape). */
function mediaOf(output: unknown): MediaAgentMedia[] {
  if (typeof output !== 'object' || output === null) return []
  const images = (output as { images?: unknown }).images
  if (!Array.isArray(images)) return []
  return images.filter((item): item is MediaAgentMedia => {
    if (typeof item !== 'object' || item === null) return false
    const media = item as Record<string, unknown>
    const url = media.imageUrl ?? media.videoUrl ?? media.model3dUrl
    return typeof url === 'string' && url !== ''
  })
}

/** Comfy-shaped entries carry everything a MediaItem needs except its state. */
function toMediaItems(media: MediaAgentMedia[]): MediaItem[] {
  return media.map((item) => ({ ...item, state: 'done' }) as MediaItem)
}

/** Row title inputs for the timeline: which workflow, and with what prompt. */
function stepDescriptor(input: unknown): { workflow?: string; prompt?: string } {
  const record = (input ?? {}) as Record<string, unknown>
  return {
    workflow: typeof record.workflow === 'string' ? record.workflow : undefined,
    prompt: typeof record.prompt === 'string' ? record.prompt : undefined,
  }
}

/** Translates the generic tool agent events into mediaAgentRuns store updates. */
function progressReporter(runId: string): (event: ToolAgentEvent) => void {
  const mediaRuns = useMediaAgentRuns()
  return (event) => {
    switch (event.type) {
      case 'phase':
        mediaRuns.setPhase(runId, event.phase)
        break
      case 'narration-delta':
        mediaRuns.appendNarration(runId, event.text)
        break
      case 'tool-start':
        mediaRuns.beginStep(runId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...stepDescriptor(event.input),
          label: 'Starting…',
        })
        break
      case 'tool-finish': {
        const output = (event.output ?? {}) as { success?: boolean; message?: string }
        mediaRuns.endStep(runId, {
          toolCallId: event.toolCallId,
          media: toMediaItems(mediaOf(event.output)),
          error: event.error ?? (output.success === false ? output.message : undefined),
        })
        break
      }
    }
  }
}

function describeStep(step: ToolAgentStep): string {
  const input = (step.input ?? {}) as Record<string, unknown>
  const workflow = typeof input.workflow === 'string' ? input.workflow : 'default workflow'
  const output = (step.output ?? {}) as Record<string, unknown>
  if (output.success === false) {
    return `${step.toolName} (${workflow}): failed — ${output.message ?? 'unknown error'}`
  }
  const produced = mediaOf(step.output)
  const kinds = produced.map((m) => m.type).join(', ')
  return `${step.toolName} (${workflow}): produced ${produced.length || 'no'} ${kinds || 'media'}`
}

export async function runMediaAgent(options: MediaAgentOptions): Promise<MediaAgentResult> {
  // Normalize the parent-provided source (aipg-media:// or data URI) into the
  // data-URI message the inner edit tool understands.
  const sourceMessage = options.sourceImage
    ? dataUriMessage(await imageUrlToDataUri(options.sourceImage))
    : null

  const agent = createToolAgent({
    name: 'mediaAgent',
    system: () => MEDIA_AGENT_SYSTEM,
    tools: () => buildMediaAgentTools(sourceMessage),
    maxSteps: 6,
  })

  const runId = options.runId
  const mediaRuns = useMediaAgentRuns()
  if (runId) mediaRuns.beginRun(runId, options.request)

  // This run's model calls are the parent's model calls in every way that
  // matters to a trace — same backend, same device, same thinking setup — but
  // the chat store is not the one making them, so they carry no context unless
  // it is sent here. `delegated` also tells main these spans belong inside the
  // media tool call the parent turn has open, rather than in a trace of their
  // own. No-op unless a developer opted into tracing.
  noteChatTraceContext({ ...chatTraceContext(), delegated: true })

  let result: MediaAgentResult
  try {
    const { text, steps } = await agent.run({
      model: options.model,
      request: options.request,
      abortSignal: options.abortSignal,
      repairToolCall,
      onEvent: runId ? progressReporter(runId) : undefined,
    })

    const images = steps.flatMap((step) => mediaOf(step.output))
    const failures = steps
      .map((step) => (step.output as { success?: boolean; message?: string } | null) ?? {})
      .filter((output) => output.success === false)
    const summary = text.trim() || (images.length > 0 ? 'Media generated.' : 'No media generated.')

    result =
      images.length === 0
        ? {
            images: [],
            steps: steps.map(describeStep),
            summary,
            success: false,
            message: failures.at(-1)?.message ?? summary,
          }
        : { images, steps: steps.map(describeStep), summary }
  } catch (error) {
    // A throw (or abort) must settle the run too, or the timeline keeps
    // spinning for the rest of the session.
    if (runId) mediaRuns.endRun(runId, 'failed')
    throw error
  }
  if (runId) mediaRuns.endRun(runId, result.success === false ? 'failed' : 'done')
  return result
}

// Re-exported so callers (agent bridge) can pre-flight without running a turn.
export function mediaAgentHasTools(): boolean {
  const textInference = useTextInference()
  return (
    (textInference.isBuiltinToolEnabled('comfyUI') && getAvailableWorkflows().length > 0) ||
    (textInference.isBuiltinToolEnabled('comfyUiImageEdit') &&
      getAvailableEditWorkflows().length > 0)
  )
}
