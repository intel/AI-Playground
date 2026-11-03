<template>
  <ScrollToBottomButton v-if="showScrollButton" @click="scrollToBottom()" />
  <div ref="panel" class="flex-1 overflow-y-auto px-4 py-6 flex flex-col relative">
    <slot name="top" />
    <template v-if="turns.length === 0 && !pending && !pendingAudio">
      <slot name="empty">
        <div class="flex-1 flex items-center justify-center text-muted-foreground text-center">
          {{ languages.SESSION_TIMELINE_EMPTY }}
        </div>
      </slot>
    </template>
    <div v-else class="w-full max-w-4xl mx-auto flex flex-col gap-6">
      <template v-for="turn in turns" :key="turn.id">
        <MediaTurnBlock
          v-if="turn.kind === 'media'"
          :prompt="turn.prompt"
          :preset="turn.media.preset"
          :mode="turn.media.mode"
          :items="turn.media.items"
          :status="turn.media.status"
          :error="turn.media.error"
          :deleted-urls="sessions.openDeletedFiles"
          @delete-file="(url) => gallery.removeByUrl(url)"
        />
        <div v-else-if="turn.kind === 'agent'" class="flex flex-col gap-4">
          <AgentTurnBlock
            v-if="isLiveBlock(turn)"
            :messages="turn.messages"
            :live="liveAgent?.live"
            :queued-message-id="liveAgent?.queuedMessageId"
            :not-run-message-id="liveAgent?.notRunMessageId"
            :can-resend="liveAgent?.canResend"
            @resend="emit('resend')"
          />
          <AgentTurnBlock v-else :messages="turn.messages" />
        </div>
        <ChatTurnBlock v-else-if="turn.kind === 'chat'" :messages="turn.messages" />
        <AudioTurnBlock
          v-else-if="turn.kind === 'audio'"
          :prompt="turn.prompt"
          :preset="turn.audio.preset"
          :kind="turn.audio.kind"
          :audio-url="turn.audio.audioUrl"
          :transcript="turn.audio.transcript"
          :engine="turn.audio.engine"
          :status="turn.audio.status"
          :error="turn.audio.error"
          :file-deleted="!!turn.audio.audioUrl && sessions.isFileDeleted(turn.audio.audioUrl)"
        />
        <div
          v-else
          class="text-sm text-muted-foreground whitespace-pre-wrap"
          :class="turn.message.role === 'user' ? 'self-end' : 'self-start'"
        >
          {{ messageText(turn.message) }}
        </div>
      </template>
      <MediaTurnBlock
        v-if="pending"
        :prompt="pending.turn.prompt"
        :preset="pending.turn.preset"
        :mode="pending.turn.mode"
        :items="pending.run?.items ?? []"
        :phase="pending.run?.phase ?? 'queued'"
        :progress="pending.run?.progress"
      />
      <AudioTurnBlock
        v-if="pendingAudio"
        :prompt="pendingAudio.prompt"
        :preset="pendingAudio.preset"
        :kind="pendingAudio.kind"
        :phase="pendingAudio.phase"
      />
    </div>
    <div class="w-full max-w-4xl mx-auto flex flex-col gap-4" :class="{ 'mt-4': turns.length }">
      <slot name="bottom" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useArtifactRuns } from '@/assets/js/store/artifactRuns'
import { useErrors } from '@/assets/js/store/errors'
import { useGallery } from '@/assets/js/store/gallery'
import { useI18N } from '@/assets/js/store/i18n'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import { usePresets } from '@/assets/js/store/presets'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { useSessionAudio } from '@/assets/js/store/sessionAudio'
import { useSessions } from '@/assets/js/store/sessions'
import AudioTurnBlock from '@/components/AudioTurnBlock.vue'
import MediaTurnBlock from '@/components/MediaTurnBlock.vue'
import AgentTurnBlock from '@/components/AgentTurnBlock.vue'
import ChatTurnBlock from '@/components/ChatTurnBlock.vue'
import { isCancellation } from '@/assets/js/errors/appError'
import ScrollToBottomButton from '@/components/ScrollToBottomButton.vue'
import {
  timelineTurns,
  withLiveAgentTurn,
  type LiveAgentTurn,
  type TimelineTurn,
} from '@/lib/sessionTimeline'
import { useStickToBottom } from '@/lib/useStickToBottom'
import type { TimelineMessage } from '@/types/sessionTimeline'

/** The main area for a Session: every turn of its display timeline, in order. */
const props = defineProps<{ mode: ModeType; liveAgent?: LiveAgentTurn }>()
const emit = defineEmits<{ resend: [] }>()

const sessions = useSessions()
const gallery = useGallery()
const artifactRuns = useArtifactRuns()
const imageGeneration = useImageGenerationPresets()
const promptStore = usePromptStore()
const presets = usePresets()
const sessionAudio = useSessionAudio()
const errors = useErrors()
const languages = useI18N().state
const panel = ref<HTMLElement | null>(null)

const turns = computed(() => {
  const live = props.liveAgent
  const timeline = live
    ? withLiveAgentTurn(sessions.openTimeline, live.tag, live.messages)
    : sessions.openTimeline
  return timelineTurns(timeline)
})

/** The last block of the live Harness Session carries its queued / not-run markers. */
function isLiveBlock(turn: TimelineTurn): boolean {
  const live = props.liveAgent
  if (!live || turn.kind !== 'agent') return false
  const last = turns.value.findLast((candidate) => candidate.kind === 'agent')
  return last === turn && turn.harnessSessionId === live.tag.harnessSessionId
}

const pending = computed(() => {
  const id = sessions.openSessionId
  const turn = id ? sessions.pendingTurns[id] : undefined
  if (!turn) return null
  const settled = turns.value.some(
    (candidate) => candidate.kind === 'media' && candidate.media.runId === turn.runId,
  )
  if (settled) return null
  return { turn, run: artifactRuns.state.runs[turn.runId] }
})

const pendingAudio = computed(() => sessionAudio.pendingTurn)

function messageText(message: TimelineMessage): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

const { showScrollButton, scrollToBottom } = useStickToBottom(panel)

watch(
  () => sessions.openSessionId,
  () => nextTick(() => scrollToBottom(false)),
)

defineExpose({ scrollToBottom })

const mediaMode = computed<WorkflowModeType | null>(() =>
  props.mode === 'imageGen' || props.mode === 'imageEdit' || props.mode === 'video'
    ? props.mode
    : null,
)

async function generate(prompt: string): Promise<void> {
  const mode = mediaMode.value
  if (!mode) return
  try {
    imageGeneration.prompt = prompt
    await imageGeneration.generate(mode)
  } catch (error) {
    promptStore.promptSubmitted = false
    imageGeneration.processing = false
    if (isCancellation(error)) return
    errors.report(error, {
      category: 'generation',
      code: 'generation/submit-failed',
      userMessage: 'Image generation could not be started.',
    })
  }
}

async function synthesize(text: string): Promise<void> {
  const preset = presets.activePreset
  if (preset?.type !== 'chat' || !preset.ttsPreset) {
    promptStore.promptSubmitted = false
    return
  }
  await sessionAudio.synthesize(text)
}

onMounted(() => {
  scrollToBottom(false)
  if (props.mode === 'audio') promptStore.registerSubmitCallback('audio', synthesize)
  if (!mediaMode.value) return
  promptStore.registerSubmitCallback(mediaMode.value, generate)
  promptStore.registerCancelCallback(mediaMode.value, () => imageGeneration.stopGeneration())
})

onUnmounted(() => {
  if (props.mode === 'audio') promptStore.unregisterSubmitCallback('audio')
  if (!mediaMode.value) return
  promptStore.unregisterSubmitCallback(mediaMode.value)
  promptStore.unregisterCancelCallback(mediaMode.value)
})
</script>
