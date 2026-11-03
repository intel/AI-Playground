<template>
  <div class="flex flex-col gap-6">
    <div class="flex items-start gap-3">
      <UserCircleIcon class="size-8 shrink-0 text-foreground/90" />
      <div class="flex flex-col gap-2 max-w-4/5 bg-muted rounded-md px-4 py-3">
        <p class="text-muted-foreground text-sm">{{ languages.ANSWER_USER_NAME }}</p>
        <p class="whitespace-pre-wrap wrap-break-word">{{ prompt || preset }}</p>
        <audio
          v-if="kind === 'stt' && audioUrl"
          controls
          class="w-full max-w-md"
          :src="audioUrl"
          :aria-label="prompt"
        />
      </div>
    </div>
    <div role="article" aria-label="Assistant response" class="flex items-start gap-3">
      <img class="size-8 shrink-0" src="../assets/svg/ai-icon.svg" alt="" />
      <div class="flex flex-col gap-3 min-w-0">
        <p class="text-muted-foreground text-sm">
          {{ languages.ANSWER_AI_NAME }} · <span>{{ engine ?? preset }}</span>
        </p>
        <p v-if="phase" role="status" class="text-sm text-muted-foreground animate-pulse">
          {{ phaseLabel }}
        </p>
        <template v-else-if="status === 'completed'">
          <audio
            v-if="kind === 'tts' && audioUrl"
            controls
            class="w-full max-w-md"
            :src="audioUrl"
            aria-label="Generated speech"
          />
          <p v-if="kind === 'stt'" class="whitespace-pre-wrap wrap-break-word">
            {{ transcript }}
          </p>
        </template>
        <p v-else-if="status === 'failed'" class="text-sm text-red-500 wrap-break-word">
          {{
            kind === 'tts'
              ? languages.SESSION_AUDIO_TTS_FAILED
              : languages.SESSION_AUDIO_STT_FAILED
          }}<template v-if="error">: {{ error }}</template>
        </p>
        <p v-else-if="status === 'cancelled'" class="text-sm text-muted-foreground">
          {{ languages.SESSION_AUDIO_CANCELLED }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { UserCircleIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import type { AudioTurnPhase } from '@/assets/js/store/sessionAudio'
import type { AudioTurnData, MediaTurnStatus } from '@/types/sessionTimeline'

const props = defineProps<{
  prompt: string
  preset: string
  kind: AudioTurnData['kind']
  audioUrl?: string
  transcript?: string
  engine?: string
  /** Set only while the turn is running. */
  phase?: AudioTurnPhase
  status?: MediaTurnStatus
  error?: string
}>()

const languages = useI18N().state

const phaseLabel = computed(() => {
  if (props.phase === 'loading-model') return languages.SESSION_AUDIO_LOADING_VOICE
  if (props.phase === 'generating') return languages.SESSION_AUDIO_GENERATING
  return languages.SESSION_AUDIO_TRANSCRIBING
})
</script>
