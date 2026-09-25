<template>
  <div class="flex flex-col gap-4">
    <!-- Step 1: Link device -->
    <div class="flex gap-3">
      <StepBadge :step="1" :done="isLinked" />
      <div class="flex-1">
        <p class="text-sm font-medium">Link your Signal account</p>
        <p class="text-xs text-muted-foreground pt-0.5">
          The Home Agent connects to Signal through
          <button
            class="text-primary underline"
            @click="openExternalUrl('https://github.com/AsamK/signal-cli')"
          >
            signal-cli</button
          >, which the app downloads for you. Click <strong>Start linking</strong>, then in Signal
          on your phone open <strong>Settings → Linked devices → +</strong> and scan the QR code
          below.
        </p>
        <div class="flex flex-wrap items-center gap-2 pt-2">
          <button
            v-if="!isLinked"
            :disabled="linkStatus === 'preparing' || linkStatus === 'waiting'"
            class="text-xs py-1.5 px-3 rounded bg-primary text-primary-foreground disabled:opacity-40 transition-colors"
            @click="startLink"
          >
            <span v-if="linkStatus === 'preparing'">Preparing signal-cli…</span>
            <span v-else-if="linkStatus === 'waiting'">Waiting for scan…</span>
            <span v-else>Start linking</span>
          </button>
          <span v-if="isLinked" class="text-xs text-green-500">
            ✅ Linked{{ account ? ` as ${account}` : '' }}
          </span>
          <span v-if="linkStatus === 'error'" class="text-xs text-destructive">
            ❌ {{ linkError }}
          </span>
        </div>
        <div v-if="qrDataUri && !isLinked" class="pt-3">
          <img
            :src="qrDataUri"
            alt="Signal device-link QR code"
            class="w-44 h-44 rounded bg-white p-2"
          />
          <p class="text-xs text-muted-foreground pt-1">Scan this with Signal on your phone.</p>
        </div>
      </div>
    </div>

    <!-- Step 2: Connect your account (detect the contact) -->
    <div class="flex gap-3">
      <StepBadge :step="2" :done="!!detectedPeer" />
      <div class="flex-1">
        <p class="text-sm font-medium">Connect your contact</p>
        <p class="text-xs text-muted-foreground pt-0.5">
          Send any message to your linked Signal number, then click <strong>Detect</strong>. The
          Home Agent locks onto that contact and only answers messages from it.
        </p>
        <div v-if="isLinked" class="flex flex-wrap items-center gap-2 pt-2">
          <button
            :disabled="detectStatus === 'loading'"
            class="text-xs py-1.5 px-3 rounded bg-primary text-primary-foreground disabled:opacity-40 transition-colors"
            @click="runDetectPeer"
          >
            <span v-if="detectStatus === 'loading'">{{
              detectError ? 'Waiting…' : 'Detecting…'
            }}</span>
            <span v-else>Detect</span>
          </button>
          <span v-if="detectedPeer" class="text-xs text-green-500">
            ✅ Contact: {{ detectedPeer }}
          </span>
          <span v-if="detectStatus === 'error'" class="text-xs text-destructive">
            ❌ {{ detectError }}
          </span>
        </div>
        <p v-else class="text-xs text-muted-foreground/60 pt-2 italic">
          Link your account above first.
        </p>
        <p
          v-if="isLinked && homeAgent.signalPeer && !detectedPeer"
          class="text-xs text-muted-foreground pt-1"
        >
          Previously detected: {{ homeAgent.signalPeer }}
        </p>
      </div>
    </div>

    <!-- Step 3: Verify -->
    <div class="flex gap-3">
      <StepBadge
        :step="3"
        :done="verifyStatus === 'success' || (homeAgent.signalVerified && verifyStatus === 'idle')"
      />
      <div class="flex-1">
        <p class="text-sm font-medium">Verify connection</p>
        <p class="text-xs text-muted-foreground pt-0.5">
          Send a test message to confirm everything works. The Home Agent toggle is only enabled
          after a successful test.
        </p>
        <div class="flex items-center gap-3 pt-2">
          <button
            :disabled="!canVerify || verifyStatus === 'loading'"
            class="text-xs py-1.5 px-4 rounded bg-primary text-primary-foreground disabled:opacity-40 transition-colors"
            @click="onVerify"
          >
            <span v-if="verifyStatus === 'loading'">Sending…</span>
            <span v-else>Send test message</span>
          </button>
          <span v-if="verifyStatus === 'success'" class="text-xs text-green-500">
            ✅ Message sent — check Signal!
          </span>
          <span v-else-if="verifyStatus === 'error'" class="text-xs text-destructive">
            ❌ {{ verifyError }}
          </span>
          <span
            v-else-if="homeAgent.signalVerified && verifyStatus === 'idle'"
            class="text-xs text-green-500"
          >
            ✅ Previously verified
          </span>
        </div>
        <div v-if="isAlreadyConfigured" class="flex items-center gap-2 pt-2">
          <span class="text-xs text-muted-foreground">Signal already configured.</span>
          <button class="text-xs text-destructive underline" @click="clearConfig">Clear</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import StepBadge from '@/components/StepBadge.vue'
import { useSignalSetup } from '@/assets/js/store/useSignalSetup'

const emit = defineEmits<{
  verified: []
}>()

const setup = useSignalSetup()
const {
  homeAgent,
  linkStatus,
  linkError,
  qrDataUri,
  account,
  detectedPeer,
  detectStatus,
  detectError,
  verifyStatus,
  verifyError,
  isLinked,
  isAlreadyConfigured,
  canVerify,
  startLink,
  runDetectPeer,
  verify,
  clearConfig,
  syncSetupFieldsFromStore,
} = setup

async function onVerify() {
  await verify()
  if (verifyStatus.value === 'success') emit('verified')
}

function openExternalUrl(url: string) {
  window.electronAPI.openUrl(url)
}

onMounted(() => {
  syncSetupFieldsFromStore()
})
</script>
