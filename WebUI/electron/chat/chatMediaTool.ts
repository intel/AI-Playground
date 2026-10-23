import type { ModelMessage } from 'ai'
import { findSourceImage } from '@/lib/findSourceImage'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { condenseMediaAgentRun, slimCondensedMedia } from '@/lib/mediaAgentResult'
import type { ChatModelConfig, MediaAgentCatalog } from '@/types/chatIpc'
import { runMediaAgentInMain } from './mediaAgentRunner'

/** Converts a conversation image ref into the data URI the specialist prepends. */
async function toDataUri(
  url: string,
  readMediaAsDataUri: (url: string) => Promise<string>,
): Promise<string> {
  if (url.startsWith('data:')) return url
  return await readMediaAsDataUri(url)
}

/**
 * Parent Chat `media` tool, in-process (same cut as Agent Mode's
 * `mediaDelegation.ts`). The renderer ships the catalog on the turn; this
 * condenses the specialist result so the UI stream and the parent model both
 * see the produced images instead of a renderer-bridge `output: null`.
 */
export async function executeChatMediaTool(options: {
  input: unknown
  toolCallId: string
  conversationKey: string
  messages?: ModelMessage[]
  abortSignal?: AbortSignal
  catalog: MediaAgentCatalog
  model: ChatModelConfig
  keepModelsLoaded: boolean
  readMediaAsDataUri: (url: string) => Promise<string>
}): Promise<Record<string, unknown>> {
  const request =
    typeof options.input === 'object' &&
    options.input !== null &&
    typeof (options.input as { request?: unknown }).request === 'string'
      ? (options.input as { request: string }).request
      : ''
  const found = findSourceImage(options.messages ?? []) ?? undefined
  const sourceImage = found ? await toDataUri(found, options.readMediaAsDataUri) : undefined
  const raw = await runMediaAgentInMain(
    {
      runKey: options.toolCallId,
      conversationKey: options.conversationKey,
      request,
      ...(sourceImage !== undefined ? { sourceImage } : {}),
      system: options.catalog.system,
      toolSpecs: options.catalog.toolSpecs,
      repairData: options.catalog.repairData,
      keepModelsLoaded: options.keepModelsLoaded,
      model: options.model,
      readMediaAsDataUri: options.readMediaAsDataUri,
    },
    options.abortSignal,
  )
  const condensed = cloneForIpc(slimCondensedMedia(condenseMediaAgentRun(raw)))
  console.info(
    `[media] condensed ${Array.isArray(condensed.images) ? condensed.images.length : 0} image(s)`,
  )
  return condensed
}
