import type { InvokeHandlerMap, SessionsInvokeName } from '../ipcRegistries'
import { ipcFail } from '../typedIpc'
import type { recordAudioTurn } from '../../session/sessionAudioTurn'
import type { lastTurnPreset } from '../../session/sessionHistory'
import {
  SESSION_BUSY_MESSAGE,
  type claimSessionTurn,
  type releaseSessionTurn,
} from '../../session/sessionTurns'
import {
  ArtifactMediaTypeSchema,
  AudioTurnRequestSchema,
  HarnessGameWorkspaceSchema,
  SessionTurnSchema,
} from '@/types/sessionIpc'
import type {
  createSession,
  createSessionGroup,
  deleteSession,
  listSessionGroups,
  listSessions,
  moveSessionToGroup,
  openSession,
  pinSession,
  renameSession,
} from '../../session/sessions'
import type {
  deleteArtifact,
  listAllArtifacts,
  missingArtifactUrls,
  newestArtifact,
} from '../../session/sessionArtifacts'
import type { harnessSessionFor } from '../../session/sessionHarness'
import type { taskRunHarnessFor } from '../../session/sessionTaskRuns'
import type { upsertTimelineMessages } from '../../session/sessionTimeline'
import type { ChatTranscriptMessage, saveChatTranscript } from '../../session/sessionChatTurn'
import type { readSessionSettings, writePresetSettings } from '../../session/sessionSettings'
import { PresetSessionSettingsSchema } from '@/types/sessionSettings'

export type SessionsDeps = {
  listSessions: typeof listSessions
  createSession: typeof createSession
  openSession: typeof openSession
  renameSession: typeof renameSession
  pinSession: typeof pinSession
  listSessionGroups: typeof listSessionGroups
  createSessionGroup: typeof createSessionGroup
  moveSessionToGroup: typeof moveSessionToGroup
  deleteSession: typeof deleteSession
  recordAudioTurn: typeof recordAudioTurn
  listAllArtifacts: typeof listAllArtifacts
  missingArtifactUrls: typeof missingArtifactUrls
  deleteArtifact: typeof deleteArtifact
  readSessionSettings: typeof readSessionSettings
  writePresetSettings: typeof writePresetSettings
  newestArtifact: typeof newestArtifact
  harnessSessionFor: typeof harnessSessionFor
  taskRunHarnessFor: typeof taskRunHarnessFor
  upsertTimelineMessages: typeof upsertTimelineMessages
  lastTurnPreset: typeof lastTurnPreset
  claimSessionTurn: typeof claimSessionTurn
  releaseSessionTurn: typeof releaseSessionTurn
  saveChatTranscript: typeof saveChatTranscript
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
        const [sessions, groups] = await Promise.all([
          deps.listSessions(),
          deps.listSessionGroups(),
        ])
        return { success: true as const, sessions, groups }
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
        const [session, missingFiles, lastPreset] = await Promise.all([
          deps.openSession(sessionId),
          deps.missingArtifactUrls(sessionId),
          deps.lastTurnPreset(sessionId),
        ])
        return { success: true as const, session, missingFiles, lastPreset }
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
    'sessions:pin': async (_event, id, pinned) => {
      try {
        if (typeof pinned !== 'boolean') throw new Error('pinned must be a boolean')
        const session = await deps.pinSession(requireString(id, 'session id'), pinned)
        return { success: true as const, session }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:createGroup': async (_event, id, name) => {
      try {
        const created = await deps.createSessionGroup(
          requireString(id, 'session id'),
          requireString(name, 'group name'),
        )
        return { success: true as const, ...created }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:moveToGroup': async (_event, id, groupId) => {
      try {
        const session = await deps.moveSessionToGroup(
          requireString(id, 'session id'),
          groupId === null ? null : requireString(groupId, 'group id'),
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
    'sessions:taskRunHarness': async (_event, id) => {
      try {
        const harness = await deps.taskRunHarnessFor(requireString(id, 'session id'))
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
    'sessions:saveChatTranscript': async (_event, id, messages) => {
      try {
        await deps.saveChatTranscript(
          requireString(id, 'session id'),
          timelineMessages(messages) as ChatTranscriptMessage[],
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
    'sessions:beginTurn': async (_event, id, turn) => {
      try {
        const claimed = deps.claimSessionTurn(
          requireString(id, 'session id'),
          SessionTurnSchema.parse(turn),
        )
        return claimed
          ? { success: true as const }
          : { success: false as const, error: SESSION_BUSY_MESSAGE }
      } catch (e) {
        return ipcFail(e)
      }
    },
    'sessions:endTurn': async (_event, id, turnId) => {
      try {
        deps.releaseSessionTurn(requireString(id, 'session id'), requireString(turnId, 'turn id'))
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
