<template>
  <div class="flex flex-col gap-4 p-4 w-full max-w-3xl mx-auto">
    <template v-if="panel.editSteps">
      <AgentSaveBar />
      <SettingsSection :title="i18n.AGENT_TASK_STEPS" :summary="stepsSummary">
        <TaskStepsEditor
          :steps="agentMode.openSteps"
          id-prefix="agent-steps"
          @update:steps="agentMode.setOpenSteps"
        />
        <p class="text-xs text-muted-foreground">{{ i18n.AGENT_STEPS_HINT }}</p>
      </SettingsSection>
    </template>
    <p
      v-if="panel.editNote"
      class="text-sm text-muted-foreground rounded-sm ring-1 ring-border px-3 py-2"
    >
      {{ i18n.SESSION_SCHEDULES_EDIT_NOTE }}
    </p>
    <SettingsAgents
      v-if="panel.agentList"
      :load="panel.agentList.load"
      :save-as-preset="panel.agentList.saveAsPreset"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useI18N } from '@/assets/js/store/i18n'
import AgentSaveBar from '@/components/AgentSaveBar.vue'
import SettingsAgents from '@/components/SettingsAgents.vue'
import SettingsSection from '@/components/SettingsSection.vue'
import TaskStepsEditor from '@/components/TaskStepsEditor.vue'
import { schedulesPanel, type SchedulesAllowance } from '@/lib/sessionTabs'

const props = defineProps<{ allowance: SchedulesAllowance }>()

const agentMode = useAgentMode()
const i18n = useI18N().state

const panel = computed(() => schedulesPanel(props.allowance))

const stepsSummary = computed(() =>
  i18n.AGENT_TASKS_STEP_COUNT.replace('{count}', String(agentMode.openSteps.length)),
)
</script>
