import { z } from 'zod'

/**
 * Wire shapes for the kernel-owned agent-session files (architecture-target
 * §6.1, step 8): one JSON per session under `AI-Playground/agent-sessions/`
 * plus an `index.json` with the entry list and the active session id. The
 * renderer's `AgentSessionRecord` (agentModeSessions.ts) is structurally the
 * same record; `messages` travels as an opaque array both ways.
 */

export const AgentSessionFileSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  workspaceDir: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  capabilities: z.array(z.string()).optional(),
  presetName: z.string().optional(),
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
