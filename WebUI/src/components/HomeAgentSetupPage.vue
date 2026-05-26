<template>
  <div class="px-12 py-5 max-w-5xl w-5xl">
    <h1 class="text-center py-1 px-4 rounded-sm text-3xl font-bold">Home Agent Setup</h1>

    <div class="flex gap-6 pt-6">
      <!-- Left: chat software selector -->
      <div class="w-48 shrink-0">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
          Chat Software
        </h2>
        <div
          class="flex items-center gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors border-primary bg-primary/10"
        >
          <div
            class="w-4 h-4 rounded-full border-2 border-primary bg-primary flex items-center justify-center shrink-0"
          >
            <svg
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
            <!-- Telegram plane icon -->
            <svg class="w-5 h-5 text-[#26a5e4]" viewBox="0 0 24 24" fill="currentColor">
              <path
                d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"
              />
            </svg>
            <span class="text-sm font-medium">Telegram</span>
          </div>
        </div>
      </div>

      <!-- Right: setup steps -->
      <div class="flex-1 min-w-0">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
          Setup Steps
        </h2>

        <div class="flex flex-col gap-4">
          <!-- Step 1: Create bot -->
          <div class="flex gap-3">
            <StepBadge :step="1" />
            <div class="flex-1">
              <p class="text-sm font-medium">Create a Telegram Bot</p>
              <p class="text-xs text-muted-foreground pt-0.5">
                Open Telegram, search for
                <button
                  class="text-primary underline"
                  @click="openExternalUrl('https://t.me/BotFather')"
                >
                  @BotFather</button
                >, send <code class="bg-muted px-1 rounded">/newbot</code>, follow the prompts, and
                copy the <strong>full</strong> API token it gives you. It looks like
                <code class="bg-muted px-1 rounded select-all"
                  >123456789:ABCDefGhIJKlmNoPQRstUvwXYZabcde12</code
                >
                — make sure to copy everything including the numbers and colon before the colon.
              </p>
              <div class="pt-2 relative">
                <input
                  :type="showToken ? 'text' : 'password'"
                  v-model="tokenInput"
                  :placeholder="
                    isAlreadyConfigured && !tokenInput
                      ? '••••••••  (already saved)'
                      : 'Paste bot token here'
                  "
                  class="w-full text-xs bg-muted/50 border border-border rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary pr-16"
                />
                <button
                  class="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  @click="showToken = !showToken"
                >
                  {{ showToken ? 'Hide' : 'Show' }}
                </button>
              </div>
              <p
                v-if="tokenInput"
                class="text-xs pt-1"
                :class="tokenFormatOk ? 'text-muted-foreground/70' : 'text-destructive'"
              >
                <template v-if="tokenFormatOk">
                  ✓ Length: {{ tokenInput.trim().length }} chars · starts with
                  <code class="bg-muted px-1 rounded">{{ tokenInput.trim().slice(0, 6) }}</code>
                  · ends with
                  <code class="bg-muted px-1 rounded">{{ tokenInput.trim().slice(-4) }}</code>
                </template>
                <template v-else>
                  ⚠ Token must contain a colon, e.g.
                  <code class="bg-muted px-1 rounded">123456789:ABCDef…</code> — currently
                  {{ tokenInput.trim().length }} chars with no colon. Copy the full token from
                  BotFather.
                </template>
              </p>
            </div>
          </div>

          <!-- Step 2: Connect your account (auto-detect chat ID) -->
          <div class="flex gap-3">
            <StepBadge :step="2" :done="!!detectedChatId" />
            <div class="flex-1">
              <p class="text-sm font-medium">Connect Your Account</p>
              <p class="text-xs text-muted-foreground pt-0.5">
                Open your bot in Telegram and send it any message (e.g.
                <code class="bg-muted px-1 rounded">/start</code>). Then click
                <strong>Detect</strong> — the app will find your chat ID automatically.
              </p>
              <div
                v-if="tokenInput || isAlreadyConfigured"
                class="flex flex-wrap items-center gap-2 pt-2"
              >
                <button
                  class="text-xs py-1.5 px-3 rounded border border-border hover:bg-muted transition-colors"
                  @click="openExternalUrl('https://t.me/')"
                >
                  Open bot in Telegram ↗
                </button>
                <button
                  :disabled="detectStatus === 'loading' || (!!tokenInput && !tokenFormatOk)"
                  class="text-xs py-1.5 px-3 rounded bg-primary text-primary-foreground disabled:opacity-40 transition-colors"
                  @click="runDetectChatId"
                >
                  <span v-if="detectStatus === 'loading'">{{
                    detectError ? 'Waiting…' : 'Detecting…'
                  }}</span>
                  <span v-else>Detect</span>
                </button>
                <span v-if="detectedChatId" class="text-xs text-green-500">
                  ✅ Chat ID: {{ detectedChatId }}
                </span>
                <span v-if="detectStatus === 'error'" class="text-xs text-destructive">
                  ❌ {{ detectError }}
                </span>
              </div>
              <p v-else class="text-xs text-muted-foreground/60 pt-2 italic">
                Paste your bot token above first.
              </p>
              <p
                v-if="isAlreadyConfigured && homeAgent.telegramChatId && !detectedChatId"
                class="text-xs text-muted-foreground pt-1"
              >
                Previously detected: {{ homeAgent.telegramChatId }}
              </p>
            </div>
          </div>

          <!-- Step 3: Verify -->
          <div class="flex gap-3">
            <StepBadge
              :step="3"
              :done="
                verifyStatus === 'success' ||
                (homeAgent.telegramVerified && verifyStatus === 'idle')
              "
            />
            <div class="flex-1">
              <p class="text-sm font-medium">Verify Connection</p>
              <p class="text-xs text-muted-foreground pt-0.5">
                Send a test message to confirm everything works. The Home Agent toggle will only be
                enabled after a successful test.
              </p>
              <div class="flex items-center gap-3 pt-2">
                <button
                  :disabled="!canVerify || verifyStatus === 'loading'"
                  class="text-xs py-1.5 px-4 rounded bg-primary text-primary-foreground disabled:opacity-40 transition-colors"
                  @click="verify"
                >
                  <span v-if="verifyStatus === 'loading'">Sending…</span>
                  <span v-else>Send Test Message</span>
                </button>
                <span v-if="verifyStatus === 'success'" class="text-xs text-green-500">
                  ✅ Message sent — check your Telegram!
                </span>
                <span v-else-if="verifyStatus === 'error'" class="text-xs text-destructive">
                  ❌ {{ verifyError }}
                </span>
                <span
                  v-else-if="homeAgent.telegramVerified && verifyStatus === 'idle'"
                  class="text-xs text-green-500"
                >
                  ✅ Previously verified
                </span>
              </div>
              <div
                v-if="isAlreadyConfigured && !tokenInput && !detectedChatId"
                class="flex items-center gap-2 pt-2"
              >
                <span class="text-xs text-muted-foreground">Telegram already configured.</span>
                <button class="text-xs text-destructive underline" @click="clearConfig">
                  Clear
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div class="flex items-center justify-between pt-6">
      <button
        class="py-2 px-5 rounded text-sm font-medium border border-border hover:bg-muted transition-colors"
        @click="emit('back')"
      >
        ← Back
      </button>
      <div class="flex gap-3">
        <button
          class="py-2 px-5 rounded text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          @click="emit('done')"
        >
          Skip for now
        </button>
        <button
          :disabled="!canSave"
          class="bg-primary py-2 px-8 rounded text-primary-foreground text-sm font-medium disabled:opacity-50 transition-colors"
          @click="saveAndContinue().then(() => emit('done'))"
        >
          Save &amp; Continue
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import StepBadge from '@/components/StepBadge.vue'
import { useHomeAgentSetup } from '@/assets/js/store/useHomeAgentSetup'

const emit = defineEmits<{
  back: []
  done: []
}>()

function openExternalUrl(url: string) {
  window.electronAPI.openUrl(url)
}

const {
  homeAgent,
  tokenInput,
  showToken,
  detectedChatId,
  detectStatus,
  detectError,
  verifyStatus,
  verifyError,
  isAlreadyConfigured,
  tokenFormatOk,
  canVerify,
  canSave,
  runDetectChatId,
  verify,
  saveAndContinue,
  clearConfig,
  syncSetupFieldsFromStore,
} = useHomeAgentSetup()

onMounted(() => {
  syncSetupFieldsFromStore()
})
</script>
