<template>
  <div ref="panel" class="flex-1 overflow-y-auto px-4 py-6 flex flex-col">
    <div
      v-if="turns.length === 0 && !pending && !pendingAudio"
      class="flex-1 flex items-center justify-center text-muted-foreground text-center"
    >
      {{ languages.SESSION_TIMELINE_EMPTY }}
    </div>
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
          <AgentTurnBlock :messages="turn.messages" />
        </div>
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
import { isCancellation } from '@/assets/js/errors/appError'
import { timelineTurns } from '@/lib/sessionTimeline'
import type { TimelineMessage } from '@/types/sessionTimeline'

/** The main area for a Session: every turn of its display timeline, in order. */
const props = defineProps<{ mode: ModeType }>()

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

const turns = computed(() => timelineTurns(sessions.openTimeline))

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

function scrollToBottom(): void {
  void nextTick(() => {
    if (panel.value) panel.value.scrollTop = panel.value.scrollHeight
  })
}

watch(
  () => [sessions.openSessionId, turns.value.length, !!pending.value, !!pendingAudio.value],
  scrollToBottom,
)

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
  scrollToBottom()
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
