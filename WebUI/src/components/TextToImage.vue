<template>
  <div class="h-full flex flex-col">
    <div class="flex flex-auto items-center justify-center">
      <img src="" />
    </div>
    <div class="h-64 flex-none">
      <p class="text-muted-foreground text-sm">{{ languages.COM_PROMPT }}</p>
      <div class="flex justify-between items-center">
        <textarea
          class="rounded-xl border border-border w-full bg-transparent text-foreground p-4 focus:border-primary"
        ></textarea>
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n.ts'

useI18N()
</script>
