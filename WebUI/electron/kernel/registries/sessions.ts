import type { InvokeHandlerMap, SessionsInvokeName } from '../ipcRegistries'
import { ipcFail } from '../typedIpc'
import type { recordAudioTurn } from '../../session/sessionAudioTurn'
import {
  ArtifactMediaTypeSchema,
  AudioTurnRequestSchema,
  HarnessGameWorkspaceSchema,
} from '@/types/sessionIpc'
import type {
  createSession,
  deleteSession,
  listSessions,
  openSession,
  renameSession,
} from '../../session/sessions'
import type {
  deleteArtifact,
  listAllArtifacts,
  missingArtifactUrls,
  newestArtifact,
} from '../../session/sessionArtifacts'
import type { harnessSessionFor } from '../../session/sessionHarness'
import type { upsertTimelineMessages } from '../../session/sessionTimeline'
import type { readSessionSettings, writePresetSettings } from '../../session/sessionSettings'
import { PresetSessionSettingsSchema } from '@/types/sessionSettings'

export type SessionsDeps = {
  listSessions: typeof listSessions
  createSession: typeof createSession
  openSession: typeof openSession
  renameSession: typeof renameSession
  deleteSession: typeof deleteSession
  recordAudioTurn: typeof recordAudioTurn
  listAllArtifacts: typeof listAllArtifacts
  missingArtifactUrls: typeof missingArtifactUrls
  deleteArtifact: typeof deleteArtifact
  readSessionSettings: typeof readSessionSettings
  writePresetSettings: typeof writePresetSettings
  newestArtifact: typeof newestArtifact
  harnessSessionFor: typeof harnessSessionFor
  upsertTimelineMessages: typeof upsertTimelineMessages
}

function timelineMessages(value: unknown): { id: string }[] {
  if (!Array.isArray(value)) throw new Error('timeline messages must be an array')
  for (const message of value) {
    if (typeof (message as { id?: unknown } | null)?.id !== 'string') {
      throw new Error('every timeline message needs an id')
    }
  }
  return value as { id: string }[]
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
        const sessionId = requireString(id, 'session id')
        const [session, missingFiles] = await Promise.all([
          deps.openSession(sessionId),
          deps.missingArtifactUrls(sessionId),
        ])
        return { success: true as const, session, missingFiles }
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
    'sessions:harnessSession': async (_event, id, presetName, game) => {
      try {
        const harness = await deps.harnessSessionFor(
          requireString(id, 'session id'),
          requireString(presetName, 'preset name'),
          game === undefined ? undefined : HarnessGameWorkspaceSchema.parse(game),
        )
        return { success: true as const, harness }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:saveTimelineMessages': async (_event, id, messages) => {
      try {
        await deps.upsertTimelineMessages(
          requireString(id, 'session id'),
          timelineMessages(messages),
        )
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
    'sessions:listArtifacts': async () => {
      try {
        return { success: true as const, artifacts: await deps.listAllArtifacts() }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:deleteArtifact': async (_event, id, relativePath) => {
      try {
        await deps.deleteArtifact(
          requireString(id, 'session id'),
          requireString(relativePath, 'artifact path'),
        )
        return { success: true as const }
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
    'sessions:newestArtifact': async (_event, id, mediaType) => {
      try {
        const artifact = await deps.newestArtifact(
          requireString(id, 'session id'),
          ArtifactMediaTypeSchema.parse(mediaType),
        )
        return { success: true as const, artifact }
      } catch (e) {
        return ipcFail(e)
      }
    },
  } satisfies InvokeHandlerMap<SessionsInvokeName>
}
