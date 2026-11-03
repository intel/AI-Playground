<template>
  <div ref="panel" class="flex-1 overflow-y-auto px-4 py-6 flex flex-col">
    <div
      v-if="turns.length === 0 && !pending"
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useArtifactRuns } from '@/assets/js/store/artifactRuns'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { useSessions } from '@/assets/js/store/sessions'
import MediaTurnBlock from '@/components/MediaTurnBlock.vue'
import { isCancellation } from '@/assets/js/errors/appError'
import { timelineTurns } from '@/lib/sessionTimeline'
import type { TimelineMessage } from '@/types/sessionTimeline'

/** The main area for a Session: every turn of its display timeline, in order. */
const props = defineProps<{ mode: ModeType }>()

const sessions = useSessions()
const artifactRuns = useArtifactRuns()
const imageGeneration = useImageGenerationPresets()
const promptStore = usePromptStore()
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

function messageText(message: TimelineMessage): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

function scrollToBottom(): void {
  void nextTick(() => {
    if (panel.value) panel.value.scrollTop = panel.value.scrollHeight
  })
}

watch(() => [sessions.openSessionId, turns.value.length, !!pending.value], scrollToBottom)

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

onMounted(() => {
  scrollToBottom()
  if (!mediaMode.value) return
  promptStore.registerSubmitCallback(mediaMode.value, generate)
  promptStore.registerCancelCallback(mediaMode.value, () => imageGeneration.stopGeneration())
})

onUnmounted(() => {
  if (!mediaMode.value) return
  promptStore.unregisterSubmitCallback(mediaMode.value)
  promptStore.unregisterCancelCallback(mediaMode.value)
})
</script>
