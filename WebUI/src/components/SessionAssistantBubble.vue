<template>
  <div role="article" aria-label="Assistant response" class="flex items-start gap-3">
    <img
      :class="textInference.iconSizeClass"
      class="shrink-0"
      src="../assets/svg/ai-icon.svg"
      alt=""
    />
    <div class="flex flex-col gap-3 max-w-[90%] w-full min-w-0 text-wrap wrap-break-word">
      <div class="flex items-center gap-2">
        <p class="text-muted-foreground mt-0.75" :class="textInference.nameSizeClass">
          {{ languages.ANSWER_AI_NAME }}
        </p>
        <span
          v-if="label"
          class="bg-secondary text-foreground font-sans rounded-md px-1 py-1"
          :class="textInference.nameSizeClass"
        >
          {{ label }}
        </span>
        <slot name="badges" />
      </div>
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import { useTextInference } from '@/assets/js/store/textInference'

/** The answering side of every turn in a Session; `label` names the model or preset. */
defineProps<{ label?: string }>()

const textInference = useTextInference()
const languages = useI18N().state
</script>
