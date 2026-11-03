<template>
  <Collapsible
    v-model:open="open"
    role="group"
    :aria-label="label"
    class="rounded-lg border border-border bg-muted/30"
  >
    <CollapsibleTrigger as-child>
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground"
        :aria-label="label"
      >
        <ChevronRightIcon
          class="size-4 flex-none text-muted-foreground transition-transform"
          :class="{ 'rotate-90': open }"
          aria-hidden="true"
        />
        <CpuChipIcon class="size-4 flex-none text-muted-foreground" aria-hidden="true" />
        <span class="truncate font-medium">{{ taskRun.taskName }}</span>
        <span class="ml-auto flex-none text-xs text-muted-foreground">{{ time }}</span>
      </button>
    </CollapsibleTrigger>
    <CollapsibleContent class="flex flex-col gap-4 px-3 pb-3">
      <AgentTurnBlock :messages="messages" />
    </CollapsibleContent>
  </Collapsible>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { UIMessage } from 'ai'
import { ChevronRightIcon, CpuChipIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import AgentTurnBlock from '@/components/AgentTurnBlock.vue'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { TaskRunTag } from '@/types/sessionTimeline'

/** One Task Run in the Session timeline, folded under its Task's name and start time. */
const props = defineProps<{ taskRun: TaskRunTag; messages: UIMessage[] }>()

const i18nStore = useI18N()
const open = ref(false)

const time = computed(() =>
  new Date(props.taskRun.startedAt).toLocaleString(i18nStore.langName, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }),
)

const label = computed(() =>
  i18nStore.state.SESSION_TIMELINE_TASK_RUN.replace('{name}', props.taskRun.taskName).replace(
    '{time}',
    time.value,
  ),
)
</script>
