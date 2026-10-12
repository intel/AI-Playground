import type { ChannelManifest, InvokeChannelName, SendChannelName } from '@/types/ipcChannels'
import { typedHandle, typedOn, type InvokeHandler, type SendHandler } from './typedIpc'

// The registry seam (#301): per-owner handler maps whose exhaustiveness is
// structural — a missing handler or an unhandled new manifest row is a compile
// error. Kept beside typedIpc on the main-process side so the manifest file
// (imported by the renderer) stays free of `electron`-bearing types.

export type MainInvokeChannelName = {
  [K in InvokeChannelName]: ChannelManifest[K]['owner'] extends 'main' ? K : never
}[InvokeChannelName]

export type MainSendChannelName = {
  [K in SendChannelName]: ChannelManifest[K]['owner'] extends 'main' ? K : never
}[SendChannelName]

export type HomeAgentInvokeChannelName = {
  [K in InvokeChannelName]: ChannelManifest[K]['owner'] extends 'homeAgent' ? K : never
}[InvokeChannelName]

export type HomeAgentSendChannelName = {
  [K in SendChannelName]: ChannelManifest[K]['owner'] extends 'homeAgent' ? K : never
}[SendChannelName]

export type InvokeHandlerMap<Names extends InvokeChannelName> = {
  [N in Names]: InvokeHandler<N>
}

export type SendHandlerMap<Names extends SendChannelName> = {
  [N in Names]: SendHandler<N>
}

// A domain claims every main-owned channel under its `prefix:`. A new prefixed
// row lands in its domain's type (a missing handler there is the compile
// error); a new flat row or a new prefix lands in the Core complement below —
// coverage stays total with no combine step.

export type ConversationsInvokeName = Extract<MainInvokeChannelName, `conversations:${string}`>
export type ConversationsSendName = Extract<MainSendChannelName, `conversations:${string}`>
export type ChatInvokeName = Extract<MainInvokeChannelName, `chat:${string}`>
export type ChatSendName = Extract<MainSendChannelName, `chat:${string}`>
export type AgentModeInvokeName = Extract<MainInvokeChannelName, `agentMode:${string}`>
export type AgentModeSendName = Extract<MainSendChannelName, `agentMode:${string}`>
export type McpInvokeName = Extract<MainInvokeChannelName, `mcp:${string}`>
export type McpSendName = Extract<MainSendChannelName, `mcp:${string}`>
export type ComfyuiInvokeName = Extract<MainInvokeChannelName, `comfyui:${string}`>
export type ComfyuiSendName = Extract<MainSendChannelName, `comfyui:${string}`>
export type WebBrowserInvokeName = Extract<MainInvokeChannelName, `webBrowser:${string}`>
export type WebBrowserSendName = Extract<MainSendChannelName, `webBrowser:${string}`>
export type GamesInvokeName = Extract<MainInvokeChannelName, `games:${string}`>
export type GamesSendName = Extract<MainSendChannelName, `games:${string}`>
export type PermissionsInvokeName = Extract<MainInvokeChannelName, `permissions:${string}`>
export type PermissionsSendName = Extract<MainSendChannelName, `permissions:${string}`>
export type ScreenshotInvokeName = Extract<MainInvokeChannelName, `screenshot:${string}`>
export type ScreenshotSendName = Extract<MainSendChannelName, `screenshot:${string}`>
export type MediaItemsInvokeName = Extract<MainInvokeChannelName, `mediaItems:${string}`>
export type MediaItemsSendName = Extract<MainSendChannelName, `mediaItems:${string}`>
export type CloudProviderInvokeName = Extract<MainInvokeChannelName, `cloudProvider:${string}`>
export type CloudProviderSendName = Extract<MainSendChannelName, `cloudProvider:${string}`>
export type RagDocumentsInvokeName = Extract<MainInvokeChannelName, `ragDocuments:${string}`>
export type RagDocumentsSendName = Extract<MainSendChannelName, `ragDocuments:${string}`>
export type PreferencesInvokeName = Extract<MainInvokeChannelName, `preferences:${string}`>
export type PreferencesSendName = Extract<MainSendChannelName, `preferences:${string}`>
export type ArtifactInvokeName = Extract<MainInvokeChannelName, `artifact:${string}`>
export type ArtifactSendName = Extract<MainSendChannelName, `artifact:${string}`>
export type SafeStorageInvokeName = Extract<MainInvokeChannelName, `safeStorage:${string}`>
export type SafeStorageSendName = Extract<MainSendChannelName, `safeStorage:${string}`>
export type LifecycleInvokeName = Extract<MainInvokeChannelName, `lifecycle:${string}`>
export type LifecycleSendName = Extract<MainSendChannelName, `lifecycle:${string}`>
export type KernelInvokeName = Extract<MainInvokeChannelName, `kernel:${string}`>
export type KernelSendName = Extract<MainSendChannelName, `kernel:${string}`>
export type CameraCaptureInvokeName = Extract<MainInvokeChannelName, `cameraCapture:${string}`>
export type CameraCaptureSendName = Extract<MainSendChannelName, `cameraCapture:${string}`>

/** The core registry's names (batch D): every main channel no prefix domain claims. */
export type CoreInvokeName = Exclude<
  MainInvokeChannelName,
  | ConversationsInvokeName
  | ChatInvokeName
  | AgentModeInvokeName
  | McpInvokeName
  | ComfyuiInvokeName
  | WebBrowserInvokeName
  | GamesInvokeName
  | PermissionsInvokeName
  | ScreenshotInvokeName
  | MediaItemsInvokeName
  | CloudProviderInvokeName
  | RagDocumentsInvokeName
  | PreferencesInvokeName
  | ArtifactInvokeName
  | SafeStorageInvokeName
  | LifecycleInvokeName
  | KernelInvokeName
  | CameraCaptureInvokeName
>

export type CoreSendName = Exclude<
  MainSendChannelName,
  | ConversationsSendName
  | ChatSendName
  | AgentModeSendName
  | McpSendName
  | ComfyuiSendName
  | WebBrowserSendName
  | GamesSendName
  | PermissionsSendName
  | ScreenshotSendName
  | MediaItemsSendName
  | CloudProviderSendName
  | RagDocumentsSendName
  | PreferencesSendName
  | ArtifactSendName
  | SafeStorageSendName
  | LifecycleSendName
  | KernelSendName
  | CameraCaptureSendName
>

export function registerInvokeHandlers<Names extends InvokeChannelName>(
  registry: InvokeHandlerMap<Names>,
): void {
  for (const channel of Object.keys(registry) as Names[]) {
    typedHandle(channel, registry[channel])
  }
}

export function registerSendHandlers<Names extends SendChannelName>(
  registry: SendHandlerMap<Names>,
): void {
  for (const channel of Object.keys(registry) as Names[]) {
    typedOn(channel, registry[channel])
  }
}
