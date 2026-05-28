<template>
  <div class="px-12 py-5 max-w-5xl w-5xl">
    <h1 class="text-center py-1 px-4 rounded-sm text-3xl font-bold">Home Agent Setup</h1>

    <div class="flex gap-6 pt-6">
      <div class="w-48 shrink-0">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
          Chat Software
        </h2>
        <div class="flex flex-col gap-2">
          <button
            v-for="descriptor in CHANNELS"
            :key="descriptor.kind"
            type="button"
            class="flex items-center gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors"
            :class="
              activeTab === descriptor.kind
                ? 'border-primary bg-primary/10'
                : 'border-border hover:bg-muted'
            "
            @click="activeTab = descriptor.kind"
          >
            <div
              class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0"
              :class="
                activeTab === descriptor.kind || homeAgent.channels[descriptor.kind].verified
                  ? 'border-primary bg-primary'
                  : 'border-muted-foreground'
              "
            >
              <svg
                v-if="activeTab === descriptor.kind || homeAgent.channels[descriptor.kind].verified"
                class="w-2.5 h-2.5 text-primary-foreground"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div class="flex items-center gap-2">
              <component :is="descriptor.icon" />
              <span class="text-sm font-medium">{{ descriptor.displayName }}</span>
            </div>
          </button>
        </div>
      </div>

      <div class="flex-1 min-w-0">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
          Setup Steps
        </h2>

        <template v-for="descriptor in CHANNELS" :key="descriptor.kind">
          <component
            v-if="activeTab === descriptor.kind"
            :is="descriptor.setupComponent"
            :ref="(el: unknown) => setStepsRef(descriptor.kind, el)"
          />
        </template>
      </div>
    </div>

    <div class="flex items-center justify-between pt-6">
      <button
        class="py-2 px-5 rounded text-sm font-medium border border-border hover:bg-muted transition-colors"
        @click="isEditMode ? emit('done') : emit('back')"
      >
        {{ isEditMode ? 'Close' : '← Back' }}
      </button>
      <div class="flex gap-3">
        <button
          v-if="!isEditMode"
          class="py-2 px-5 rounded text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          @click="emit('done')"
        >
          Skip for now
        </button>
        <button
          :disabled="!canSave"
          class="bg-primary py-2 px-8 rounded text-primary-foreground text-sm font-medium disabled:opacity-50 transition-colors"
          @click="handleSave"
        >
          {{ isEditMode ? 'Save' : 'Save &amp; Continue' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSetupWizard } from '@/assets/js/store/setupWizard'
import { useHomeAgent } from '@/assets/js/store/homeAgent'
import { CHANNELS } from '@/assets/js/store/channels/channelRegistry'
import type { ChannelKind } from '@/assets/js/store/channels/types'

const emit = defineEmits<{
  back: []
  done: []
}>()

const wizard = useSetupWizard()
const homeAgent = useHomeAgent()
const isEditMode = computed(() => wizard.homeAgentSetupOrigin === 'edit')

/**
 * Pick the first unverified channel as the default tab — that's the one the
 * user most likely opened the wizard to configure. If every channel is
 * verified, fall back to the registry's first entry.
 */
function pickDefaultTab(): ChannelKind {
  const first = CHANNELS.find((c) => !homeAgent.channels[c.kind].verified)
  return (first ?? CHANNELS[0]).kind
}
const activeTab = ref<ChannelKind>(pickDefaultTab())

type StepsHandle = {
  saveAndContinue: () => Promise<boolean>
  canSave: { value: boolean }
}
const stepsRefs: Partial<Record<ChannelKind, StepsHandle | null>> = {}

function setStepsRef(kind: ChannelKind, el: unknown) {
  stepsRefs[kind] = (el as StepsHandle | null) ?? null
}

const canSave = computed(() => {
  const h = stepsRefs[activeTab.value]
  return !!h?.canSave?.value
})

async function handleSave() {
  const handle = stepsRefs[activeTab.value]
  if (!handle) return
  const ok = await handle.saveAndContinue()
  if (ok) emit('done')
}
</script>
