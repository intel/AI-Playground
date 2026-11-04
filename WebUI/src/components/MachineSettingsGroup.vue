<template>
  <section
    role="group"
    :aria-labelledby="headingId"
    class="flex flex-col gap-4 rounded-md border border-border bg-muted/30 p-3"
  >
    <div class="flex flex-col gap-1">
      <SettingsHeading :id="headingId">{{
        languages.SESSION_SETTINGS_APPLIES_TO_ALL
      }}</SettingsHeading>
      <p v-if="note" class="text-xs text-muted-foreground">{{ note }}</p>
    </div>
    <slot />
  </section>
</template>

<script setup lang="ts">
import { useId } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import SettingsHeading from '@/components/SettingsHeading.vue'

defineProps<{ note?: string }>()

const languages = useI18N().state
const headingId = useId()
</script>
