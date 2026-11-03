<template>
  <div class="flex flex-col gap-6">
    <div class="flex items-start gap-3">
      <UserCircleIcon class="size-8 shrink-0 text-foreground/90" />
      <div class="flex flex-col gap-1 max-w-4/5 bg-muted rounded-md px-4 py-3">
        <p class="text-muted-foreground text-sm">{{ languages.ANSWER_USER_NAME }}</p>
        <p v-if="prompt" class="whitespace-pre-wrap wrap-break-word">{{ prompt }}</p>
        <p v-else class="text-muted-foreground italic">{{ preset }}</p>
      </div>
    </div>
    <div role="article" aria-label="Assistant response" class="flex items-start gap-3">
      <img class="size-8 shrink-0" src="../assets/svg/ai-icon.svg" alt="" />
      <div class="flex flex-col gap-3 min-w-0">
        <p class="text-muted-foreground text-sm">
          {{ languages.ANSWER_AI_NAME }} · <span>{{ preset }}</span>
        </p>
        <ChatWorkflowResult
          :images="items"
          :phase="phase"
          :progress="progress"
          :hide-mode-switch="mode === 'video'"
        />
        <p v-if="!phase && status === 'failed'" class="text-sm text-red-500 wrap-break-word">
          {{ languages.COM_GENERATE_FAILED }}<template v-if="error">: {{ error }}</template>
        </p>
        <p v-else-if="!phase && status === 'cancelled'" class="text-sm text-muted-foreground">
          {{ languages.SESSION_TURN_CANCELLED }}
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { UserCircleIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import ChatWorkflowResult from '@/components/ChatWorkflowResult.vue'
import type { ArtifactPhase } from '@/types/kernelEvents'
import type { MediaItem } from '@/types/mediaItem'
import type { MediaTurnData, MediaTurnStatus } from '@/types/sessionTimeline'

defineProps<{
  prompt: string
  preset: string
  mode: MediaTurnData['mode']
  items: MediaItem[]
  /** Set only while the run is in flight. */
  phase?: ArtifactPhase
  progress?: { current: number; max: number }
  status?: MediaTurnStatus
  error?: string
}>()

const languages = useI18N().state
</script>
