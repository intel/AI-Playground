<template>
  <!-- In a Session the agent's turns are part of the one Session timeline, the
       running turn streaming into it beside every other preset's turns. -->
  <SessionTimeline
    v-if="inSession"
    ref="timeline"
    mode="agent"
    :live-agent="liveAgent"
    @resend="agentMode.resendNotRun()"
  >
    <template v-if="!agentMode.processing" #empty>
      <AgentEmptyState />
    </template>
    <template #bottom>
      <AgentTurnStatus />
    </template>
  </SessionTimeline>
  <template v-else>
    <ScrollToBottomButton v-if="showScrollButton" @click="scrollToBottom()" />
    <div class="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-6 relative" ref="panel">
      <div class="w-full max-w-4xl mx-auto flex flex-col gap-4">
        <!-- Game Agent works on one game at a time, and what to do with that game
             (play it, save it to the library, open its folder) belongs next to it —
             and stays reachable once the transcript has scrolled past it. -->
        <div v-if="isGameAgent" class="sticky top-0 z-5 flex justify-end pl-32 pr-32">
          <GameBar />
        </div>

        <AgentEmptyState v-if="agentMode.messages.length === 0 && !agentMode.processing" />

        <AgentTurnBlock
          :messages="agentMode.messages"
          :live="agentMode.processing"
          :queued-message-id="queuedMessageId"
          :not-run-message-id="agentMode.notRunMessages[agentMode.openSessionId]"
          :can-resend="agentMode.canResendNotRun"
          @resend="agentMode.resendNotRun()"
        />

        <AgentTurnStatus />
      </div>
    </div>
  </template>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { useSessions } from '@/assets/js/store/sessions'
import AgentEmptyState from '@/components/AgentEmptyState.vue'
import AgentTurnBlock from '@/components/AgentTurnBlock.vue'
import AgentTurnStatus from '@/components/AgentTurnStatus.vue'
import GameBar from '@/components/GameBar.vue'
import ScrollToBottomButton from '@/components/ScrollToBottomButton.vue'
import SessionTimeline from '@/views/SessionTimeline.vue'
import { useStickToBottom } from '@/lib/useStickToBottom'
import { ensureMediaAgentEventWiring } from '@/assets/js/agents/mediaAgent'
import type { LiveAgentTurn } from '@/lib/sessionTimeline'

const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const promptStore = usePromptStore()
const sessions = useSessions()

const panel = ref<HTMLElement | null>(null)
const timeline = ref<InstanceType<typeof SessionTimeline> | null>(null)
const { showScrollButton, scrollToBottom: scrollPanel } = useStickToBottom(panel)

function scrollToBottom(smooth = true) {
  if (timeline.value) timeline.value.scrollToBottom(smooth)
  else scrollPanel(smooth)
}

// The game bar belongs to the presets that work on a managed game folder.
const isGameAgent = computed(() => agentMode.agentWorkspaceKind === 'games')
const inSession = computed(() => !isGameAgent.value && !!sessions.openSessionId)

/** The sent message of a turn still waiting in the Turn Queue. */
const queuedMessageId = computed(() =>
  agentMode.turnState === 'queued'
    ? agentMode.messages.findLast((entry) => entry.role === 'user')?.id
    : undefined,
)

const liveAgent = computed<LiveAgentTurn>(() => ({
  tag: { presetName: agentMode.agentPresetName, harnessSessionId: agentMode.openSessionId },
  messages: agentMode.messages,
  live: agentMode.processing,
  queuedMessageId: queuedMessageId.value,
  notRunMessageId: agentMode.notRunMessages[agentMode.openSessionId],
  canResend: agentMode.canResendNotRun,
}))

function handlePromptSubmit(prompt: string) {
  scrollToBottom()
  void agentTasks.submitPrompt(prompt)
}

// A run may be between Steps with no turn to stop, so the run is stopped instead.
function handleCancel() {
  const sessionId = agentMode.openSessionId
  const task = agentTasks.taskLockingSession(sessionId)
  if (task) void agentTasks.stopTask(task.id)
  else if (agentTasks.promptRunOf(sessionId)) void agentTasks.stopPromptRun(sessionId)
  else void agentMode.stop()
}

watch(
  () => agentMode.openSessionId,
  () => nextTick(() => scrollToBottom(false)),
)

onMounted(() => {
  promptStore.registerSubmitCallback('agent', handlePromptSubmit)
  promptStore.registerCancelCallback('agent', handleCancel)
  ensureMediaAgentEventWiring()
  agentMode.setViewShown(true)
})

onUnmounted(() => {
  agentMode.setViewShown(false)
  promptStore.unregisterSubmitCallback('agent')
  promptStore.unregisterCancelCallback('agent')
})
</script>
