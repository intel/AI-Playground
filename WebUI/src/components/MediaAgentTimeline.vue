<template>
  <div
    v-if="run || fallbackSteps?.length"
    class="flex flex-col gap-1.5 text-xs"
    role="group"
    aria-label="Media specialist progress"
  >
    <!-- Live run: one row per inner tool call, newest last. -->
    <template v-if="run">
      <div v-for="step in run.steps" :key="step.toolCallId" class="flex flex-col gap-1">
        <div class="flex items-center gap-2">
          <span class="shrink-0" :class="stepGlyphClass(step)" aria-hidden="true">{{
            stepGlyph(step)
          }}</span>
          <span class="truncate text-foreground">{{ stepTitle(step) }}</span>
          <span v-if="step.workflow" class="truncate text-muted-foreground">
            · {{ step.workflow }}
          </span>
          <span v-if="step.state === 'done' && step.media.length" class="text-muted-foreground">
            · {{ mediaSummary(step.media) }}
          </span>
        </div>

        <div v-if="step.state === 'running'" class="flex items-center gap-2 pl-6">
          <span class="truncate text-muted-foreground">{{ step.label }}</span>
          <span v-if="step.progress !== undefined" class="shrink-0 tabular-nums opacity-70">
            {{ percent(step.progress) }}%
          </span>
        </div>
        <div
          v-if="step.state === 'running' && step.progress !== undefined"
          class="ml-6 h-1 w-48 max-w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          :aria-valuenow="percent(step.progress)"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <div
            class="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
            :style="{ width: `${percent(step.progress)}%` }"
          ></div>
        </div>

        <p v-if="step.error" class="pl-6 text-destructive">{{ step.error }}</p>

        <!-- Media as it lands, so a finished step is visible before the whole run is. -->
        <div v-if="step.media.length" class="flex flex-wrap items-center gap-1.5 pl-6">
          <template v-for="item in step.media" :key="item.id">
            <img
              v-if="item.type === 'image'"
              :src="item.imageUrl"
              alt="Generated result"
              class="size-12 rounded border border-border object-cover"
            />
            <video
              v-else-if="item.type === 'video'"
              :src="item.videoUrl"
              muted
              class="size-12 rounded border border-border object-cover"
            />
            <span v-else class="rounded border border-border px-1.5 py-0.5 text-muted-foreground">
              3D model
            </span>
          </template>
        </div>
      </div>

      <!-- Between tool calls the specialist is thinking; show what it says. -->
      <div v-if="run.state === 'running' && run.phase === 'planning'" class="flex flex-col gap-1">
        <div class="flex items-center gap-2">
          <span class="shrink-0 text-muted-foreground" aria-hidden="true">·</span>
          <span class="text-muted-foreground">{{ planningLabel }}</span>
        </div>
        <div v-if="run.narration.trim()" class="pl-6">
          <ChatReasoningDisplay
            :text="run.narration"
            :streaming="true"
            :live-started-at="run.narrationStartedAt"
          />
        </div>
      </div>
    </template>

    <!-- No live run (e.g. after a reload): the step lines kept in the tool output. -->
    <template v-else>
      <span v-for="(step, index) in fallbackSteps" :key="index" class="text-muted-foreground">
        {{ step }}
      </span>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import ChatReasoningDisplay from '@/components/ChatReasoningDisplay.vue'
import { useMediaAgentRuns, type MediaRunStep } from '@/assets/js/store/mediaAgentRuns'
import type { MediaItem } from '@/assets/js/store/imageGenerationPresets'

const props = defineProps<{
  /** Delegating tool call id; keys the live run (see mediaAgentRuns). */
  toolCallId?: string
  /** Step lines from a finished tool result, shown when there is no live run. */
  fallbackSteps?: string[]
}>()

const mediaRuns = useMediaAgentRuns()

const run = computed(() => mediaRuns.run(props.toolCallId))

// Once every step is settled the specialist is writing its closing report
// rather than deciding on another tool call.
const planningLabel = computed(() =>
  run.value?.steps.length ? 'Finishing up…' : 'Choosing a workflow…',
)

function stepTitle(step: MediaRunStep): string {
  const transform = step.toolName === 'comfyUiImageEdit'
  if (step.state === 'running') return transform ? 'Transforming image' : 'Generating media'
  if (step.state === 'failed') return transform ? 'Transform failed' : 'Generation failed'
  return transform ? 'Transformed image' : 'Generated media'
}

function stepGlyph(step: MediaRunStep): string {
  if (step.state === 'running') return '⟳'
  return step.state === 'failed' ? '✕' : '✓'
}

function stepGlyphClass(step: MediaRunStep): string {
  if (step.state === 'running') return 'animate-spin text-muted-foreground'
  return step.state === 'failed' ? 'text-destructive' : 'text-green-600'
}

function mediaSummary(media: MediaItem[]): string {
  const counts = new Map<string, number>()
  for (const item of media) {
    const noun = item.type === 'model3d' ? '3D model' : item.type
    counts.set(noun, (counts.get(noun) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([noun, count]) => `${count} ${noun}${count > 1 ? 's' : ''}`)
    .join(', ')
}

function percent(progress: number): number {
  return Math.round(progress * 100)
}
</script>
