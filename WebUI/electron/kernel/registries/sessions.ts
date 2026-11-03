import type { InvokeHandlerMap, SessionsInvokeName } from '../ipcRegistries'
import { ipcFail } from '../typedIpc'
import type { recordAudioTurn } from '../../session/sessionAudioTurn'
import { AudioTurnRequestSchema } from '@/types/sessionIpc'
import type {
  createSession,
  deleteSession,
  listSessions,
  openSession,
  renameSession,
} from '../../session/sessions'
import type { readSessionSettings, writePresetSettings } from '../../session/sessionSettings'
import { PresetSessionSettingsSchema } from '@/types/sessionSettings'

export type SessionsDeps = {
  listSessions: typeof listSessions
  createSession: typeof createSession
  openSession: typeof openSession
  renameSession: typeof renameSession
  deleteSession: typeof deleteSession
  recordAudioTurn: typeof recordAudioTurn
  readSessionSettings: typeof readSessionSettings
  writePresetSettings: typeof writePresetSettings
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} must be a string`)
  return value
}

export function buildSessionsRegistry(deps: SessionsDeps) {
  return {
    'sessions:list': async () => {
      try {
        return { success: true as const, sessions: await deps.listSessions() }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:create': async () => {
      try {
        return { success: true as const, session: await deps.createSession() }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:open': async (_event, id) => {
      try {
        return {
          success: true as const,
          session: await deps.openSession(requireString(id, 'session id')),
        }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:rename': async (_event, id, title) => {
      try {
        const session = await deps.renameSession(
          requireString(id, 'session id'),
          requireString(title, 'title'),
        )
        return { success: true as const, session }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:delete': async (_event, id) => {
      try {
        await deps.deleteSession(requireString(id, 'session id'))
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:recordAudioTurn': async (_event, turn) => {
      try {
        const session = await deps.recordAudioTurn(AudioTurnRequestSchema.parse(turn))
        return { success: true as const, session }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:readSettings': async (_event, id) => {
      try {
        return {
          success: true as const,
          settings: await deps.readSessionSettings(requireString(id, 'session id')),
        }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:writePresetSettings': async (_event, id, presetName, entry) => {
      try {
        await deps.writePresetSettings(
          requireString(id, 'session id'),
          requireString(presetName, 'preset name'),
          PresetSessionSettingsSchema.parse(entry),
        )
        return { success: true as const }
      } catch (e) {
        return ipcFail(e)
      }
    },
  } satisfies InvokeHandlerMap<SessionsInvokeName>
}
