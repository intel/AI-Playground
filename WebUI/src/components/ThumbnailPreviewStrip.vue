<template>
  <div v-if="items.length > 0" class="flex p-2 overflow-hidden justify-end self-start">
    <img
      v-for="(item, i) in items"
      :key="item.id"
      :src="item.imageUrl"
      class="w-12 h-12 rounded-sm shadow-black shadow-md border-3 border-background"
      :style="{ marginLeft: `-${getThumbnailOverlap(i, items.length)}px` }"
    />
  </div>
</template>

<script setup lang="ts">
interface MediaItem {
  id: string
  imageUrl: string
}

defineProps<{ items: MediaItem[] }>()

function getThumbnailOverlap(i: number, length: number): number {
  if (i === 0) return 0
  const reversed = length - i
  const overlap = Math.min(Math.max(4, reversed), 8)
  return 4 * overlap
}
</script>

<style scoped></style>
