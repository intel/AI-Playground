// Main-process pushes for Agent Mode. Registering at store setup used to stack
// a new ipcRenderer.on per Pinia HMR of agentMode.ts, so media tools could run
// twice. These helpers subscribe once and return the matching removeListener.
//
// The four notification channels ride the kernel event stream
// (projection/kernelProjection.ts); only executeTool stays point-to-point — it
// is a request the renderer answers, not a notification.

import { connectKernelEventStream } from '@/assets/js/projection/kernelProjection'
import type { KernelSnapshot } from '@/types/kernelEvents'

type AgentModeIpcHandlers = {
  onStreamChunk: (data: { turnId: string; chunk: unknown }) => void
  onToolProgress: (data: AgentToolProgress) => void
  onToolImage: (data: AgentToolImage) => void
  onTurnDone: (data: { turnId: string }) => void
  onExecuteTool: (data: AgentToolExecuteRequest) => void | Promise<void>
  /**
   * The kernel snapshot, at install time — before buffered events are applied.
   * This is where a renderer that (re)connected mid-turn adopts it.
   */
  onSnapshot: (snapshot: KernelSnapshot) => void
}

let disposers: Array<() => void> = []

export function registerAgentModeIpc(handlers: AgentModeIpcHandlers): void {
  if (disposers.length > 0) return
  const api = window.electronAPI?.agentMode
  if (!api) return
  const projection = connectKernelEventStream(
    (event) => {
      switch (event.type) {
        case 'agent-chunk':
          handlers.onStreamChunk({ turnId: event.turnId, chunk: event.chunk })
          break
        case 'agent-tool-progress':
          handlers.onToolProgress({
            turnId: event.turnId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            text: event.text,
          })
          break
        case 'agent-tool-image':
          handlers.onToolImage({
            toolCallId: event.toolCallId,
            dataUri: event.dataUri,
            label: event.label,
          })
          break
        case 'agent-turn-done':
          handlers.onTurnDone({ turnId: event.turnId })
          break
      }
    },
    (snapshot) => handlers.onSnapshot(snapshot),
  )
  disposers = [projection.dispose, api.onExecuteTool(handlers.onExecuteTool)].filter(
    (dispose): dispose is () => void => typeof dispose === 'function',
  )
}

export function unregisterAgentModeIpc(): void {
  for (const dispose of disposers) dispose()
  disposers = []
}
