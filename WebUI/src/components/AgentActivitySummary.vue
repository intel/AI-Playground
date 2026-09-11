<script setup lang="ts">
// One line standing in for a finished stretch of agent work — "Reasoned for 12.3
// seconds, used 4 tools" — with the reasoning blocks and tool cards it replaces
// behind a disclosure.
defineProps<{ summary: string }>()

const isExpanded = ref(false)
</script>

<template>
  <div class="flex flex-col gap-2">
    <button
      class="flex items-center self-start cursor-pointer"
      :aria-expanded="isExpanded"
      @click="isExpanded = !isExpanded"
    >
      <span class="italic text-muted-foreground">{{ summary }}</span>
      <img v-if="isExpanded" src="../assets/svg/arrow-up.svg" class="w-4 h-4 ml-1" />
      <img v-else src="../assets/svg/arrow-down.svg" class="w-4 h-4 ml-1" />
    </button>
    <div v-if="isExpanded" class="flex flex-col gap-3 border-l-2 border-border pl-4">
      <slot />
    </div>
  </div>
</template>
