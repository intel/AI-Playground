import type { BrowserWindow } from 'electron'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { setToolBridgeWindow, submitAgentToolResult } from './piCustomTools.ts'
import { listCapabilities, type CapabilityInfo } from './capabilities/index.ts'
import type { AgentToolSpec } from '@/types/agentIpc'
import { piAgentDir } from './piSessionStore.ts'
import { setMainWin, currentTurn } from './piAgentState.ts'
import {
  cancelAgentTurn,
  deleteAgentSession,
  resetAgentSession,
  shutdownAgentMode,
  startAgentTurn,
} from './piTurnRunner.ts'

// ── Agent Mode: Pi coding agent in the Electron main process ─────────────────
//
// Holds at most ONE live Pi `AgentSession`, keyed by the renderer-minted session
// id (one per archived conversation). The session is long-lived: it survives
// across turns and is only rebuilt when the conversation, workspace, model or
// tool set changes. Pi persists the transcript to its own session file on every
// message, so restart survival is just remembering that file path per session.
//
// The renderer consumes a standard AI SDK UI message stream, so this module
// subscribes to Pi's event stream and pushes translated chunks over IPC (see
// piStreamTranslate.ts). File and shell access is sandboxed to the selected
// workspace folder by default, with a per-workspace opt-in for the real host
// shell (see piToolOperations.ts).
//
// Model routing: both sources are registered as Pi providers at runtime.
// 'local' points at the local llamacpp/openvino OpenAI-compatible endpoint;
// 'cloud' points at the provider's own OpenAI-compatible base. The API key is
// read in main at registration and stays off the renderer turn payload.
//
// Implementation is split across sibling modules: session pointer + Pi dirs
// (piSessionStore), model registration (piModelRuntime), live session pointer
// (piAgentState), session build/reuse (piSessionLifecycle), and turn execution
// (piTurnRunner). This file is the public API those modules are reached through.

export function setAgentModeMainWindow(win: BrowserWindow): void {
  setMainWin(win)
  setToolBridgeWindow(win)
}

/** Whether main is mid-agent-turn — input to the hidden-window close policy. */
export function isAgentTurnActive(): boolean {
  return currentTurn !== null
}

/**
 * What the agent could do in a session built right now, for the settings UI.
 * Comes from the same catalog the session build uses, so the checkboxes cannot
 * drift from what the agent actually gets — including which capabilities are
 * unavailable and why.
 */
export function listAgentCapabilities(options: {
  workspaceDir?: string
  toolSpecs?: AgentToolSpec[]
  mcpServerIds?: string[]
  embeddingModel?: string
}): CapabilityInfo[] {
  return listCapabilities(
    {
      sessionId: 'capability-listing',
      workspaceDir: options.workspaceDir ?? '',
      toolSpecs: options.toolSpecs ?? [],
      agentDir: piAgentDir(),
      keepModelsLoaded: false,
      ...(options.embeddingModel ? { embeddingModel: options.embeddingModel } : {}),
    },
    options.mcpServerIds ?? [],
  )
}

export {
  startAgentTurn,
  cancelAgentTurn,
  resetAgentSession,
  shutdownAgentMode,
  deleteAgentSession,
  submitAgentToolResult,
}

export { COMPACTION_TOOL_NAME } from './piStreamTranslate.ts'
export type { ToolDefinition }
