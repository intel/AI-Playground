import fs from 'node:fs/promises'
import { appLoggerInstance } from '../observability/logger'
import { getAgentTasksDemoFile, getAgentTasksFile } from './userDataPaths.ts'
import { AgentTaskSchema, AgentTasksFileSchema, type AgentTask } from '@/types/agentTaskIpc'
import { atomicWriteJson, makeWriteChains, readJson } from './fsJsonStore'

/**
 * The kernel's one-writer Tasks store: `AI-Playground/agent-tasks.json`, every saved
 * Task in one file. Unlike the workspace pointers, an unreadable file is never
 * replaced by a write — one upsert would otherwise erase every other Task.
 */

const appLogger = appLoggerInstance

const LOG_SCOPE = 'agent-tasks'

export type AgentTaskFilesDeps = {
  isDemoMode: () => boolean
}

let agentTaskFilesDeps: AgentTaskFilesDeps | null = null

export function setAgentTaskFilesDeps(deps: AgentTaskFilesDeps): void {
  agentTaskFilesDeps = deps
}

const { serialize, clear: clearChains } = makeWriteChains()

const FILE_CHAIN = 'file'

function tasksFile(): string {
  return agentTaskFilesDeps?.isDemoMode() ? getAgentTasksDemoFile() : getAgentTasksFile()
}

/**
 * OS close hides the window while this is true. Demo schedules and Tasks saved before
 * Sessions never count, and an unreadable file must not trap the app open.
 */
export async function agentTasksKeepAppAlive(): Promise<boolean> {
  if (agentTaskFilesDeps?.isDemoMode()) return false
  try {
    const tasks = await readAgentTasks()
    return tasks.some(
      (task) =>
        task.sessionRef !== undefined &&
        (task.schedule?.enabled === true || task.activeRun !== undefined),
    )
  } catch {
    return false
  }
}

/** Every saved Task; an absent file is none, an unreadable one throws. */
export async function readAgentTasks(): Promise<AgentTask[]> {
  const read = await readJson(tasksFile(), LOG_SCOPE)
  if (read.status === 'missing') return []
  if (read.status === 'ok') {
    const parsed = AgentTasksFileSchema.safeParse(read.value)
    if (parsed.success) return parsed.data.tasks
  }
  appLogger.warn('agent tasks file unreadable; not treated as absent', LOG_SCOPE)
  throw new Error('agent tasks file unreadable')
}

async function writeTasks(tasks: AgentTask[]): Promise<void> {
  await atomicWriteJson(tasksFile(), { schemaVersion: 1, tasks })
}

/** Insert a Task, or replace the one with the same id where it stands. */
export async function saveAgentTask(payload: unknown): Promise<void> {
  const parsed = AgentTaskSchema.safeParse(payload)
  if (!parsed.success) throw new Error(`invalid task: ${parsed.error.message}`)
  const task = parsed.data
  return serialize(FILE_CHAIN, async () => {
    const tasks = await readAgentTasks()
    const index = tasks.findIndex((entry) => entry.id === task.id)
    if (index >= 0) tasks[index] = task
    else tasks.push(task)
    await writeTasks(tasks)
  })
}

export async function deleteAgentTask(id: unknown): Promise<void> {
  if (typeof id !== 'string' || id.length === 0) throw new Error('task id must be a string')
  return serialize(FILE_CHAIN, async () => {
    const tasks = await readAgentTasks()
    const remaining = tasks.filter((entry) => entry.id !== id)
    if (remaining.length === tasks.length) return
    await writeTasks(remaining)
  })
}

/** A deleted Session takes its Tasks with it. */
export async function deleteAgentTasksOfSession(sessionRef: string): Promise<void> {
  return serialize(FILE_CHAIN, async () => {
    const tasks = await readAgentTasks()
    const remaining = tasks.filter((entry) => entry.sessionRef !== sessionRef)
    if (remaining.length === tasks.length) return
    await writeTasks(remaining)
  })
}

/** §6.1: demo Tasks are session-scoped; wipe on exit (and on boot, for a crash tail). */
export async function wipeDemoAgentTasks(): Promise<void> {
  try {
    await fs.rm(getAgentTasksDemoFile(), { force: true })
  } catch (error) {
    appLogger.warn(`demo agent tasks wipe failed: ${String(error)}`, LOG_SCOPE)
  }
}

export function resetAgentTaskFilesForTest(): void {
  agentTaskFilesDeps = null
  clearChains()
}
