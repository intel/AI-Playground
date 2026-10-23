// Hidden-window lifecycle policy (docs/architecture-target.md §5.1).
//
// Main — never the renderer — decides whether closing the application window
// ends the app or merely hides it. Hiding keeps the renderer (and everything it
// drives today: chat turns, ComfyUI websocket runs, Home Agent setup) alive
// while the user is not looking; an explicit quit still tears everything down
// through the existing `before-quit` shutdown.
//
// The policy itself is a pure function so the decision table is unit-tested
// without an Electron app: every input is named, every combination is cheap to
// enumerate.

export type CloseDecision = 'hide' | 'close'

export type ClosePolicyInputs = {
  /** The Home Agent backend is installed and its channel server is running. */
  homeAgentRunning: boolean
  /** The renderer reported tracked work (an activity is in flight). */
  rendererBusy: boolean
  /** Main itself is running an agent turn (Pi session). */
  agentTurnActive: boolean
  /** Main itself is running a chat turn (`anyChatTurnActive`). */
  chatTurnActive: boolean
  /** An artifact run is admitted, executing, or queued. */
  artifactWorkOpen: boolean
}

/**
 * Closing the app window hides it while headless work would be orphaned by a
 * quit — a Home Agent serving channels, an in-flight agent/chat/artifact run,
 * or anything the renderer reported busy. Otherwise the normal close/quit
 * policy applies. Chat and artifact occupancy are main-owned: they must not
 * round-trip through `lifecycle:busy` (that flag clears when the renderer dies).
 */
export function resolveClosePolicy(inputs: ClosePolicyInputs): CloseDecision {
  const headlessWork =
    inputs.homeAgentRunning ||
    inputs.rendererBusy ||
    inputs.agentTurnActive ||
    inputs.chatTurnActive ||
    inputs.artifactWorkOpen
  return headlessWork ? 'hide' : 'close'
}

/** A crashed renderer must not leave `lifecycle:busy` stuck true (next close would hide). */
export function bindRendererBusyReset(
  webContents: { once: (event: 'destroyed', listener: () => void) => void },
  setBusy: (busy: boolean) => void,
): void {
  webContents.once('destroyed', () => setBusy(false))
}
