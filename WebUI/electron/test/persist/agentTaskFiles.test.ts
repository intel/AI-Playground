import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTask } from '@/types/agentTaskIpc'

// The kernel-owned Tasks file, driven against a real file in a temp dir: the
// read/upsert/delete round trip, rejection of a corrupt file or an invalid
// payload, and demo routing + wipe.

const files = vi.hoisted(() => ({ real: '', demo: '' }))
let tmpRoot = ''

vi.mock('../../persist/userDataPaths.ts', () => ({
  getAgentTasksFile: () => files.real,
  getAgentTasksDemoFile: () => files.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const {
  agentTasksKeepAppAlive,
  deleteAgentTask,
  deleteAgentTasksOfSession,
  readAgentTasks,
  resetAgentTaskFilesForTest,
  saveAgentTask,
  setAgentTaskFilesDeps,
  wipeDemoAgentTasks,
} = await import('../../persist/agentTaskFiles')

function task(id: string, overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    name: `Task ${id}`,
    sessionRef: 'session-1',
    settingsTemplate: { backend: 'llamaCPP', model: 'Qwen-9B', capabilities: ['files'] },
    steps: [
      { id: 's1', prompt: 'first' },
      { id: 's2', prompt: 'second' },
    ],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

async function readRaw(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

beforeEach(async () => {
  resetAgentTaskFilesForTest()
  if (!tmpRoot) tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-agent-tasks-'))
  files.real = path.join(tmpRoot, 'agent-tasks.json')
  files.demo = path.join(tmpRoot, 'agent-tasks-demo.json')
  for (const file of [files.real, files.demo]) await fs.rm(file, { force: true })
  setAgentTaskFilesDeps({ isDemoMode: () => false })
})

afterEach(() => {
  resetAgentTaskFilesForTest()
})

describe('the kernel Tasks file', () => {
  it('reads an absent file as no Tasks', async () => {
    expect(await readAgentTasks()).toEqual([])
  })

  it('round-trips saved Tasks with a schema version', async () => {
    await saveAgentTask(task('a'))
    await saveAgentTask(task('b'))

    expect(await readAgentTasks()).toEqual([task('a'), task('b')])
    expect((await readRaw(files.real))?.schemaVersion).toBe(1)
  })

  it('replaces a Task with the same id in place', async () => {
    await saveAgentTask(task('a'))
    await saveAgentTask(task('b'))
    const outcome = {
      kind: 'completed' as const,
      at: 5,
      sessionId: 'aipg-agent-1',
      stepCount: 2,
    }

    await saveAgentTask(task('a', { name: 'Renamed', lastOutcome: outcome }))

    expect(await readAgentTasks()).toEqual([
      task('a', { name: 'Renamed', lastOutcome: outcome }),
      task('b'),
    ])
  })

  it('round-trips a run marker and an app-closed outcome', async () => {
    const activeRun = { sessionId: 'aipg-agent-1', stepIndex: 2, stepCount: 3 }
    const outcome = {
      kind: 'failed' as const,
      at: 9,
      sessionId: 'aipg-agent-1',
      stepIndex: 2,
      stepCount: 3,
      reason: 'app-closed' as const,
    }

    await saveAgentTask(task('a', { activeRun }))
    expect(await readAgentTasks()).toEqual([task('a', { activeRun })])

    await saveAgentTask(task('a', { lastOutcome: outcome }))
    expect(await readAgentTasks()).toEqual([task('a', { lastOutcome: outcome })])
  })

  it('round-trips the outcome of a Scheduled Run that could not start, which has no session', async () => {
    const outcome = {
      kind: 'failed' as const,
      at: 9,
      stepCount: 3,
      message: 'The workspace folder is missing: /work',
      reason: 'not-started' as const,
    }

    await saveAgentTask(task('a', { lastOutcome: outcome }))

    expect(await readAgentTasks()).toEqual([task('a', { lastOutcome: outcome })])
  })

  it('round-trips a Schedule and its Next Run', async () => {
    const schedule = { every: 2, unit: 'hours' as const, startAt: 1_000, enabled: true }

    await saveAgentTask(task('a', { schedule, nextRunAt: 7_201_000 }))

    expect(await readAgentTasks()).toEqual([task('a', { schedule, nextRunAt: 7_201_000 })])
  })

  it('reads a file written before Schedules existed', async () => {
    await fs.writeFile(files.real, JSON.stringify({ schemaVersion: 1, tasks: [task('a')] }), 'utf8')

    const [read] = await readAgentTasks()

    expect(read).toEqual(task('a'))
    expect(read).not.toHaveProperty('schedule')
    expect(read).not.toHaveProperty('nextRunAt')
  })

  it('reads a Task saved before Tasks belonged to a Session, and keeps it on an upsert', async () => {
    const { sessionRef: _none, ...legacy } = task('old')
    const old = { ...legacy, workspaceDir: '/work/project' }
    await fs.writeFile(files.real, JSON.stringify({ schemaVersion: 1, tasks: [old] }), 'utf8')

    await saveAgentTask(task('new'))

    expect(await readAgentTasks()).toEqual([old, task('new')])
  })

  it("deletes a Session's Tasks and leaves every other one", async () => {
    const { sessionRef: _none, ...legacy } = task('old')
    await saveAgentTask(task('a'))
    await saveAgentTask(task('b', { sessionRef: 'session-2' }))
    await saveAgentTask(task('c'))
    await saveAgentTask(legacy)

    await deleteAgentTasksOfSession('session-1')

    expect(await readAgentTasks()).toEqual([task('b', { sessionRef: 'session-2' }), legacy])
  })

  it('deletes one Task and keeps the others', async () => {
    await saveAgentTask(task('a'))
    await saveAgentTask(task('b'))

    await deleteAgentTask('a')

    expect(await readAgentTasks()).toEqual([task('b')])
  })

  it('treats deleting from an absent file as done', async () => {
    await deleteAgentTask('a')
    expect(await readRaw(files.real)).toBeNull()
  })

  it('rejects a payload that is not a Task', async () => {
    await expect(saveAgentTask({ id: 'a', name: 'no steps' })).rejects.toThrow(/invalid task/)
    await expect(saveAgentTask(task(''))).rejects.toThrow(/invalid task/)
    expect(await readRaw(files.real)).toBeNull()
  })

  it('rejects a delete without a task id', async () => {
    await expect(deleteAgentTask(5)).rejects.toThrow(/task id/)
  })

  it('treats a corrupt file as a failed read and never overwrites it', async () => {
    await fs.writeFile(files.real, 'not json', 'utf8')

    await expect(readAgentTasks()).rejects.toThrow(/unreadable/)
    await expect(saveAgentTask(task('a'))).rejects.toThrow(/unreadable/)
    await expect(deleteAgentTask('a')).rejects.toThrow(/unreadable/)
    expect(await fs.readFile(files.real, 'utf8')).toBe('not json')
  })

  it('treats a schema-invalid file as unreadable too', async () => {
    await fs.writeFile(
      files.real,
      JSON.stringify({ schemaVersion: 1, tasks: [{ id: 'a', steps: 'nope' }] }),
      'utf8',
    )
    await expect(readAgentTasks()).rejects.toThrow(/unreadable/)
  })

  it('routes Tasks through the demo file when demo mode is on', async () => {
    setAgentTaskFilesDeps({ isDemoMode: () => true })

    await saveAgentTask(task('demo'))

    expect(await readRaw(files.real)).toBeNull()
    expect(await readAgentTasks()).toEqual([task('demo')])
  })

  it('wipes only the demo file', async () => {
    await saveAgentTask(task('real'))
    setAgentTaskFilesDeps({ isDemoMode: () => true })
    await saveAgentTask(task('demo'))

    await wipeDemoAgentTasks()

    expect(await readRaw(files.demo)).toBeNull()
    setAgentTaskFilesDeps({ isDemoMode: () => false })
    expect(await readAgentTasks()).toEqual([task('real')])
  })

  it('keeps the app alive for an enabled schedule or a run marker', async () => {
    expect(await agentTasksKeepAppAlive()).toBe(false)
    const schedule = { every: 10, unit: 'minutes' as const, startAt: 1, enabled: true }
    await saveAgentTask(task('a', { schedule }))
    expect(await agentTasksKeepAppAlive()).toBe(true)

    await saveAgentTask(task('a', { schedule: { ...schedule, enabled: false } }))
    expect(await agentTasksKeepAppAlive()).toBe(false)

    await saveAgentTask(task('a', { activeRun: { sessionId: 's', stepIndex: 1, stepCount: 2 } }))
    expect(await agentTasksKeepAppAlive()).toBe(true)
  })

  it('does not keep the app alive for a Task saved before Sessions, which no longer runs', async () => {
    const { sessionRef: _none, ...legacy } = task('old')
    const schedule = { every: 10, unit: 'minutes' as const, startAt: 1, enabled: true }
    await saveAgentTask({ ...legacy, schedule })

    expect(await agentTasksKeepAppAlive()).toBe(false)
  })

  it('does not keep the app alive for demo tasks or an unreadable file', async () => {
    const schedule = { every: 10, unit: 'minutes' as const, startAt: 1, enabled: true }
    setAgentTaskFilesDeps({ isDemoMode: () => true })
    await saveAgentTask(task('demo', { schedule }))
    expect(await agentTasksKeepAppAlive()).toBe(false)

    setAgentTaskFilesDeps({ isDemoMode: () => false })
    await fs.writeFile(files.real, 'not json', 'utf8')
    expect(await agentTasksKeepAppAlive()).toBe(false)
  })
})
