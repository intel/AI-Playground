<template>
  <div class="flex items-start gap-3">
    <UserCircleIcon :class="textInference.iconSizeClass" class="shrink-0 text-foreground/90" />
    <div
      class="flex flex-col gap-3 max-w-4/5 bg-muted rounded-md px-4 py-3 wrap-break-word"
      :class="textInference.fontSizeClass"
    >
      <p class="text-muted-foreground" :class="textInference.nameSizeClass">
        {{ languages.ANSWER_USER_NAME }}
      </p>
      <slot />
    </div>
    <slot name="aside" />
  </div>
</template>

<script setup lang="ts">
import { UserCircleIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import { useTextInference } from '@/assets/js/store/textInference'

/** The user's side of every turn in a Session, whichever preset ran it. */
const textInference = useTextInference()
const languages = useI18N().state
</script>
