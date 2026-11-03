<template>
  <TooltipProvider :delay-duration="200">
    <SettingsPanel :title="i18n.AGENT_AGENTS_TITLE" switch-id="agent-agents">
      <p class="text-xs text-muted-foreground">{{ i18n.AGENT_AGENTS_HINT }}</p>

      <ul v-if="rows.length > 0" class="flex flex-col gap-1" :aria-label="i18n.AGENT_AGENTS_TITLE">
        <li
          v-for="row in rows"
          :key="row.id"
          :aria-label="row.name"
          :aria-current="row.loaded ? 'true' : undefined"
          class="flex flex-col gap-2 rounded-sm px-2 py-1.5"
          :class="row.loaded ? 'bg-primary/15' : 'hover:bg-muted/60'"
        >
          <div class="flex items-center justify-between gap-2">
            <AgentNameField
              v-if="renamingId === row.id"
              v-model="renameValue"
              :id-prefix="`agent-agents-rename-${row.id}`"
              :label="row.renameLabel"
              :submit-label="i18n.AGENT_AGENTS_RENAME_SAVE"
              :cancel-label="i18n.AGENT_AGENTS_CANCEL"
              :blocker="renameValue.trim() ? '' : i18n.AGENT_TASK_BLOCKED_NAME"
              :busy="saving"
              autofocus
              class="flex-1"
              @submit="rename(row.id)"
              @cancel="renamingId = null"
            />
            <button
              v-else
              type="button"
              class="flex items-start gap-2 min-w-0 flex-1 text-left disabled:cursor-default"
              :aria-pressed="row.loaded"
              :aria-label="row.selectLabel"
              :disabled="row.loaded || agentMode.processing"
              @click="select(row.id)"
            >
              <CpuChipIcon
                class="size-5 flex-none mt-0.5"
                :class="row.running ? 'text-green-500 animate-pulse' : 'text-muted-foreground'"
              />
              <span class="flex flex-col min-w-0">
                <span class="flex items-center gap-1.5 min-w-0">
                  <span class="text-sm text-foreground truncate">{{ row.name }}</span>
                  <Tooltip v-if="row.problem">
                    <TooltipTrigger as-child>
                      <ExclamationTriangleIcon
                        role="img"
                        :aria-label="row.problem"
                        class="size-4 flex-none text-amber-500"
                      />
                    </TooltipTrigger>
                    <TooltipContent class="max-w-xs">{{ row.problem }}</TooltipContent>
                  </Tooltip>
                </span>
                <span class="text-xs text-muted-foreground">{{ row.meta }}</span>
                <span v-if="row.progress" class="text-xs text-primary">{{ row.progress }}</span>
                <span
                  v-else-if="row.outcome"
                  class="text-xs break-words"
                  :class="row.outcome.failed ? 'text-destructive' : 'text-muted-foreground'"
                >
                  {{ row.outcome.label }}
                </span>
              </span>
            </button>

            <div v-if="renamingId !== row.id" class="flex flex-none items-center">
              <AgentRowAction
                v-if="row.running"
                :label="row.stopLabel"
                :tooltip="i18n.AGENT_AGENTS_STOP"
                @click="agentTasks.stopTask(row.id)"
              >
                <StopIcon class="size-4" />
              </AgentRowAction>
              <AgentRowAction
                v-else
                :label="row.runLabel"
                :tooltip="i18n.AGENT_AGENTS_RUN_NOW"
                @click="runNow(row.id)"
              >
                <PlayIcon class="size-4" />
              </AgentRowAction>
              <AgentRowAction
                :label="row.scheduleLabel"
                :tooltip="row.scheduleTip"
                :active="row.scheduled"
                @click="openSchedule(row.id)"
              >
                <ClockSolidIcon v-if="row.scheduled" class="size-4" />
                <ClockIcon v-else class="size-4" />
              </AgentRowAction>
              <AgentRowAction
                :label="row.presetLabel"
                :tooltip="row.hasPreset ? i18n.AGENT_PRESET_EDIT : i18n.AGENT_PRESET_SAVE"
                :active="row.hasPreset"
                @click="openPreset(row.id)"
              >
                <ArrowUpOnSquareSolidIcon v-if="row.hasPreset" class="size-4" />
                <ArrowUpOnSquareIcon v-else class="size-4" />
              </AgentRowAction>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="h-7 w-7 text-muted-foreground hover:text-foreground"
                    :aria-label="row.moreLabel"
                    @click.stop
                  >
                    <EllipsisVerticalIcon class="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  class="min-w-[180px] z-[100]"
                  @close-auto-focus="keepInlineFocus"
                >
                  <DropdownMenuItem @select="startRename(row.id, row.name)">
                    <PencilIcon />
                    {{ i18n.AGENT_AGENTS_RENAME }}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    class="text-destructive focus:text-destructive"
                    :disabled="row.running"
                    @select="startDelete(row.id)"
                  >
                    <TrashIcon />
                    {{ i18n.AGENT_AGENTS_DELETE }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div
            v-if="confirmDeleteId === row.id"
            role="group"
            :aria-label="row.deleteLabel"
            class="flex items-center justify-between gap-2"
          >
            <span class="text-xs text-foreground">{{ row.deleteQuestion }}</span>
            <div class="flex flex-none gap-1">
              <Button variant="secondary" size="sm" class="h-7" @click="confirmDeleteId = null">
                {{ i18n.AGENT_AGENTS_CANCEL }}
              </Button>
              <Button variant="destructive" size="sm" class="h-7" @click="remove(row.id)">
                {{ i18n.AGENT_AGENTS_DELETE }}
              </Button>
            </div>
          </div>
        </li>
      </ul>
      <p v-else class="text-sm text-muted-foreground text-center py-1">
        {{ i18n.AGENT_AGENTS_EMPTY }}
      </p>
    </SettingsPanel>
  </TooltipProvider>

  <TaskScheduleDialog v-model:open="scheduleOpen" :task-id="scheduleTaskId" />
  <AgentPresetDialog v-model:open="presetOpen" :task-id="presetTaskId" />
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  ArrowUpOnSquareIcon,
  ClockIcon,
  CpuChipIcon,
  EllipsisVerticalIcon,
  ExclamationTriangleIcon,
  PencilIcon,
  PlayIcon,
  StopIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'
import {
  ArrowUpOnSquareIcon as ArrowUpOnSquareSolidIcon,
  ClockIcon as ClockSolidIcon,
} from '@heroicons/vue/24/solid'
import type { AgentTaskOutcome } from '@/types/agentTaskIpc'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import AgentNameField from '@/components/AgentNameField.vue'
import AgentPresetDialog from '@/components/AgentPresetDialog.vue'
import AgentRowAction from '@/components/AgentRowAction.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import TaskScheduleDialog from '@/components/TaskScheduleDialog.vue'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { createAppError } from '@/assets/js/errors/appError'
import { describeSettingsProblems } from '@/lib/sessionSettingsProblems'
import { describeNextRun } from '@/lib/taskSchedule'

const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const errors = useErrors()
const i18nStore = useI18N()
const i18n = i18nStore.state

onMounted(() => void agentTasks.loadProblemSources())

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (token, key) =>
    key in values ? String(values[key]) : token,
  )
}

function stepCount(count: number): string {
  return fill(i18n.AGENT_TASKS_STEP_COUNT, { count })
}

const loadedId = computed(() => agentTasks.openSessionTask?.id)

const renamingId = ref<string | null>(null)
const renameValue = ref('')
const confirmDeleteId = ref<string | null>(null)
const saving = ref(false)

const rows = computed(() =>
  agentTasks.sessionTasks.map((task) => {
    const state = agentTasks.taskState(task.id)
    const run = 'running' in state ? state.running : undefined
    const outcome = 'idle' in state ? state.idle : undefined
    const reasons = describeSettingsProblems(agentTasks.taskProblems(task.id), i18n)
    const schedule = scheduleOf(task.id)
    const label = { name: task.name }
    return {
      id: task.id,
      name: task.name,
      loaded: loadedId.value === task.id,
      meta: [stepCount(task.steps.length), schedule.line].filter(Boolean).join(' · '),
      running: run !== undefined,
      progress:
        run &&
        fill(run.waiting ? i18n.AGENT_TASKS_WAITING_FOR_SESSION : i18n.AGENT_TASKS_RUNNING_STEP, {
          step: run.stepIndex,
          count: run.stepCount,
        }),
      outcome: outcome && {
        label: [outcomeLabel(outcome), outcome.kind === 'failed' ? outcomeMessage(outcome) : '']
          .filter(Boolean)
          .join(': '),
        failed: outcome.kind === 'failed',
      },
      problem: reasons ? fill(i18n.AGENT_TASKS_PROBLEM, { reason: reasons }) : undefined,
      scheduled: schedule.enabled,
      scheduleTip: schedule.line ?? i18n.AGENT_AGENTS_NOT_SCHEDULED,
      selectLabel: fill(i18n.AGENT_AGENTS_SELECT_LABEL, label),
      stopLabel: fill(i18n.AGENT_TASKS_STOP, label),
      runLabel: fill(i18n.AGENT_AGENTS_RUN_LABEL, label),
      scheduleLabel: fill(i18n.AGENT_AGENTS_SCHEDULE_LABEL, label),
      hasPreset: agentTasks.presetOfAgent(task.id) !== undefined,
      presetLabel: fill(
        agentTasks.presetOfAgent(task.id)
          ? i18n.AGENT_PRESET_EDIT_LABEL
          : i18n.AGENT_PRESET_SAVE_LABEL,
        label,
      ),
      moreLabel: fill(i18n.AGENT_AGENTS_MORE_LABEL, label),
      renameLabel: fill(i18n.AGENT_AGENTS_RENAME_LABEL, label),
      deleteLabel: fill(i18n.AGENT_AGENTS_DELETE_LABEL, label),
      deleteQuestion: fill(i18n.AGENT_AGENTS_DELETE_CONFIRM, label),
    }
  }),
)

function scheduleOf(id: string): { enabled: boolean; line?: string } {
  const { schedule, nextRunAt } = agentTasks.taskSchedule(id)
  if (!schedule) return { enabled: false }
  if (!schedule.enabled) return { enabled: false, line: i18n.AGENT_TASKS_SCHEDULE_PAUSED }
  if (nextRunAt === undefined) return { enabled: true }
  const time = describeNextRun(nextRunAt, Date.now(), i18nStore.langName, {
    today: i18n.AGENT_TASKS_NEXT_RUN_TODAY,
    tomorrow: i18n.AGENT_TASKS_NEXT_RUN_TOMORROW,
  })
  return { enabled: true, line: fill(i18n.AGENT_TASKS_NEXT_RUN, { time }) }
}

function outcomeLabel({ kind, stepIndex, stepCount, reason }: AgentTaskOutcome): string {
  const step = { step: stepIndex ?? '', count: stepCount }
  switch (kind) {
    case 'completed':
      return i18n.AGENT_TASKS_OUTCOME_COMPLETED
    case 'failed':
      if (reason === 'not-started') return i18n.AGENT_TASKS_OUTCOME_NOT_STARTED
      return stepIndex
        ? fill(i18n.AGENT_TASKS_OUTCOME_FAILED_AT_STEP, step)
        : i18n.AGENT_TASKS_OUTCOME_FAILED
    case 'stopped':
      return stepIndex
        ? fill(i18n.AGENT_TASKS_OUTCOME_STOPPED_AT_STEP, step)
        : i18n.AGENT_TASKS_OUTCOME_STOPPED
  }
}

function outcomeMessage({ message, reason }: AgentTaskOutcome): string | undefined {
  if (reason === 'app-closed') return i18n.AGENT_TASKS_OUTCOME_APP_CLOSED
  if (reason === 'download-declined') return i18n.AGENT_TASKS_OUTCOME_DOWNLOAD_DECLINED
  return message
}

async function select(id: string): Promise<void> {
  renamingId.value = null
  confirmDeleteId.value = null
  await agentTasks.loadAgent(id)
}

/** The inline field a menu item opened takes focus, not the menu's trigger. */
function keepInlineFocus(event: Event): void {
  if (renamingId.value) event.preventDefault()
}

function startRename(id: string, name: string): void {
  confirmDeleteId.value = null
  renamingId.value = id
  renameValue.value = name
}

function startDelete(id: string): void {
  renamingId.value = null
  confirmDeleteId.value = id
}

async function rename(id: string): Promise<void> {
  saving.value = true
  try {
    if ((await agentTasks.renameAgent(id, renameValue.value)).ok) renamingId.value = null
  } finally {
    saving.value = false
  }
}

async function remove(id: string): Promise<void> {
  confirmDeleteId.value = null
  await agentTasks.deleteTask(id)
}

const presetOpen = ref(false)
const presetTaskId = ref<string | null>(null)

function openPreset(id: string): void {
  presetTaskId.value = id
  presetOpen.value = true
}

const scheduleOpen = ref(false)
const scheduleTaskId = ref<string | null>(null)

function openSchedule(id: string): void {
  scheduleTaskId.value = id
  scheduleOpen.value = true
}

async function runNow(id: string): Promise<void> {
  const result = await agentTasks.runTask(id)
  if (result.ok) return
  if (result.reason !== 'settings-problems') return
  errors.report(
    createAppError({
      category: 'validation',
      code: 'agent-tasks/run-blocked',
      severity: 'warning',
      surface: 'toast',
      userMessage: fill(i18n.AGENT_TASKS_RUN_BLOCKED, { reason: result.message }),
    }),
  )
}
</script>
