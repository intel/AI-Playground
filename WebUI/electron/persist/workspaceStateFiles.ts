import fs from 'node:fs/promises'
import { appLoggerInstance } from '../observability/logger'
import { getAgentWorkspaceDemoFile, getAgentWorkspaceFile } from './userDataPaths.ts'
import { AgentWorkspaceFileSchema, AgentWorkspaceStateSchema } from '@/types/agentWorkspaceIpc'
import { atomicWriteJson, makeWriteChains, readJson } from './fsJsonStore'

/**
 * The kernel's one-writer agent-workspace store (architecture-target §6.1,
 * step 8): `AI-Playground/agent-workspace.json` — the last-used workspace
 * pointers (current workspace, last workspace per kind) the agentMode store
 * projects. Same correctness contract as the other user-data stores: atomic
 * tmp+rename writes, schema validation on read, every mutation serialized on
 * one chain — the file is the unit.
 *
 * A missing file is the never-migrated state (section null). A corrupt or
 * schema-invalid file is a failed read — leftover must not replace it.
 * Write is the recovery path and replaces either.
 */

const appLogger = appLoggerInstance

const LOG_SCOPE = 'agent-workspace'

export type AgentWorkspaceFilesDeps = {
  isDemoMode: () => boolean
}

let agentWorkspaceFilesDeps: AgentWorkspaceFilesDeps | null = null

export function setAgentWorkspaceFilesDeps(deps: AgentWorkspaceFilesDeps): void {
  agentWorkspaceFilesDeps = deps
}

const { serialize, clear: clearChains } = makeWriteChains()

const FILE_CHAIN = 'file'

type WorkspaceState = { workspaceDir: string; lastWorkspaceByKind: Record<string, string> }

function workspaceFile(): string {
  return agentWorkspaceFilesDeps?.isDemoMode()
    ? getAgentWorkspaceDemoFile()
    : getAgentWorkspaceFile()
}

type InspectedFile =
  { status: 'missing' } | { status: 'ok'; state: WorkspaceState } | { status: 'unreadable' }

async function inspectFile(): Promise<InspectedFile> {
  const read = await readJson(workspaceFile(), LOG_SCOPE)
  if (read.status === 'missing') return { status: 'missing' }
  if (read.status === 'ok') {
    const parsed = AgentWorkspaceFileSchema.safeParse(read.value)
    if (parsed.success)
      return {
        status: 'ok',
        state: {
          workspaceDir: parsed.data.workspaceDir,
          lastWorkspaceByKind: parsed.data.lastWorkspaceByKind,
        },
      }
  }
  appLogger.warn('agent workspace file unreadable; not treated as absent', LOG_SCOPE)
  return { status: 'unreadable' }
}

function parseState(payload: unknown): WorkspaceState {
  const parsed = AgentWorkspaceStateSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error(
      'invalid agent workspace state: expected { workspaceDir: string, lastWorkspaceByKind: {...} }',
    )
  }
  return parsed.data
}

// ── Public API ────────────────────────────────────────────────────────────────

/** The section-shaped state; null when the file is absent. Throws when unreadable. */
export async function readAgentWorkspaceState(): Promise<WorkspaceState | null> {
  const inspected = await inspectFile()
  if (inspected.status === 'missing') return null
  if (inspected.status === 'ok') return inspected.state
  throw new Error('agent workspace file unreadable')
}

export async function writeAgentWorkspaceState(payload: unknown): Promise<void> {
  const state = parseState(payload)
  return serialize(FILE_CHAIN, async () => {
    const inspected = await inspectFile()
    const doc =
      inspected.status === 'ok' ? inspected.state : { workspaceDir: '', lastWorkspaceByKind: {} }
    doc.workspaceDir = state.workspaceDir
    doc.lastWorkspaceByKind = state.lastWorkspaceByKind
    await atomicWriteJson(workspaceFile(), { schemaVersion: 1, ...doc })
  })
}

/**
 * One-shot legacy upload (§6.1: "localStorage migrates once, do not
 * dual-write"): writes the payload only when the file is absent, so a
 * retried or racing migrate can never overwrite what the file already owns.
 * An unreadable file is owned, not absent — leftover must not replace it.
 */
export async function migrateAgentWorkspaceState(payload: unknown): Promise<boolean> {
  const state = parseState(payload)
  return serialize(FILE_CHAIN, async () => {
    const inspected = await inspectFile()
    if (inspected.status === 'ok') return false
    if (inspected.status === 'unreadable') {
      throw new Error('agent workspace file unreadable')
    }
    await atomicWriteJson(workspaceFile(), { schemaVersion: 1, ...state })
    return true
  })
}

/** §6.1: demo workspace state is session-scoped; wipe on exit (and on boot, for a crash tail). */
export async function wipeDemoAgentWorkspace(): Promise<void> {
  try {
    await fs.rm(getAgentWorkspaceDemoFile(), { force: true })
  } catch (error) {
    appLogger.warn(`demo agent workspace wipe failed: ${String(error)}`, LOG_SCOPE)
  }
}

export function resetAgentWorkspaceFilesForTest(): void {
  agentWorkspaceFilesDeps = null
  clearChains()
}
