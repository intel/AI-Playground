import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type {
  ChannelArgs,
  ChannelResult,
  InvokeChannelName,
  IpcFail,
  PushChannelName,
  PushPayload,
  SendChannelName,
} from '@/types/ipcChannels'

export type InvokeHandler<N extends InvokeChannelName> = (
  event: IpcMainInvokeEvent,
  ...args: ChannelArgs<N>
) => ChannelResult<N> | Promise<ChannelResult<N>>

export function typedHandle<N extends InvokeChannelName>(
  channel: N,
  handler: InvokeHandler<N>,
): void {
  ipcMain.handle(channel, handler as never)
}

export type SendHandler<N extends SendChannelName> = (
  event: IpcMainEvent,
  ...args: ChannelArgs<N>
) => void

export function typedOn<N extends SendChannelName>(channel: N, listener: SendHandler<N>): void {
  ipcMain.on(channel, listener as never)
}

export function typedSend<N extends PushChannelName>(
  sender: WebContents,
  channel: N,
  payload: PushPayload<N>,
): void {
  sender.send(channel, payload)
}

export const ipcErrorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const ipcFail = (e: unknown): IpcFail => ({ success: false, error: ipcErrorText(e) })
