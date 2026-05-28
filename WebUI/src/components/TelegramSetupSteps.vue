<template>
  <div class="flex flex-col gap-4">
    <!-- Step 1: Create bot -->
    <div class="flex gap-3">
      <StepBadge :step="1" />
      <div class="flex-1">
        <p class="text-sm font-medium">Create a Telegram Bot</p>
        <p class="text-xs text-muted-foreground pt-0.5">
          Open Telegram, search for
          <button class="text-primary underline" @click="openExternalUrl('https://t.me/BotFather')">
            @BotFather</button
          >, send <code class="bg-muted px-1 rounded">/newbot</code>, follow the prompts, and copy
          the <strong>full</strong> API token it gives you. It looks like
          <code class="bg-muted px-1 rounded select-all"
            >123456789:ABCDefGhIJKlmNoPQRstUvwXYZabcde12</code
          >
          — make sure to copy everything including the numbers and colon.
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
            {{ tokenInput.trim().length }} chars with no colon. Copy the full token from BotFather.
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
          <code class="bg-muted px-1 rounded">/start</code>). Then click <strong>Detect</strong> —
          the app will find your chat ID automatically.
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
          verifyStatus === 'success' || (homeAgent.telegramVerified && verifyStatus === 'idle')
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
          <button class="text-xs text-destructive underline" @click="clearConfig">Clear</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import StepBadge from '@/components/StepBadge.vue'
import { useTelegramSetup } from '@/assets/js/store/useTelegramSetup'

const setup = useTelegramSetup()
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
  runDetectChatId,
  verify,
  clearConfig,
  syncSetupFieldsFromStore,
} = setup

defineExpose({
  saveAndContinue: setup.saveAndContinue,
  canSave: setup.canSave,
})

function openExternalUrl(url: string) {
  window.electronAPI.openUrl(url)
}

onMounted(() => {
  syncSetupFieldsFromStore()
})
</script>
