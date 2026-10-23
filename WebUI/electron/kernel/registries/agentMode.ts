import { AgentModeTurnConfigSchema } from '@/types/agentIpc'
import { AgentSessionRecordSchema, LegacyAgentSessionStateSchema } from '@/types/agentSessionIpc'
import type { AgentModeInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import { ipcErrorText, ipcFail } from '../typedIpc'
import type {
  cancelAgentTurn,
  deleteAgentSession,
  listAgentCapabilities,
  resetAgentSession,
  startAgentTurn,
  submitAgentToolResult,
} from '../../agent/piAgentManager'
import type { importAttachment } from '../../agent/workspaceAttachments'
import type {
  bootstrapAgentSessions,
  deleteAgentSessionRecord,
  migrateLegacyAgentSessions,
  saveAgentSession,
  saveAgentSessionActiveId,
} from '../../persist/agentSessionFiles'
import type {
  migrateAgentWorkspaceState,
  readAgentWorkspaceState,
  writeAgentWorkspaceState,
} from '../../persist/workspaceStateFiles'

/** The Pi manager, session-record and workspace-state seams the fourteen agentMode handlers close over. */
export type AgentModeDeps = {
  startAgentTurn: typeof startAgentTurn
  cancelAgentTurn: typeof cancelAgentTurn
  resetAgentSession: typeof resetAgentSession
  deleteAgentSession: typeof deleteAgentSession
  submitAgentToolResult: typeof submitAgentToolResult
  listAgentCapabilities: typeof listAgentCapabilities
  importAttachment: typeof importAttachment
  bootstrapAgentSessions: typeof bootstrapAgentSessions
  migrateLegacyAgentSessions: typeof migrateLegacyAgentSessions
  saveAgentSession: typeof saveAgentSession
  saveAgentSessionActiveId: typeof saveAgentSessionActiveId
  deleteAgentSessionRecord: typeof deleteAgentSessionRecord
  readAgentWorkspaceState: typeof readAgentWorkspaceState
  migrateAgentWorkspaceState: typeof migrateAgentWorkspaceState
  writeAgentWorkspaceState: typeof writeAgentWorkspaceState
}

export function buildAgentModeRegistry(deps: AgentModeDeps) {
  // Agent Mode (Pi coding agent) — see agent/piAgentManager.ts. Stream chunks
  // and live tool output cross the kernel event bus (electron/kernel/kernelBus.ts)
  // as 'agent-chunk' / 'agent-tool-progress' / 'agent-tool-image' /
  // 'agent-turn-done' events.
  return {
    // Agent-session records (step 8, §6.1): same one-writer contract as the
    // conversations family — the record file and its index entry live here,
    // Pi's own session files stay with Pi. Deletes fold into
    // `agentMode:deleteSession`, next to the Pi-side teardown.
    'agentMode:bootstrapSessions': async () => {
      try {
        return await deps.bootstrapAgentSessions()
      } catch (e) {
        return { status: 'error' as const, error: ipcErrorText(e) }
      }
    },
    'agentMode:migrateSessions': async (_event, payload) => {
      try {
        return await deps.migrateLegacyAgentSessions(LegacyAgentSessionStateSchema.parse(payload))
      } catch (e) {
        return { status: 'error' as const, error: ipcErrorText(e) }
      }
    },
    'agentMode:saveSession': async (_event, payload) => {
      try {
        await deps.saveAgentSession(AgentSessionRecordSchema.parse(payload))
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:saveActiveSessionId': async (_event, id) => {
      try {
        if (typeof id !== 'string' && id !== null) {
          throw new Error('activeSessionId must be a string or null')
        }
        await deps.saveAgentSessionActiveId(id)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:startTurn': async (_event, turnId, prompt, config) => {
      const parsed = AgentModeTurnConfigSchema.safeParse(config)
      if (!parsed.success) {
        return { success: false, error: parsed.error.message }
      }
      return await deps.startAgentTurn(turnId, prompt, parsed.data)
    },
    'agentMode:cancel': () => {
      deps.cancelAgentTurn()
    },
    'agentMode:resetSession': async () => {
      await deps.resetAgentSession()
    },
    // Step 8 (§6.1): the last-used workspace pointers are kernel-owned
    // (agent-workspace.json); the store becomes a live projection.
    'agentMode:readWorkspaceState': async () => {
      try {
        return { success: true as const, section: await deps.readAgentWorkspaceState() }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:migrateWorkspaceState': async (_event, payload) => {
      try {
        await deps.migrateAgentWorkspaceState(payload)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:writeWorkspaceState': async (_event, value) => {
      try {
        await deps.writeAgentWorkspaceState(value)
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'agentMode:deleteSession': async (_event, sessionId) => {
      // Both halves run even if one fails. Invalid ids return `{success:false}`.
      try {
        if (typeof sessionId !== 'string') throw new Error('session id must be a string')
        const record = await deps.deleteAgentSessionRecord(sessionId)
        const live = await deps.deleteAgentSession(sessionId)
        if (!record.success) return record
        return live
      } catch (e) {
        return ipcFail(e)
      }
    },
    // Copy a file the user attached into the agent's workspace, so the agent can
    // reach it with its own file tools (see agent/workspaceAttachments.ts).
    'agentMode:importAttachment': (_event, workspaceDir, name, bytes) => {
      try {
        return { success: true as const, ...deps.importAttachment(workspaceDir, name, bytes) }
      } catch (error) {
        return ipcFail(error)
      }
    },
    // What the agent can be equipped with, for the Capabilities checkboxes in
    // Agent Settings (availability depends on the turn's tool specs / MCP config).
    'agentMode:listCapabilities': (_event, options) => {
      return deps.listAgentCapabilities(options ?? {})
    },
    // Renderer answers a main→renderer 'agentMode:executeTool' dispatch (bridged
    // host tool execution, e.g. image generation) with the tool result or error.
    'agentMode:toolResult': (_event, requestId, result, error) => {
      return deps.submitAgentToolResult(requestId, result, error)
    },
  } satisfies InvokeHandlerMap<AgentModeInvokeName>
}
