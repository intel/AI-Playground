<template>
  <div v-if="output?.ok !== false && (playbackSrc || output?.savedFilePath)">
    <span class="text-muted-foreground block mb-2">{{ output?.message }}</span>
    <audio v-if="playbackSrc" controls class="w-full max-w-md" :src="playbackSrc" />
    <p v-else-if="loadError" class="text-xs text-destructive">{{ loadError }}</p>
    <p v-else class="text-xs text-muted-foreground">Loading audio…</p>
    <p v-if="output?.savedFilePath" class="text-xs text-muted-foreground mt-2 break-all">
      Saved: {{ output.savedFilePath }}
    </p>
  </div>
  <div v-else-if="output?.ok === false" class="text-xs text-destructive">
    {{ output.message }}
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

const props = defineProps<{
  output?: {
    ok?: boolean
    message?: string
    savedFilePath?: string
    /** Legacy persisted payloads only — stripped before the next save. */
    audioDataUri?: string
  }
}>()

const playbackSrc = ref<string | null>(null)
const loadError = ref<string | null>(null)

onMounted(async () => {
  const out = props.output
  if (!out || out.ok === false) return

  if (out.audioDataUri) {
    playbackSrc.value = out.audioDataUri
    return
  }

  if (!out.savedFilePath) return

  try {
    const result = await window.electronAPI.readLocalAudioAsDataUri(out.savedFilePath)
    if (result.success && result.dataUri) {
      playbackSrc.value = result.dataUri
    } else {
      loadError.value = result.error ?? 'Could not load audio file'
    }
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
})
</script>
