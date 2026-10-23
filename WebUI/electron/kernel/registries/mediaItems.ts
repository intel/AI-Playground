import type { MediaItemsInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import { ipcErrorText, ipcFail } from '../typedIpc'
import type {
  bootstrapMediaItems,
  deleteMediaItemRecords,
  migrateLegacyMediaItems,
  saveMediaItems,
} from '../../persist/mediaItemFiles'

/** The one-writer gallery-record operations the four mediaItems handlers close over. */
export type MediaItemsDeps = {
  bootstrapMediaItems: typeof bootstrapMediaItems
  migrateLegacyMediaItems: typeof migrateLegacyMediaItems
  saveMediaItems: typeof saveMediaItems
  deleteMediaItemRecords: typeof deleteMediaItemRecords
}

export function buildMediaItemsRegistry(deps: MediaItemsDeps) {
  // Generated-media gallery records (step 8, §6.1): same one-writer contract
  // as the conversations and agent sessions — one JSON per item plus an
  // ordered index inside `media/records/`, beside the media files themselves.
  return {
    'mediaItems:bootstrap': async () => {
      try {
        return await deps.bootstrapMediaItems()
      } catch (e) {
        return { status: 'error' as const, error: ipcErrorText(e) }
      }
    },

    'mediaItems:migrate': async (_event, payload) => {
      try {
        if (!Array.isArray(payload)) throw new Error('legacy media items payload must be an array')
        return await deps.migrateLegacyMediaItems(payload)
      } catch (e) {
        return { status: 'error' as const, error: ipcErrorText(e) }
      }
    },

    'mediaItems:save': async (_event, payload) => {
      try {
        if (!Array.isArray(payload)) throw new Error('media items payload must be an array')
        await deps.saveMediaItems(payload)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },

    'mediaItems:delete': async (_event, ids) => {
      try {
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
          throw new Error('media item ids payload must be an array of strings')
        }
        return await deps.deleteMediaItemRecords(ids)
      } catch (e) {
        return ipcFail(e)
      }
    },
  } satisfies InvokeHandlerMap<MediaItemsInvokeName>
}
