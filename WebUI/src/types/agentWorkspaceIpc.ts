import { z } from 'zod'

/**
 * Wire shapes for the kernel-owned agent workspace state
 * (architecture-target §6.1, step 8): `AI-Playground/agent-workspace.json`
 * holds the last-used workspace pointers the agentMode store projects — the
 * current workspace and the last one per workspace kind. Its own file, not a
 * preferences section: the values are last-used app data (§6), and the file
 * stays small enough for a whole-file write per change.
 */

export const AgentWorkspaceFileSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceDir: z.string(),
  lastWorkspaceByKind: z.record(z.string(), z.string()),
})
export type AgentWorkspaceFile = z.infer<typeof AgentWorkspaceFileSchema>

/** The section-shaped payload the renderer store reads and writes. */
export const AgentWorkspaceStateSchema = z.object({
  workspaceDir: z.string(),
  lastWorkspaceByKind: z.record(z.string(), z.string()),
})
export type AgentWorkspaceState = z.infer<typeof AgentWorkspaceStateSchema>
