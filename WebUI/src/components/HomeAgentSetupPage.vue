<template>
  <div class="px-12 py-5 max-w-5xl w-5xl">
    <h1 class="text-center py-1 px-4 rounded-sm text-3xl font-bold">Home Agent Setup</h1>

    <div class="flex gap-6 pt-6">
      <!-- Left: chat software tabs -->
      <div class="w-48 shrink-0">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
          Chat Software
        </h2>
        <div class="flex flex-col gap-2">
          <button
            type="button"
            class="flex items-center gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors"
            :class="
              activeTab === 'telegram'
                ? 'border-primary bg-primary/10'
                : 'border-border hover:bg-muted'
            "
            @click="activeTab = 'telegram'"
          >
            <div
              class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0"
              :class="
                activeTab === 'telegram' || homeAgent.telegramVerified
                  ? 'border-primary bg-primary'
                  : 'border-muted-foreground'
              "
            >
              <svg
                v-if="activeTab === 'telegram' || homeAgent.telegramVerified"
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
              <svg class="w-5 h-5 text-[#26a5e4]" viewBox="0 0 24 24" fill="currentColor">
                <path
                  d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"
                />
              </svg>
              <span class="text-sm font-medium">Telegram</span>
            </div>
          </button>

          <button
            type="button"
            class="flex items-center gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors"
            :class="
              activeTab === 'slack'
                ? 'border-primary bg-primary/10'
                : 'border-border hover:bg-muted'
            "
            @click="activeTab = 'slack'"
          >
            <div
              class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0"
              :class="
                activeTab === 'slack' || homeAgent.slackVerified
                  ? 'border-primary bg-primary'
                  : 'border-muted-foreground'
              "
            >
              <svg
                v-if="activeTab === 'slack' || homeAgent.slackVerified"
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
              <!-- Slack 4-color logo -->
              <svg class="w-5 h-5" viewBox="0 0 24 24">
                <path
                  fill="#E01E5A"
                  d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"
                />
                <path
                  fill="#36C5F0"
                  d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"
                />
                <path
                  fill="#2EB67D"
                  d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522v-2.52zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z"
                />
                <path
                  fill="#ECB22E"
                  d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"
                />
              </svg>
              <span class="text-sm font-medium">Slack</span>
            </div>
          </button>
        </div>
      </div>

      <!-- Right: setup steps -->
      <div class="flex-1 min-w-0">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
          Setup Steps
        </h2>

        <TelegramSetupSteps v-if="activeTab === 'telegram'" ref="telegramRef" />
        <SlackSetupSteps v-else ref="slackRef" />
      </div>
    </div>

    <!-- Actions -->
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
import TelegramSetupSteps from '@/components/TelegramSetupSteps.vue'
import SlackSetupSteps from '@/components/SlackSetupSteps.vue'

const emit = defineEmits<{
  back: []
  done: []
}>()

const wizard = useSetupWizard()
const homeAgent = useHomeAgent()
const isEditMode = computed(() => wizard.homeAgentSetupOrigin === 'edit')

// Default to whichever channel is *not yet* verified — that's the one the
// user most likely opened the wizard to set up. If both are verified, fall
// back to Telegram (the original surface).
const activeTab = ref<'telegram' | 'slack'>(
  homeAgent.telegramVerified && !homeAgent.slackVerified ? 'slack' : 'telegram',
)

type StepsHandle = {
  saveAndContinue: () => Promise<boolean>
  canSave: { value: boolean }
}
const telegramRef = ref<StepsHandle | null>(null)
const slackRef = ref<StepsHandle | null>(null)

const canSave = computed(() => {
  const h = activeTab.value === 'telegram' ? telegramRef.value : slackRef.value
  return !!h?.canSave?.value
})

async function handleSave() {
  const handle = activeTab.value === 'telegram' ? telegramRef.value : slackRef.value
  if (!handle) return
  const ok = await handle.saveAndContinue()
  if (ok) emit('done')
}
</script>
