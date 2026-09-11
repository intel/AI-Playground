// Main-process pushes for Agent Mode. Registering at store setup used to stack
// a new ipcRenderer.on per Pinia HMR of agentMode.ts, so media tools could run
// twice. These helpers subscribe once and return the matching removeListener.

type AgentModeIpcHandlers = {
  onStreamChunk: (data: { turnId: string; chunk: unknown }) => void
  onToolProgress: (data: AgentToolProgress) => void
  onToolImage: (data: AgentToolImage) => void
  onTurnDone: (data: { turnId: string }) => void
  onExecuteTool: (data: AgentToolExecuteRequest) => void | Promise<void>
}

let disposers: Array<() => void> = []

export function registerAgentModeIpc(handlers: AgentModeIpcHandlers): void {
  if (disposers.length > 0) return
  const api = window.electronAPI?.agentMode
  if (!api) return
  disposers = [
    api.onStreamChunk(handlers.onStreamChunk),
    api.onToolProgress(handlers.onToolProgress),
    api.onToolImage(handlers.onToolImage),
    api.onTurnDone(handlers.onTurnDone),
    api.onExecuteTool(handlers.onExecuteTool),
  ].filter((dispose): dispose is () => void => typeof dispose === 'function')
}

export function unregisterAgentModeIpc(): void {
  for (const dispose of disposers) dispose()
  disposers = []
}
