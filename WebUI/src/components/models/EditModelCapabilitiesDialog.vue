<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ModelCapabilityFields from './ModelCapabilityFields.vue'
import { pickDefined } from '@/assets/js/models/overrides'
import { describeInferenceDefaults } from '@/assets/js/models/library'
import type { ModelCapabilityValues, ModelEntry } from '@/assets/js/models/types'

const props = defineProps<{ entry: ModelEntry }>()

const emit = defineEmits<{
  (e: 'cancel'): void
  (e: 'save', capabilities: Partial<ModelCapabilityValues>): void
  (e: 'reset'): void
}>()

const draft = ref<ModelCapabilityValues>({ ...props.entry.capabilities })

watch(
  () => props.entry.id,
  () => {
    draft.value = { ...props.entry.capabilities }
  },
)

const sampling = computed(() => describeInferenceDefaults(props.entry.inferenceDefaults))
const hasPublisherSettings = computed(() => !!sampling.value || !!props.entry.llamaCppArgs)
</script>

<template>
  <div class="dialog-container z-20">
    <div
      class="dialog-mask absolute left-0 top-0 flex h-full w-full items-center justify-center bg-background/70"
    >
      <div
        role="dialog"
        :aria-label="languages.MODEL_MANAGER_EDIT_TITLE"
        class="flex max-h-[85vh] w-[520px] flex-col gap-4 overflow-y-auto rounded-2xl bg-card p-8 text-foreground shadow-2xl"
      >
        <div class="flex flex-col gap-1">
          <h2 class="text-lg font-semibold">{{ languages.MODEL_MANAGER_EDIT_TITLE }}</h2>
          <p class="text-xs break-all text-muted-foreground">{{ entry.name }}</p>
        </div>

        <p class="text-sm text-muted-foreground">{{ languages.MODEL_MANAGER_EDIT_DESCRIPTION }}</p>

        <ModelCapabilityFields
          v-model="draft"
          :service-backend="entry.serviceBackend"
          show-advanced
          id-prefix="edit-capability"
        />

        <!-- Read-only: the catalog owns these, but they decide how the model
             behaves, so hiding them left that behaviour unexplainable here. -->
        <div
          v-if="hasPublisherSettings"
          class="flex flex-col gap-2 rounded-lg border border-border p-3"
        >
          <p class="text-sm font-medium">{{ languages.MODEL_MANAGER_PUBLISHER_TITLE }}</p>
          <p class="text-xs text-muted-foreground">
            {{ languages.MODEL_MANAGER_PUBLISHER_HINT }}
          </p>
          <div v-if="sampling" class="flex flex-col gap-0.5">
            <span class="text-xs font-medium">{{
              languages.MODEL_MANAGER_PUBLISHER_SAMPLING
            }}</span>
            <span class="break-all font-mono text-xs text-muted-foreground">{{ sampling }}</span>
          </div>
          <div v-if="entry.llamaCppArgs" class="flex flex-col gap-0.5">
            <span class="text-xs font-medium">{{
              languages.MODEL_MANAGER_PUBLISHER_SERVER_ARGS
            }}</span>
            <span class="break-all font-mono text-xs text-muted-foreground">{{
              entry.llamaCppArgs
            }}</span>
          </div>
        </div>

        <div class="flex items-center justify-between gap-3">
          <button
            v-if="entry.hasCapabilityOverrides"
            class="rounded bg-muted px-4 py-1.5 text-sm"
            @click="emit('reset')"
          >
            {{ languages.MODEL_MANAGER_EDIT_RESET }}
          </button>
          <span v-else class="text-xs text-muted-foreground">
            {{ languages.MODEL_MANAGER_EDIT_NO_OVERRIDES }}
          </span>
          <div class="flex gap-3">
            <button class="rounded bg-muted px-4 py-1.5 text-sm" @click="emit('cancel')">
              {{ languages.COM_CANCEL }}
            </button>
            <button
              class="rounded bg-primary px-4 py-1.5 text-sm text-primary-foreground"
              @click="emit('save', pickDefined(draft))"
            >
              {{ languages.MODEL_MANAGER_SAVE }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
