import type { ModelMessage } from 'ai'
import { findSourceImage } from '@/lib/findSourceImage'
import type { ArtifactRunOwner } from '@/types/kernelEvents'
import { runInProcessComfyTool, type InProcessComfyArgs } from '../artifact/inProcessComfy'

// Chat (and the nested specialist) `comfyUI` / `comfyUiImageEdit` execute
// in-process against the Artifact runner — same cut as Agent Mode's
// generateImage / editImage. Origin is renderer when a Chat conversation owns
// the run (gallery persistence), agent otherwise. It is stated rather than derived
// from `conversationKey`: an agent turn supplies that key too, as the GPU
// window's nesting key.

const NO_SOURCE = 'No image found in conversation. Please upload an image or generate one first.'

export async function executeChatComfyTool(options: {
  toolName: string
  input: unknown
  messages?: ModelMessage[]
  abortSignal?: AbortSignal
  origin?: 'renderer' | 'agent'
  owner?: ArtifactRunOwner
  conversationKey?: string
  keepModelsLoaded: boolean
  defaultWorkflow?: string
  readMediaAsDataUri?: (url: string) => Promise<string>
}): Promise<Record<string, unknown>> {
  const isEdit = options.toolName === 'comfyUiImageEdit'
  let source = isEdit ? (findSourceImage(options.messages ?? []) ?? undefined) : undefined
  if (isEdit && !source) {
    return { success: false, message: NO_SOURCE, images: [] }
  }
  if (source && options.readMediaAsDataUri && !source.startsWith('data:')) {
    source = await options.readMediaAsDataUri(source)
  }
  return await runInProcessComfyTool({
    kind: isEdit ? 'edit' : 'create',
    args: {
      ...((options.input ?? {}) as InProcessComfyArgs),
      ...(options.defaultWorkflow ? { defaultWorkflow: options.defaultWorkflow } : {}),
    },
    source,
    origin: options.origin ?? (options.conversationKey ? 'renderer' : 'agent'),
    owner: options.owner,
    conversationKey: options.conversationKey,
    keepModelsLoaded: options.keepModelsLoaded,
    signal: options.abortSignal,
  })
}
