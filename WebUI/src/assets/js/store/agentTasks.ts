import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { MODEL_DOWNLOAD_DECLINED, promptHasImageAttachment } from '@/types/agentIpc'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { PauseReason } from '@/types/kernelEvents'
import type {
  AgentTask,
  AgentTaskActiveRun,
  AgentTaskOutcome,
  AgentTaskSchedule,
  AgentTaskStep,
} from '@/types/agentTaskIpc'
import { MCP_CAPABILITY_PREFIX } from '@/types/agentCapabilities'
import { useActivities } from './activities'
import { useAgentMode, type SessionTurnInfo, type TurnOutcome } from './agentMode'
import { AGENT_PRESET } from './agentModeSessions'
import { useDemoMode } from './demoMode'
import { useErrors } from './errors'
import { useI18N } from './i18n'
import { useMcp } from './mcp'
import { usePresets, type ChatPreset } from './presets'
import { useSessions } from './sessions'
import { useTextInference } from './textInference'
import { createAppError, extractMessage, isCancellation } from '@/assets/js/errors/appError'
import { requestDownload } from '@/assets/js/permissions/permissions'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { sameAgentSetup } from '@/lib/agentSetup'
import { firstStepTurn, stepPrompts, stepTurn } from '@/lib/taskSteps'
import { nextSlotAfter, scheduleProblem, type ScheduleProblem } from '@/lib/taskSchedule'
import {
  describeSettingsProblems,
  type SessionSettingsProblem,
} from '@/lib/sessionSettingsProblems'

export type TaskDraft = { name: string; steps: AgentTaskStep[] }

/** A prompt being carried out in its session's Steps; `stepIndex` is 1-based. */
export type PromptRun = { stepIndex: number; stepCount: number }

/** Why a draft cannot be saved yet. */
export type SaveTaskBlocker = 'name' | 'no-steps' | 'empty-step' | 'no-session'

export const SAVE_TASK_BLOCKER_KEYS = {
  name: 'AGENT_TASK_BLOCKED_NAME',
  'no-steps': 'AGENT_TASK_BLOCKED_NO_STEPS',
  'empty-step': 'AGENT_TASK_BLOCKED_EMPTY_STEP',
  'no-session': 'AGENT_TASK_BLOCKED_NO_SESSION',
} as const satisfies Record<SaveTaskBlocker, string>

/**
 * A Task Run in flight; `stepIndex` is 1-based. `skippedSlots` counts the Schedule slots that
 * passed while its Task Session was paused; `waiting` is set while its next Step waits for the
 * Session's own turn to end. Memory only.
 */
export type TaskRun = {
  stepIndex: number
  stepCount: number
  sessionId: string
  skippedSlots?: number
  waiting?: boolean
}

/** A Task Run as shown: `paused` while its Task Session waits on the user. */
export type TaskRunState = TaskRun & { paused?: { reason?: PauseReason } }

export type TaskState = { running: TaskRunState } | { idle: AgentTaskOutcome | undefined }

/** The chat model a Settings Template runs on was not downloaded. */
export type ModelDownloadRefusal =
  { reason: 'download-declined' } | { reason: 'download-failed'; error: string }

export type SaveTaskResult =
  | { ok: true; task: AgentTask }
  | { ok: false; reason: SaveTaskBlocker | 'persist-failed' | 'no-task' }

export type RunTaskResult =
  | { ok: true }
  | { ok: false; reason: 'no-task' | 'running' }
  | { ok: false; reason: 'settings-problems'; problems: SessionSettingsProblem[]; message: string }
  | ({ ok: false; message: string } & ModelDownloadRefusal)

export type SetScheduleResult =
  | { ok: true; task: AgentTask }
  | { ok: false; reason: 'no-task' | 'persist-failed' }
  | { ok: false; reason: 'invalid'; problem: ScheduleProblem }

export type TaskScheduleState = Pick<AgentTask, 'schedule' | 'nextRunAt'>

/** What the user gives an Agent's Chat preset; `image` is a data URI, the Agent preset's when unset. */
export type AgentPresetDetails = { description: string; image?: string }

export type SaveAgentPresetResult =
  | { ok: true; preset: ChatPreset }
  | { ok: false; reason: 'no-task' | 'name-taken' | 'no-base' | 'persist-failed' }

type RunEnd = Pick<AgentTaskOutcome, 'kind' | 'stepIndex' | 'message'>

type OutcomeFields = Omit<AgentTaskOutcome, 'at'>

type ScheduledTask = AgentTask & { schedule: AgentTaskSchedule }

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (result, [name, value]) => result.replace(`{${name}}`, String(value)),
    template,
  )
}

const SCHEDULE_TICK_MS = 30_000
/**
 * A due slot older than this was missed (app closed, machine asleep) and is not run. The margin
 * covers Chromium aligning a hidden window's timers to one wake-up a minute.
 */
const FRESH_SLOT_MS = SCHEDULE_TICK_MS + 60_000

export const useAgentTasks = defineStore('agentTasks', () => {
  const activities = useActivities()
  const agentMode = useAgentMode()
  const demoMode = useDemoMode()
  const errors = useErrors()
  const i18n = useI18N()
  const mcp = useMcp()
  const presets = usePresets()
  const sessionsStore = useSessions()
  const textInference = useTextInference()

  /** The Tasks of Sessions; one saved before Tasks belonged to a Session stays on disk unlisted. */
  const tasks = ref<AgentTask[]>([])

  const runs = ref<Record<string, TaskRun>>({})
  /** The Task as its run started, and the abort that keeps an ended run from sending a Step. */
  const runContexts: Record<
    string,
    { plan: AgentTask; abort: AbortController; scheduled: boolean }
  > = {}

  /** Prompts being carried out in their session's Steps. Memory only: a reload ends them. */
  const promptRuns = ref<Record<string, PromptRun>>({})
  const promptRunContexts: Record<string, { steps: string[]; abort: AbortController }> = {}

  // A standing schedule is main's to read from the tasks file. This only covers the
  // gap before an in-flight run's marker reaches disk, including between Steps.
  watch(
    () => Object.keys(runs.value).length > 0 || Object.keys(promptRuns.value).length > 0,
    (busy) => activities.holdBusy('agent-tasks', busy),
    { immediate: true },
  )

  let scheduleTicker: ReturnType<typeof setInterval> | undefined
  /** Tasks whose delete is in flight; a tick saving one would write it back. */
  const deleting = new Set<string>()
  /** Tasks whose ▶ Run is still being checked, possibly waiting on a model download. */
  const starting = new Set<string>()
  /** Tasks whose run is getting its Harness Session from main. */
  const minting = new Set<string>()

  async function init(): Promise<void> {
    try {
      const result = await window.electronAPI.agentMode.readTasks()
      if (!result.success) throw new Error(result.error)
      tasks.value = result.tasks.filter((task) => task.sessionRef)
    } catch (error) {
      reportReadFailure(error)
      return
    }
    await settleInterruptedRuns()
    skipMissedSlots()
    clearInterval(scheduleTicker)
    scheduleTicker = setInterval(tickSchedules, SCHEDULE_TICK_MS)
  }

  /** No catch-up at launch: slots that fell while the app was closed are skipped. */
  function skipMissedSlots(): void {
    const now = Date.now()
    for (const task of tasks.value) {
      if (isDue(task, now)) advanceNextRun(task, now)
    }
  }

  function tickSchedules(): void {
    if (demoMode.enabled) return
    const now = Date.now()
    for (const task of tasks.value) {
      if (!isDue(task, now) || deleting.has(task.id)) continue
      const fresh = task.nextRunAt !== undefined && now - task.nextRunAt < FRESH_SLOT_MS
      advanceNextRun(task, now)
      if (!fresh) continue
      // One Task Run at a time: a slot that finds one in flight is skipped, not queued.
      const run = runs.value[task.id]
      if (!run) void runScheduled(task.id)
      else if (pausedTurnOf(run)) countSkippedSlot(task.id)
    }
  }

  function pausedTurnOf(run: TaskRun): SessionTurnInfo | undefined {
    const turn = agentMode.sessionTurns[run.sessionId]
    return turn?.state === 'paused' ? turn : undefined
  }

  function countSkippedSlot(taskId: string): void {
    const run = runs.value[taskId]
    const skippedSlots = (run.skippedSlots ?? 0) + 1
    runs.value = { ...runs.value, [taskId]: { ...run, skippedSlots } }
  }

  function isDue(task: AgentTask, now: number): task is ScheduledTask {
    return (
      task.schedule?.enabled === true && !(task.nextRunAt !== undefined && task.nextRunAt > now)
    )
  }

  function advanceNextRun(task: ScheduledTask, now: number): void {
    void persistTask(replaceTask({ ...task, nextRunAt: nextSlotAfter(task.schedule, now) }))
  }

  /** Sessions whose agent turn main still holds, so a reload must not call the run closed. */
  async function liveAgentSessions(): Promise<Set<string>> {
    try {
      const snapshot = await window.electronAPI.getKernelSnapshot()
      return new Set(
        snapshot.state.agentTurns
          .filter(
            (turn) =>
              turn.state === 'queued' || turn.state === 'running' || turn.state === 'paused',
          )
          .map((turn) => turn.sessionId),
      )
    } catch {
      return new Set()
    }
  }

  /**
   * A run marker with no turn left in main was cut off (process death). A turn
   * main still holds is the same run: keep the step loop attached to it.
   */
  async function settleInterruptedRuns(): Promise<void> {
    const live = await liveAgentSessions()
    for (const task of tasks.value) {
      if (!task.activeRun) continue
      const { sessionId, stepIndex, stepCount } = task.activeRun
      if (live.has(sessionId)) {
        reattachRun(task)
        continue
      }
      await recordOutcome(task.id, {
        kind: 'failed',
        sessionId,
        stepIndex,
        stepCount,
        reason: 'app-closed',
      })
    }
  }

  function reattachRun(task: AgentTask): void {
    const activeRun = task.activeRun
    if (!activeRun) return
    runs.value = {
      ...runs.value,
      [task.id]: {
        sessionId: activeRun.sessionId,
        stepIndex: activeRun.stepIndex,
        stepCount: activeRun.stepCount,
      },
    }
    runContexts[task.id] = {
      plan: cloneForIpc(task),
      abort: new AbortController(),
      scheduled: activeRun.scheduled === true,
    }
    agentMode.quietSessionErrors(activeRun.sessionId)
  }

  function reportReadFailure(error: unknown): void {
    errors.report(
      createAppError({
        category: 'backend',
        code: 'agent-tasks/read-failed',
        severity: 'warning',
        surface: 'toast',
        userMessage: i18n.state.AGENT_TASK_READ_FAILED ?? 'Could not read the saved agents.',
        technicalMessage: extractMessage(error),
        cause: error,
      }),
    )
  }

  function saveBlocker(draft: TaskDraft): SaveTaskBlocker | null {
    return blockerOf({ ...draft, sessionRef: sessionsStore.openSessionId })
  }

  function blockerOf(draft: TaskDraft & { sessionRef: string | null }): SaveTaskBlocker | null {
    if (!draft.name.trim()) return 'name'
    if (draft.steps.length === 0) return 'no-steps'
    if (draft.steps.some((step) => !step.prompt.trim())) return 'empty-step'
    if (!draft.sessionRef) return 'no-session'
    return null
  }

  /**
   * The Task's local chat model, with its vision projector when a Step hands it an image, is
   * downloaded with the user's consent when missing; a refusal says why it is not on disk.
   */
  async function chatModelRefusal(
    template: AgentSessionSettings,
    steps: readonly AgentTaskStep[],
  ): Promise<(ModelDownloadRefusal & { message: string }) | null> {
    const { inference } = textInference.inferenceForSettings(AGENT_PRESET, template)
    if (inference.backend === 'cloud') return null
    const model = inference.activeModel ?? ''
    const needsVision =
      inference.modelSupportsVision && steps.some((step) => promptHasImageAttachment(step.prompt))
    try {
      const missing = await textInference.getMissingLlmModels(
        inference.backend as 'llamaCPP' | 'openVINO',
        model,
        { needsVision },
      )
      if (missing.length > 0) await requestDownload(missing)
      return null
    } catch (error) {
      if (isCancellation(error)) {
        const declined =
          i18n.state.AGENT_TASK_RUN_DOWNLOAD_DECLINED ??
          'Not started: the agent’s chat model {model} has to be downloaded first.'
        return { reason: 'download-declined', message: fill(declined, { model }) }
      }
      const technical = extractMessage(error)
      const failed =
        i18n.state.AGENT_TASK_RUN_DOWNLOAD_FAILED ??
        'Not started: the download of {model} failed: {error}'
      const message = fill(failed, { model, error: technical })
      errors.report(
        createAppError({
          category: 'backend',
          code: 'agent-tasks/model-download-failed',
          severity: 'warning',
          surface: 'toast',
          userMessage: message,
          technicalMessage: technical,
          cause: error,
        }),
      )
      return { reason: 'download-failed', error: technical, message }
    }
  }

  /** Store the draft in the open Session, with the panel's Session Settings as its template. */
  async function saveTask(draft: TaskDraft): Promise<SaveTaskResult> {
    const blocker = saveBlocker(draft)
    if (blocker) return { ok: false, reason: blocker }
    const name = draft.name.trim()
    const sessionRef = sessionsStore.openSessionId!
    const settingsTemplate = cloneForIpc(agentMode.openSessionSettings)
    const steps = draft.steps.map((step) => ({ id: step.id, prompt: step.prompt }))
    const now = Date.now()
    const task: AgentTask = {
      id: crypto.randomUUID(),
      name,
      sessionRef,
      settingsTemplate,
      steps,
      createdAt: now,
      updatedAt: now,
    }
    if (!(await persistTask(task))) return { ok: false, reason: 'persist-failed' }
    tasks.value = [...tasks.value, task]
    return { ok: true, task }
  }

  /** Upsert one Task into the tasks file; a failure is toasted. */
  async function persistTask(task: AgentTask): Promise<boolean> {
    const result = await window.electronAPI.agentMode
      .saveTask(cloneForIpc(task))
      .catch((error: unknown) => ({ success: false as const, error: String(error) }))
    if (result.success) return true
    errors.report(
      createAppError({
        category: 'backend',
        code: 'agent-tasks/save-failed',
        userMessage: i18n.state.AGENT_TASK_SAVE_FAILED ?? 'Could not save the agent.',
        technicalMessage: result.error,
        surface: 'toast',
      }),
    )
    return false
  }

  /** The open Session's Tasks, which its panel lists. */
  const sessionTasks = computed(() =>
    tasks.value.filter((task) => task.sessionRef === sessionsStore.openSessionId),
  )

  /** Sessions with a Task whose Schedule is enabled. */
  const scheduledSessionIds = computed(
    () =>
      new Set(
        tasks.value.flatMap((task) =>
          task.schedule?.enabled && task.sessionRef ? [task.sessionRef] : [],
        ),
      ),
  )

  /** The runs the Task made stay in its Session. Refused while the Task runs. */
  async function deleteTask(id: string): Promise<boolean> {
    if (runs.value[id]) return false
    deleting.add(id)
    const result = await window.electronAPI.agentMode
      .deleteTask(id)
      .catch((error: unknown) => ({ success: false as const, error: String(error) }))
      .finally(() => deleting.delete(id))
    if (!result.success) {
      errors.report(
        createAppError({
          category: 'backend',
          code: 'agent-tasks/delete-failed',
          userMessage: i18n.state.AGENT_TASK_DELETE_FAILED ?? 'Could not delete the agent.',
          technicalMessage: result.error,
          surface: 'toast',
        }),
      )
      return false
    }
    const preset = presetOfAgent(id)
    tasks.value = tasks.value.filter((task) => task.id !== id)
    if (agentMode.openTaskId === id) agentMode.linkOpenSessionToAgent(undefined)
    if (preset) await presets.removeUserPreset(preset.name)
    return true
  }

  // Main deletes a deleted Session's Tasks from the file; its runs stop and its Tasks leave the list.
  watch(
    () => sessionsStore.sessions,
    (known, before) => {
      const gone = Object.keys(before ?? {}).filter((id) => !known[id])
      if (gone.length > 0) void forgetSessionTasks(new Set(gone))
    },
  )

  async function forgetSessionTasks(gone: ReadonlySet<string>): Promise<void> {
    const doomed = tasks.value.filter((task) => task.sessionRef && gone.has(task.sessionRef))
    for (const task of doomed) deleting.add(task.id)
    tasks.value = tasks.value.filter((task) => !doomed.includes(task))
    try {
      for (const task of doomed) {
        const run = runs.value[task.id]
        if (run) {
          const { [task.id]: _ended, ...rest } = runs.value
          runs.value = rest
          runContexts[task.id]?.abort.abort()
          delete runContexts[task.id]
          await agentMode.stopSession(run.sessionId)
        }
        if (agentMode.openTaskId === task.id) agentMode.linkOpenSessionToAgent(undefined)
        const preset = presetOfAgent(task.id)
        if (preset) await presets.removeUserPreset(preset.name)
      }
    } finally {
      for (const task of doomed) deleting.delete(task.id)
    }
  }

  /** The Chat preset an Agent was saved as, if any. */
  function presetOfAgent(id: string): ChatPreset | undefined {
    return presets.presets.find(
      (preset): preset is ChatPreset => preset.type === 'chat' && preset.agentTaskId === id,
    )
  }

  /** The Agent the active preset was saved from: its sessions are set up as that Agent. */
  const presetAgent = computed(() => {
    const taskId = agentMode.activeAgentPreset?.agentTaskId
    return taskId ? tasks.value.find((task) => task.id === taskId) : undefined
  })

  /**
   * Add the Agent to the Chat presets, or update the preset it already has. The preset keeps
   * the name it was created with, since its sessions are filed under it.
   */
  async function saveAgentAsPreset(
    id: string,
    details: AgentPresetDetails,
  ): Promise<SaveAgentPresetResult> {
    const task = tasks.value.find((entry) => entry.id === id)
    if (!task) return { ok: false, reason: 'no-task' }
    const existing = presetOfAgent(id)
    const name = existing?.name ?? task.name
    if (!existing && presets.presets.some((preset) => preset.name === name)) {
      return { ok: false, reason: 'name-taken' }
    }
    const base = presets.presets.find(
      (preset): preset is ChatPreset => preset.type === 'chat' && preset.name === AGENT_PRESET,
    )
    if (!base) return { ok: false, reason: 'no-base' }
    const { extendedDescription: _howTo, ...shared } = cloneForIpc(base)
    const preset: ChatPreset = {
      ...shared,
      name,
      description: details.description.trim(),
      image: details.image ?? base.image,
      agentTaskId: id,
    }
    if (!(await presets.addPreset(preset))) return { ok: false, reason: 'persist-failed' }
    return { ok: true, preset }
  }

  async function removeAgentPreset(id: string): Promise<boolean> {
    const preset = presetOfAgent(id)
    return preset ? presets.removeUserPreset(preset.name) : true
  }

  agentMode.setPresetSessionStarter(async (presetName) => {
    const preset = presets.presets.find((entry) => entry.name === presetName)
    const taskId = preset?.type === 'chat' ? (preset as ChatPreset).agentTaskId : undefined
    return taskId ? loadAgent(taskId) : false
  })

  /** Set, replace, pause or resume a Task's Schedule; the Next Run is kept only while enabled. */
  async function setSchedule(id: string, schedule: AgentTaskSchedule): Promise<SetScheduleResult> {
    const problem = scheduleProblem(schedule)
    if (problem) return { ok: false, reason: 'invalid', problem }
    return writeSchedule(id, {
      schedule: { ...schedule },
      ...(schedule.enabled ? { nextRunAt: nextSlotAfter(schedule, Date.now()) } : {}),
    })
  }

  async function removeSchedule(id: string): Promise<boolean> {
    return (await writeSchedule(id, {})).ok
  }

  async function writeSchedule(id: string, fields: TaskScheduleState): Promise<SetScheduleResult> {
    const saved = tasks.value.find((entry) => entry.id === id)
    if (!saved) return { ok: false, reason: 'no-task' }
    // Applied before the write, so a run marking or settling the Task meanwhile writes it too.
    const task = replaceTask({ ...withoutSchedule(saved), ...fields })
    if (await persistTask(task)) return { ok: true, task }
    const latest = tasks.value.find((entry) => entry.id === id)
    if (latest) replaceTask({ ...withoutSchedule(latest), ...scheduleStateOf(saved) })
    return { ok: false, reason: 'persist-failed' }
  }

  function withoutSchedule(task: AgentTask): AgentTask {
    const { schedule: _schedule, nextRunAt: _nextRunAt, ...rest } = task
    return rest
  }

  function scheduleStateOf(task: AgentTask): TaskScheduleState {
    return {
      ...(task.schedule ? { schedule: task.schedule } : {}),
      ...(task.nextRunAt !== undefined ? { nextRunAt: task.nextRunAt } : {}),
    }
  }

  function taskSchedule(id: string): TaskScheduleState {
    const task = tasks.value.find((entry) => entry.id === id)
    return task ? scheduleStateOf(task) : {}
  }

  function taskState(id: string): TaskState {
    const run = runs.value[id]
    if (run) {
      const turn = pausedTurnOf(run)
      if (!turn) return { running: { ...run } }
      const reason = turn.pauseReason
      return { running: { ...run, paused: reason ? { reason } : {} } }
    }
    return { idle: tasks.value.find((task) => task.id === id)?.lastOutcome }
  }

  /** What in the Task's Settings Template cannot be used right now; empty when it can run. */
  function taskProblems(id: string): SessionSettingsProblem[] {
    const task = tasks.value.find((entry) => entry.id === id)
    return task ? agentMode.problemsOf(task.settingsTemplate) : []
  }

  /** List the MCP servers the Tasks use, so their problems include missing servers. */
  async function loadProblemSources(): Promise<void> {
    await agentMode.loadMcpServersFor(
      tasks.value.flatMap((task) => task.settingsTemplate.capabilities ?? []),
    )
  }

  /**
   * Start a Task Run in the background: a new Task Session on the Task's folder and Settings
   * Template, its Steps sent one by one as each previous turn settles. Refused, before any Task
   * Session exists, while the Settings Template has a problem or its chat model is not downloaded.
   */
  async function runTask(id: string): Promise<RunTaskResult> {
    if (starting.has(id)) return { ok: false, reason: 'running' }
    starting.add(id)
    try {
      return await startManualRun(id)
    } finally {
      starting.delete(id)
    }
  }

  async function startManualRun(id: string): Promise<RunTaskResult> {
    const capabilities = tasks.value.find((entry) => entry.id === id)?.settingsTemplate.capabilities
    await agentMode.loadMcpServersFor(capabilities ?? [])
    // Looked up after the wait, which a delete or a second Run may have overtaken.
    const checked = tasks.value.find((entry) => entry.id === id)
    if (!checked) return { ok: false, reason: 'no-task' }
    if (runs.value[id] || minting.has(id)) return { ok: false, reason: 'running' }
    const problems = taskProblems(id)
    if (problems.length > 0) {
      const message = describeSettingsProblems(problems, i18n.state)
      return { ok: false, reason: 'settings-problems', problems, message }
    }
    const refusal = await chatModelRefusal(checked.settingsTemplate, checked.steps)
    if (refusal) return { ok: false, ...refusal }
    // The download may have taken long enough for a delete or a Scheduled Run to overtake it.
    const task = tasks.value.find((entry) => entry.id === id)
    if (!task) return { ok: false, reason: 'no-task' }
    if (runs.value[id] || minting.has(id)) return { ok: false, reason: 'running' }
    await startRun(task, false)
    return { ok: true }
  }

  /**
   * A Task Run started by the Schedule. Nobody is watching, so a refusal is kept as the Task's
   * outcome and toasted; a Task Run already in flight skips the slot silently.
   */
  async function runScheduled(id: string): Promise<void> {
    const slotTask = stillScheduled(id)
    if (!slotTask) return
    await agentMode.loadMcpServersFor(slotTask.settingsTemplate.capabilities ?? [])
    // A delete, pause or manual Run may have overtaken the wait.
    const task = stillScheduled(id)
    if (!task) return
    const refusal = scheduledRefusal(task)
    if (!refusal) return startRun(task, true)
    await recordNotStarted(task, refusal, true)
  }

  async function recordNotStarted(task: AgentTask, message: string, scheduled: boolean) {
    await recordOutcome(
      task.id,
      { kind: 'failed', reason: 'not-started', message, stepCount: task.steps.length },
      scheduled,
    )
  }

  function stillScheduled(id: string): AgentTask | undefined {
    const task = tasks.value.find((entry) => entry.id === id)
    if (!task?.schedule?.enabled || isRunningOrStarting(id) || deleting.has(id)) return undefined
    return task
  }

  function isRunningOrStarting(id: string): boolean {
    return !!runs.value[id] || starting.has(id) || minting.has(id)
  }

  function scheduledRefusal(task: AgentTask): string | null {
    if (!presets.presets.some((preset) => preset.name === AGENT_PRESET)) {
      return i18n.state.AGENT_TASK_PRESET_UNAVAILABLE ?? 'The Agent preset is not available.'
    }
    const needsMcp = (task.settingsTemplate.capabilities ?? []).some((id) =>
      id.startsWith(MCP_CAPABILITY_PREFIX),
    )
    if (needsMcp && !mcp.serversLoaded) {
      return fill(
        i18n.state.AGENT_TASK_MCP_UNAVAILABLE ?? 'The MCP servers could not be loaded: {error}',
        { error: mcp.configError ?? '' },
      )
    }
    const problems = taskProblems(task.id)
    if (problems.length > 0) return describeSettingsProblems(problems, i18n.state)
    return null
  }

  /**
   * A run works in its Session's `files/` on a Harness Session of its own, minted fresh,
   * so it carries no context from the Session or from earlier runs.
   */
  async function startRun(task: AgentTask, scheduled: boolean): Promise<void> {
    const id = task.id
    const plan = cloneForIpc(task)
    const sessionRef = plan.sessionRef ?? ''
    minting.add(id)
    let harness: { harnessSessionId: string; workspaceDir: string }
    try {
      const result = await window.electronAPI.sessions.taskRunHarness(sessionRef)
      if (!result.success) throw new Error(result.error)
      harness = result.harness
    } catch (error) {
      minting.delete(id)
      if (!deleting.has(id)) await recordNotStarted(task, extractMessage(error), scheduled)
      return
    }
    minting.delete(id)
    // A delete, pause or manual Run may have overtaken the wait.
    const current = tasks.value.find((entry) => entry.id === id)
    if (!current || runs.value[id] || deleting.has(id)) return
    if (scheduled && !current.schedule?.enabled) return
    const sessionId = agentMode.createSession({
      id: harness.harnessSessionId,
      sessionRef,
      workspaceDir: harness.workspaceDir,
      settings: cloneForIpc(plan.settingsTemplate),
      presetName: presetOfAgent(id)?.name ?? AGENT_PRESET,
      title: plan.name,
      taskId: plan.id,
      taskRun: { taskName: plan.name, startedAt: Date.now() },
      steps: plan.steps,
    })
    runContexts[id] = { plan, abort: new AbortController(), scheduled }
    runs.value = { ...runs.value, [id]: { sessionId, stepIndex: 1, stepCount: plan.steps.length } }
    void sendStep(id, 1)
  }

  /** A Session runs one turn at a time: a Step due while it has one in flight waits for it. */
  function sessionBusy(sessionRef: string | undefined): boolean {
    return !!sessionRef && !!sessionsStore.turns[sessionRef]
  }

  watch(
    () => sessionsStore.turns,
    () => {
      for (const [taskId, run] of Object.entries(runs.value)) {
        if (run.waiting && !sessionBusy(runContexts[taskId]?.plan.sessionRef)) {
          void sendStep(taskId, run.stepIndex)
        }
      }
    },
  )

  async function sendStep(taskId: string, stepIndex: number): Promise<void> {
    const run = runs.value[taskId]
    const context = runContexts[taskId]
    if (!run || !context) return
    const { plan, abort } = context
    const waiting = sessionBusy(plan.sessionRef)
    const { waiting: _wasWaiting, ...rest } = run
    runs.value = {
      ...runs.value,
      [taskId]: { ...rest, stepIndex, ...(waiting ? { waiting } : {}) },
    }
    markRunInFlight(taskId, { sessionId: run.sessionId, stepIndex, stepCount: run.stepCount })
    if (waiting) return
    const steps = stepPrompts(plan.steps)
    const turn = stepIndex === 1 ? firstStepTurn('', steps) : stepTurn(stepIndex, steps)
    const result = await agentMode.sendToSession(run.sessionId, turn, {
      settings: cloneForIpc(plan.settingsTemplate),
      signal: abort.signal,
      quietErrors: true,
      taskRun: { taskName: plan.name, stepIndex },
    })
    if (!result.ok && result.reason !== 'aborted') {
      await settleRun(taskId, { kind: 'failed', stepIndex, message: result.message })
      agentMode.releaseHeldAnswer(run.sessionId)
    }
  }

  function markRunInFlight(taskId: string, activeRun: AgentTaskActiveRun): void {
    const task = tasks.value.find((entry) => entry.id === taskId)
    if (!task) return
    const scheduled = runContexts[taskId]?.scheduled === true
    const marked = scheduled ? { ...activeRun, scheduled: true as const } : activeRun
    void persistTask(replaceTask({ ...task, activeRun: marked }))
  }

  function replaceTask(updated: AgentTask): AgentTask {
    tasks.value = tasks.value.map((entry) => (entry.id === updated.id ? updated : entry))
    return updated
  }

  async function stopTask(id: string): Promise<void> {
    const run = runs.value[id]
    if (!run) return
    // Settled first, so the stopped turn's own settle finds no run and no Step can follow.
    const settled = settleRun(id, { kind: 'stopped', stepIndex: run.stepIndex })
    await agentMode.stopSession(run.sessionId)
    await settled
  }

  function runOfSession(sessionId: string): string | undefined {
    return Object.keys(runs.value).find((id) => runs.value[id].sessionId === sessionId)
  }

  function isSessionLockedByTask(sessionId: string): boolean {
    return runOfSession(sessionId) !== undefined
  }

  function taskLockingSession(sessionId: string): AgentTask | undefined {
    const taskId = runOfSession(sessionId)
    return taskId ? tasks.value.find((task) => task.id === taskId) : undefined
  }

  // Prompt runs lock too, so an Answer cannot slip in between their Steps.
  agentMode.setTaskLockLookup((sessionId) => {
    const promptRun = promptRunContexts[sessionId]
    if (promptRun) {
      const taskName = agentMode.sessions[sessionId]?.title ?? ''
      return { taskName, signal: promptRun.abort.signal }
    }
    const taskId = runOfSession(sessionId)
    if (!taskId) return undefined
    const taskName = tasks.value.find((task) => task.id === taskId)?.name ?? ''
    return { taskName, signal: runContexts[taskId]?.abort.signal }
  })

  /** The Agent the Open Session was loaded from or saved as, while it still exists. */
  const openSessionTask = computed(() => {
    const taskId = agentMode.openTaskId
    return taskId ? tasks.value.find((task) => task.id === taskId) : undefined
  })

  /** The Open Session's Steps run with its Task's Settings Template, so its own are not editable. */
  const openSessionSettingsReadOnly = computed(() => isSessionLockedByTask(agentMode.openSessionId))

  agentMode.onTurnSettled((sessionId, outcome) => {
    if (promptRuns.value[sessionId]) {
      void advancePromptRun(sessionId, outcome)
      return
    }
    const taskId = runOfSession(sessionId)
    if (!taskId) return
    const { stepIndex, stepCount } = runs.value[taskId]
    if (outcome.kind === 'completed') {
      if (stepIndex < stepCount) void sendStep(taskId, stepIndex + 1)
      else void settleRun(taskId, { kind: 'completed' })
    } else if (outcome.kind === 'error') {
      void settleRun(taskId, { kind: 'failed', stepIndex, message: outcome.message })
    } else {
      void settleRun(taskId, { kind: 'stopped', stepIndex })
    }
  })

  /** End the run and keep how it ended as the Task's only outcome. */
  async function settleRun(taskId: string, end: RunEnd): Promise<void> {
    const run = runs.value[taskId]
    if (!run) return
    const { [taskId]: _ended, ...rest } = runs.value
    runs.value = rest
    const scheduled = runContexts[taskId]?.scheduled === true
    runContexts[taskId]?.abort.abort()
    delete runContexts[taskId]
    const declined = end.kind === 'failed' && end.message === MODEL_DOWNLOAD_DECLINED
    await recordOutcome(
      taskId,
      {
        ...end,
        sessionId: run.sessionId,
        stepCount: run.stepCount,
        ...(declined ? { reason: 'download-declined' as const } : {}),
      },
      scheduled,
    )
  }

  async function recordOutcome(
    taskId: string,
    fields: OutcomeFields,
    scheduled = false,
  ): Promise<void> {
    const task = tasks.value.find((entry) => entry.id === taskId)
    if (!task) return
    if (fields.kind === 'failed') reportRunFailure(task, fields, scheduled)
    const lastOutcome: AgentTaskOutcome = {
      kind: fields.kind,
      at: Date.now(),
      ...(fields.sessionId !== undefined ? { sessionId: fields.sessionId } : {}),
      stepCount: fields.stepCount,
      ...(fields.stepIndex !== undefined ? { stepIndex: fields.stepIndex } : {}),
      ...(fields.message !== undefined ? { message: fields.message } : {}),
      ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
    }
    const { activeRun: _activeRun, ...rest } = task
    await persistTask(replaceTask({ ...rest, lastOutcome }))
  }

  /** The outcome shows a failed run, so only a Scheduled Run, which nobody watched, is toasted. */
  function reportRunFailure(task: AgentTask, end: OutcomeFields, scheduled: boolean): void {
    const declined =
      end.reason === 'download-declined' ? i18n.state.AGENT_TASKS_OUTCOME_DOWNLOAD_DECLINED : null
    const message = declined ?? end.message ?? end.reason ?? ''
    if (scheduled) {
      const notStarted = end.reason === 'not-started'
      const report = notStarted
        ? {
            category: 'validation' as const,
            code: 'agent-tasks/scheduled-run-not-started',
            template:
              i18n.state.AGENT_TASK_SCHEDULED_RUN_NOT_STARTED ??
              'The scheduled run of “{name}” could not start: {reason}',
          }
        : {
            category: 'inference' as const,
            code: 'agent-tasks/scheduled-run-failed',
            template:
              i18n.state.AGENT_TASK_SCHEDULED_RUN_FAILED ??
              'The scheduled run of “{name}” failed: {reason}',
          }
      const userMessage = fill(report.template, { name: task.name, reason: message })
      errors.report(
        createAppError({
          category: report.category,
          code: report.code,
          severity: 'warning',
          surface: 'toast',
          userMessage,
          technicalMessage: `Task "${task.name}" at step ${end.stepIndex ?? '-'}: ${userMessage}`,
          context: { taskId: task.id, stepIndex: end.stepIndex },
        }),
      )
      return
    }
    errors.report(
      createAppError({
        category: 'inference',
        code: 'agent-tasks/run-failed',
        severity: 'warning',
        surface: 'silent',
        userMessage: message,
        technicalMessage: `Task "${task.name}" failed at step ${end.stepIndex ?? '?'}: ${message}`,
        context: { taskId: task.id, stepIndex: end.stepIndex },
      }),
    )
  }

  /** Why the Open Session cannot be saved as an Agent under `name` yet. */
  function saveAgentBlocker(name: string): SaveTaskBlocker | null {
    return saveBlocker({ name, steps: agentMode.openSteps })
  }

  /** Save the Open Session's folder, settings and Steps as a new Agent, and link it. */
  async function saveAgent(name: string): Promise<SaveTaskResult> {
    const result = await saveTask({ name, steps: agentMode.openSteps })
    if (result.ok) agentMode.linkOpenSessionToAgent(result.task.id)
    return result
  }

  /**
   * Overwrite an Agent with the Open Session's folder, settings and Steps, keeping its identity,
   * Schedule and last outcome. A run in flight keeps the copy it took at start.
   */
  async function updateAgent(id: string, name: string): Promise<SaveTaskResult> {
    const current = tasks.value.find((task) => task.id === id)
    if (!current) return { ok: false, reason: 'no-task' }
    const steps = agentMode.openSteps.map((step) => ({ id: step.id, prompt: step.prompt }))
    const blocker = blockerOf({ name, steps, sessionRef: current.sessionRef ?? null })
    if (blocker) return { ok: false, reason: blocker }
    const settingsTemplate = cloneForIpc(agentMode.openSessionSettings)
    const saved = tasks.value.find((task) => task.id === id)
    if (!saved) return { ok: false, reason: 'no-task' }
    const task = replaceTask({
      ...saved,
      name: name.trim(),
      steps,
      settingsTemplate,
      updatedAt: Math.max(Date.now(), saved.updatedAt + 1),
    })
    // Applied before the write, so a run marking or settling the Agent meanwhile writes it too.
    if (!(await persistTask(task))) {
      restoreEditableFields(saved)
      return { ok: false, reason: 'persist-failed' }
    }
    agentMode.linkOpenSessionToAgent(id)
    return { ok: true, task }
  }

  /** Rename an Agent, leaving its settings and Steps as they were saved. */
  async function renameAgent(id: string, name: string): Promise<SaveTaskResult> {
    const saved = tasks.value.find((task) => task.id === id)
    if (!saved) return { ok: false, reason: 'no-task' }
    if (!name.trim()) return { ok: false, reason: 'name' }
    if (name.trim() === saved.name) return { ok: true, task: saved }
    const task = replaceTask({
      ...saved,
      name: name.trim(),
      updatedAt: Math.max(Date.now(), saved.updatedAt + 1),
    })
    if (!(await persistTask(task))) {
      restoreEditableFields(saved)
      return { ok: false, reason: 'persist-failed' }
    }
    return { ok: true, task }
  }

  /** The Open Session's settings or Steps differ from the Agent it was loaded from. */
  const openSessionAgentChanged = computed(() => {
    const task = openSessionTask.value
    if (!task) return false
    return !sameAgentSetup(
      { settings: task.settingsTemplate, steps: task.steps },
      {
        settings: agentMode.openSessionSettings ?? {},
        steps: agentMode.openSteps,
      },
    )
  })

  function restoreEditableFields(saved: AgentTask): void {
    const latest = tasks.value.find((entry) => entry.id === saved.id)
    if (!latest) return
    const { name, steps, settingsTemplate, updatedAt } = saved
    replaceTask({ ...latest, name, steps, settingsTemplate, updatedAt })
  }

  /** Set the open Session's Agent up as the Task is, for editing it. */
  async function loadAgent(id: string): Promise<boolean> {
    const task = tasks.value.find((entry) => entry.id === id)
    if (!task) return false
    const plan = cloneForIpc(task)
    await agentMode.startSessionFrom({
      taskId: plan.id,
      settings: plan.settingsTemplate,
      steps: plan.steps,
    })
    return true
  }

  /** Send a prompt from the prompt bar as one turn; the Open Session's Steps are not run. */
  async function submitPrompt(prompt: string): Promise<void> {
    if (isSessionLockedByTask(agentMode.openSessionId)) return
    if (promptRuns.value[agentMode.openSessionId]) return
    await agentMode.generate(prompt)
  }

  /**
   * Carry out the Open Session's Steps, the prompt (which may be empty) leading the first one.
   * Each Step is sent as the previous turn completes.
   */
  async function runSteps(prompt: string): Promise<void> {
    if (isSessionLockedByTask(agentMode.openSessionId)) return
    if (promptRuns.value[agentMode.openSessionId]) return
    const steps = agentMode.sessionScoped ? stepPrompts(agentMode.openSteps) : []
    if (steps.length === 0) return
    const sessionId = agentMode.ensureOpenSessionId()
    promptRunContexts[sessionId] = { steps, abort: new AbortController() }
    promptRuns.value = {
      ...promptRuns.value,
      [sessionId]: { stepIndex: 1, stepCount: steps.length },
    }
    const turn = firstStepTurn(prompt, steps)
    const title = prompt.trim() || openSessionTask.value?.name || steps[0]
    const started = await agentMode.generate(turn, { title }).catch((error) => {
      endPromptRun(sessionId)
      agentMode.releaseHeldAnswer(sessionId)
      throw error
    })
    if (!started) {
      endPromptRun(sessionId)
      agentMode.releaseHeldAnswer(sessionId)
    }
  }

  function promptRunOf(sessionId: string): PromptRun | undefined {
    return promptRuns.value[sessionId]
  }

  function endPromptRun(sessionId: string): void {
    if (!promptRuns.value[sessionId]) return
    const { [sessionId]: _ended, ...rest } = promptRuns.value
    promptRuns.value = rest
    promptRunContexts[sessionId]?.abort.abort()
    delete promptRunContexts[sessionId]
  }

  /** Ended first, so the stopped turn's own settle sends no further Step. */
  async function stopPromptRun(sessionId: string): Promise<void> {
    if (!promptRuns.value[sessionId]) return
    endPromptRun(sessionId)
    await agentMode.stopSession(sessionId)
  }

  async function advancePromptRun(sessionId: string, outcome: TurnOutcome): Promise<void> {
    const run = promptRuns.value[sessionId]
    const context = promptRunContexts[sessionId]
    if (!run || !context) return
    if (outcome.kind !== 'completed' || run.stepIndex >= run.stepCount) {
      endPromptRun(sessionId)
      return
    }
    const stepIndex = run.stepIndex + 1
    promptRuns.value = { ...promptRuns.value, [sessionId]: { ...run, stepIndex } }
    const result = await agentMode.sendToSession(sessionId, stepTurn(stepIndex, context.steps), {
      signal: context.abort.signal,
    })
    if (result.ok) return
    endPromptRun(sessionId)
    if (result.reason === 'aborted') return
    agentMode.releaseHeldAnswer(sessionId)
    errors.report(
      createAppError({
        category: 'inference',
        code: 'agent/step-not-sent',
        severity: 'warning',
        surface: 'toast',
        userMessage: fill(
          i18n.state.AGENT_STEPS_STEP_NOT_SENT ?? 'Step {step} was not sent: {reason}',
          { step: stepIndex, reason: result.message },
        ),
        technicalMessage: `${result.reason}: ${result.message}`,
      }),
    )
  }

  return {
    tasks,
    sessionTasks,
    scheduledSessionIds,
    init,
    saveBlocker,
    saveTask,
    saveAgentBlocker,
    saveAgent,
    updateAgent,
    loadAgent,
    deleteTask,
    presetOfAgent,
    presetAgent,
    saveAgentAsPreset,
    removeAgentPreset,
    setSchedule,
    removeSchedule,
    taskSchedule,
    taskState,
    taskProblems,
    loadProblemSources,
    runTask,
    stopTask,
    isSessionLockedByTask,
    taskLockingSession,
    openSessionTask,
    openSessionAgentChanged,
    renameAgent,
    openSessionSettingsReadOnly,
    promptRuns,
    promptRunOf,
    submitPrompt,
    runSteps,
    stopPromptRun,
  }
})

if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useAgentTasks, import.meta.hot))
