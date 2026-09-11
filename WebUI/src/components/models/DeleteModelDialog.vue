<script setup lang="ts">
// Confirmation for a *permanent* delete. Deliberately not a neutral
// "are you sure": the files do not go to the system trash, so the dialog names
// the exact paths, the space reclaimed, and every way this can bite — a preset
// that needs the model, or the model currently selected in Chat Settings.
import { computed, onMounted, ref } from 'vue'
import { formatBytes } from '@/assets/js/models/library'
import { useTextInference } from '@/assets/js/store/textInference'
import type { ModelEntry } from '@/assets/js/models/types'

const props = defineProps<{ entries: ModelEntry[] }>()

const emit = defineEmits<{ (e: 'cancel'): void; (e: 'confirm'): void }>()

const textInference = useTextInference()

const cancelButton = ref<HTMLButtonElement | null>(null)

// Focus starts on Cancel, not on the destructive button: a stray Enter on a
// dialog that deletes files permanently must not be what confirms it. It is also
// what puts focus inside the dialog so Escape reaches the handler below.
onMounted(() => cancelButton.value?.focus())

const totalBytes = computed(() =>
  props.entries.reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0),
)

const requiredWarnings = computed(() =>
  props.entries
    .filter((entry) => entry.requiredBy.length > 0)
    .map((entry) => ({ label: entry.label, requiredBy: entry.requiredBy.join(', ') })),
)

const selectedWarnings = computed(() =>
  props.entries
    .filter(
      (entry) =>
        textInference.activeModel === entry.name ||
        textInference.llmEmbeddingModels.some((m) => m.active && m.name === entry.name),
    )
    .map((entry) => entry.label),
)
</script>

<template>
  <div class="dialog-container z-20">
    <div
      class="dialog-mask absolute left-0 top-0 flex h-full w-full items-center justify-center bg-background/70"
    >
      <div
        role="dialog"
        aria-modal="true"
        :aria-label="languages.MODEL_MANAGER_DELETE_TITLE"
        class="flex max-h-[80vh] w-[560px] flex-col gap-4 overflow-y-auto rounded-2xl bg-card p-8 text-foreground shadow-2xl"
        @keydown.esc="emit('cancel')"
      >
        <h2 class="text-lg font-semibold">{{ languages.MODEL_MANAGER_DELETE_TITLE }}</h2>

        <p class="text-sm text-destructive">
          {{ languages.MODEL_MANAGER_DELETE_PERMANENT }}
        </p>

        <div class="flex flex-col gap-2">
          <p class="text-sm text-muted-foreground">
            {{ languages.MODEL_MANAGER_DELETE_WILL_REMOVE }}
          </p>
          <ul class="flex flex-col gap-1.5 rounded-md border border-border p-3">
            <li v-for="entry in entries" :key="entry.id" class="flex flex-col">
              <span class="text-sm">
                {{ entry.label }}
                <span class="text-muted-foreground">
                  ({{
                    entry.isDirectory
                      ? languages.MODEL_MANAGER_DELETE_FOLDER
                      : languages.MODEL_MANAGER_DELETE_FILE
                  }}, {{ formatBytes(entry.sizeBytes) }})
                </span>
              </span>
              <span class="text-xs break-all text-muted-foreground">{{ entry.absolutePath }}</span>
            </li>
          </ul>
          <p class="text-sm">
            {{ languages.MODEL_MANAGER_DELETE_RECLAIM }} {{ formatBytes(totalBytes) }}
          </p>
        </div>

        <p
          v-for="warning in requiredWarnings"
          :key="`required-${warning.label}`"
          class="rounded-md border border-amber-600 bg-amber-600/10 p-3 text-sm"
        >
          {{ warning.label }} — {{ languages.MODEL_MANAGER_DELETE_REQUIRED_BY }}
          {{ warning.requiredBy }}
        </p>

        <p
          v-if="selectedWarnings.length > 0"
          class="rounded-md border border-amber-600 bg-amber-600/10 p-3 text-sm"
        >
          {{ languages.MODEL_MANAGER_DELETE_CURRENTLY_SELECTED }}
          {{ selectedWarnings.join(', ') }}
        </p>

        <p class="text-sm text-muted-foreground">
          {{ languages.MODEL_MANAGER_DELETE_STAYS_LISTED }}
        </p>

        <div class="flex justify-end gap-3">
          <button
            ref="cancelButton"
            class="rounded bg-muted px-4 py-1.5 text-sm"
            @click="emit('cancel')"
          >
            {{ languages.COM_CANCEL }}
          </button>
          <button
            class="rounded bg-destructive px-4 py-1.5 text-sm text-destructive-foreground"
            @click="emit('confirm')"
          >
            {{ languages.MODEL_MANAGER_DELETE_CONFIRM }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
