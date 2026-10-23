/**
 * Home Agent channel IPC: the inbound message shape `channel:poll` answers.
 * The `channel:*` handlers are registered by the Home Agent backend service
 * (`homeAgentBackendService.registerIpcHandlers`), so they exist only while
 * that service is installed.
 */

import type { RemoteAudio, RemoteDocument, RemoteImage } from '@/assets/js/store/channels/types'

/** One message drained from a channel platform's inbound queue. */
export type HomeAgentInboundMessage = {
  text?: string
  chat_id: string
  channel?: string
  ts?: string
  images?: RemoteImage[]
  audio?: RemoteAudio[]
  documents?: RemoteDocument[]
  callback?: string
}
