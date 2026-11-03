<template>
  <ScrollToBottomButton v-if="showScrollButton" @click="scrollToBottom()" />
  <div class="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-6 relative" ref="panel">
    <div class="w-full max-w-4xl mx-auto flex flex-col gap-4">
      <!-- Game Agent works on one game at a time, and what to do with that game
           (play it, save it to the library, open its folder) belongs next to it —
           and stays reachable once the transcript has scrolled past it. Pinned to
           the top, it shares that line with the floating "Show Sessions" button
           (App.vue), so it takes only the width it needs and keeps to the right. -->
      <div v-if="isGameAgent" class="sticky top-0 z-5 flex justify-end pl-32 pr-32">
        <GameBar />
      </div>

      <!-- Empty state: configuration lives in the settings sidebar, model/context in
           the prompt status bar — so an empty transcript just needs a hint. -->
      <div
        v-if="agentMode.messages.length === 0 && !agentMode.processing"
        class="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground"
      >
        <img src="../assets/svg/ai-icon.svg" class="size-10 opacity-60" />
        <template v-if="emptyStateKind === 'game-agent'">
          <p class="text-sm">
            Describe the game you want — the agent writes it as a single HTML page, draws the art,
            play-tests it in a browser and saves it to your library.
          </p>
          <p class="text-xs">Try: “a one-button endless runner where I dodge asteroids”.</p>
        </template>
        <template v-else-if="emptyStateKind === 'quick-coder'">
          <p class="text-sm">
            Describe the game you want — the agent plans it, then writes the whole thing into one
            HTML file. No generated art and no play-testing, so it finishes in minutes.
          </p>
          <p class="text-xs">Try: “a one-button endless runner where I dodge asteroids”.</p>
        </template>
        <template v-else>
          <p class="text-sm">
            The agent works on files in this Session's folder — it can write code, run shell
            commands, debug web pages and generate media.
          </p>
          <p v-if="agentMode.workspaceDir" class="text-xs break-all">
            Workspace: <span class="text-foreground/80">{{ agentMode.workspaceDir }}</span>
          </p>
          <p class="text-xs">Configure model and tools in {{ settingsLabel }}.</p>
        </template>
      </div>

      <AgentTurnBlock
        :messages="agentMode.messages"
        :live="agentMode.processing"
        :queued-message-id="queuedMessageId"
        :not-run-message-id="agentMode.notRunMessages[agentMode.openSessionId]"
        :can-resend="agentMode.canResendNotRun"
        @resend="agentMode.resendNotRun()"
      />

      <!-- A tool can put a question to the user mid-turn (Quick Coder offering to
           hand the game to Game Agent). Same card as Chat, keyed by the session. -->
      <ChatConfirmation :conversation-key="agentMode.openSessionId" with-avatar />

      <div
        v-if="agentMode.processing"
        class="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <span class="inline-block size-2 rounded-full bg-current animate-pulse"></span>
        <span>{{
          agentMode.turnState === 'queued' ? languages.AGENT_TURN_QUEUED_DETAIL : busyLabel
        }}</span>
      </div>
      <div v-if="heldAnswer" class="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          role="status"
          class="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5"
        >
          <ChatBubbleLeftEllipsisIcon class="size-3.5" aria-hidden="true" />
          {{ withChannel(languages.AGENT_HELD_ANSWER_WAITING, heldAnswer.channel) }}
        </span>
        <TooltipProvider :delay-duration="200">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="secondary"
                size="sm"
                class="h-6 px-2 text-xs"
                :aria-label="
                  withChannel(languages.AGENT_HELD_ANSWER_DISCARD_HINT, heldAnswer.channel)
                "
                @click="agentMode.discardHeldAnswer(agentMode.openSessionId)"
              >
                <XMarkIcon class="size-3.5" aria-hidden="true" />
                {{ languages.AGENT_HELD_ANSWER_DISCARD }}
              </Button>
            </TooltipTrigger>
            <TooltipContent class="max-w-xs">
              {{ withChannel(languages.AGENT_HELD_ANSWER_DISCARD_HINT, heldAnswer.channel) }}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div
        v-if="agentMode.chat.error"
        class="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
      >
        {{ agentMode.chat.error.message }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import AgentTurnBlock from '@/components/AgentTurnBlock.vue'
import ChatConfirmation from '@/components/ChatConfirmation.vue'
import GameBar from '@/components/GameBar.vue'
import ScrollToBottomButton from '@/components/ScrollToBottomButton.vue'
import { busyLabelOf } from '@/lib/agentTranscript'
import { agentEmptyStateKind } from '@/lib/presetModes'
import { useStickToBottom } from '@/lib/useStickToBottom'
import { useMediaAgentRuns } from '@/assets/js/store/mediaAgentRuns'
import { ensureMediaAgentEventWiring } from '@/assets/js/agents/mediaAgent'
import { useI18N } from '@/assets/js/store/i18n'
import { useModeSettingsLabel } from '@/assets/js/modeSettingsLabel'
import { getDescriptor } from '@/assets/js/store/channels/channelRegistry'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import { fillTemplate } from '@/lib/notificationLabel'
import { ChatBubbleLeftEllipsisIcon, XMarkIcon } from '@heroicons/vue/24/outline'

const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const promptStore = usePromptStore()
const mediaRuns = useMediaAgentRuns()
const languages = useI18N().state
const settingsLabel = useModeSettingsLabel('agent')

const panel = ref<HTMLElement | null>(null)
const { showScrollButton, scrollToBottom } = useStickToBottom(panel)

// The game bar and the game-specific empty state belong to the preset that works
// on a managed game folder, not to Agent Mode in general.
const isGameAgent = computed(() => agentMode.agentWorkspaceKind === 'games')
const emptyStateKind = computed(() => agentEmptyStateKind(agentMode.activeAgentPreset?.name))

/** The sent message of a turn still waiting in the Turn Queue. */
const queuedMessageId = computed(() =>
  agentMode.turnState === 'queued'
    ? agentMode.messages.findLast((entry) => entry.role === 'user')?.id
    : undefined,
)

function withChannel(template: string, channel: ChannelKind): string {
  const name = getDescriptor(channel)?.displayName ?? channel
  return fillTemplate(template, { channel: name })
}

const heldAnswer = computed(() => agentMode.heldAnswers[agentMode.openSessionId])

const busyLabel = computed<string>(() =>
  busyLabelOf(agentMode.messages.at(-1)?.parts ?? [], (toolCallId) =>
    mediaRuns.activeStepLabel(toolCallId),
  ),
)

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
