import { z } from 'zod'
import { llmBackendTypes } from './shared'

/**
 * Wire shapes for the kernel-owned agent-session files (architecture-target
 * §6.1, step 8): one JSON per session under `AI-Playground/agent-sessions/`
 * plus an `index.json` with the entry list and the active session id. The
 * renderer's `AgentSessionRecord` (agentModeSessions.ts) is structurally the
 * same record; `messages` travels as an opaque array both ways.
 */

/**
 * An Agent Session's own model and capability choices. Every field is optional so a
 * file written before a field existed still parses; the store fills gaps from the
 * Default Settings.
 */
export const AgentSessionSettingsSchema = z.object({
  backend: z.enum(llmBackendTypes).optional(),
  cloudProviderId: z.string().optional(),
  device: z.object({ id: z.string(), uuid: z.string().nullable().optional() }).optional(),
  model: z.string().optional(),
  contextSize: z.number().optional(),
  contextSizeEdited: z.boolean().optional(),
  thinkingEnabled: z.boolean().optional(),
  planningThinkingOnly: z.boolean().optional(),
  capabilities: z.array(z.string()).optional(),
  embeddingModel: z.string().optional(),
  toolDelegationEnabled: z.boolean().optional(),
  builtinToolEnablement: z.record(z.string(), z.boolean()).optional(),
  builtinToolPresetEnablement: z.record(z.string(), z.boolean()).optional(),
  builtinToolDefaultPresets: z.record(z.string(), z.string()).optional(),
})
export type AgentSessionSettings = z.infer<typeof AgentSessionSettingsSchema>

export const AgentTaskStepSchema = z.object({
  id: z.string(),
  prompt: z.string(),
})
export type AgentTaskStep = z.infer<typeof AgentTaskStepSchema>

export const AgentSessionFileSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  workspaceDir: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  capabilities: z.array(z.string()).optional(),
  presetName: z.string().optional(),
  responseLocale: z.string().optional(),
  settings: AgentSessionSettingsSchema.optional(),
  /** The Agent this session was loaded from or saved as. */
  taskId: z.string().optional(),
  /** The Steps a prompt is carried out in; edited in the settings panel like any setting. */
  steps: z.array(AgentTaskStepSchema).optional(),
  /** The Session this Harness Session belongs to. */
  sessionRef: z.string().optional(),
  /** Set when this Harness Session is one Task Run of its Session. */
  taskRun: z.object({ taskName: z.string(), startedAt: z.number() }).optional(),
  messages: z.array(z.unknown()),
})
export type AgentSessionFile = z.infer<typeof AgentSessionFileSchema>

export const AgentSessionRecordSchema = AgentSessionFileSchema.omit({ schemaVersion: true })
export type AgentSessionRecordWire = z.infer<typeof AgentSessionRecordSchema>

export const AgentSessionIndexEntrySchema = z.object({
  id: z.string(),
  updatedAt: z.number(),
})
export type AgentSessionIndexEntry = z.infer<typeof AgentSessionIndexEntrySchema>

export const AgentSessionIndexFileSchema = z.object({
  schemaVersion: z.literal(1),
  activeSessionId: z.string().nullable(),
  sessions: z.array(AgentSessionIndexEntrySchema),
})
export type AgentSessionIndexFile = z.infer<typeof AgentSessionIndexFileSchema>

/** The pre-step-8 Pinia-persisted payload, read once for the legacy upload. */
export const LegacyAgentSessionStateSchema = z.object({
  sessions: z.record(z.string(), z.unknown()),
  activeSessionId: z.string().nullable().optional(),
})
export type LegacyAgentSessionState = z.infer<typeof LegacyAgentSessionStateSchema>

export type AgentSessionBootstrap =
  | { status: 'empty' }
  | { status: 'ok'; activeSessionId: string | null; sessions: AgentSessionRecordWire[] }
