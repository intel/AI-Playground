<template>
  <div class="flex flex-col gap-4">
    <div class="flex gap-3">
      <StepBadge :step="1" />
      <div class="flex-1 flex flex-col gap-2">
        <p class="text-sm font-medium">LAN chat (Wi‑Fi / this PC)</p>
        <p class="text-xs text-muted-foreground">
          Serves a simple chat page from AI Playground. Open the address below in a browser on this
          PC or on another device on the same Wi‑Fi — no Telegram or cloud relay.
        </p>
        <label for="local-web-port" class="text-xs font-medium pt-1">Port</label>
        <input
          id="local-web-port"
          v-model="portInput"
          type="number"
          min="1024"
          max="65535"
          class="w-32 text-xs bg-muted/50 border border-border rounded px-3 py-1.5"
        />
        <p v-if="portError" class="text-xs text-destructive">{{ portError }}</p>
        <label class="flex items-center gap-2 text-xs cursor-pointer pt-1">
          <input v-model="allowLan" type="checkbox" class="rounded" />
          Allow other devices on the local network. Off = only this computer (127.0.0.1).
        </label>
        <p v-if="allowLan" class="text-xs text-muted-foreground">
          Traffic on your network is not encrypted (plain HTTP), so anyone who can see it can read
          the messages and the password. Pick a password you don't use elsewhere.
        </p>
      </div>
    </div>

    <div class="flex gap-3">
      <StepBadge :step="2" />
      <div class="flex-1 flex flex-col gap-2">
        <label for="local-web-password" class="text-sm font-medium">Chat password</label>
        <p class="text-xs text-muted-foreground">
          Anyone who can reach this port must enter this password on the sign-in screen. Set it here
          in AI Playground — it is not included in the link.
        </p>
        <div class="relative max-w-md">
          <input
            id="local-web-password"
            :type="showPassword ? 'text' : 'password'"
            v-model="passwordInput"
            autocomplete="new-password"
            :placeholder="
              hasSavedPassword && !passwordInput
                ? 'Leave blank to keep saved password'
                : 'Choose a password (min. 4 characters)'
            "
            class="w-full text-xs bg-muted/50 border border-border rounded px-3 py-1.5 pr-16"
          />
          <button
            type="button"
            class="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
            @click="showPassword = !showPassword"
          >
            {{ showPassword ? 'Hide' : 'Show' }}
          </button>
        </div>
      </div>
    </div>

    <div class="flex gap-3">
      <StepBadge :step="3" :done="verifyStatus === 'success'" />
      <div class="flex-1 flex flex-col gap-2">
        <p class="text-sm font-medium">Save &amp; start</p>
        <p class="text-xs text-muted-foreground">
          Starts the server with these settings. In a browser, open an address below, then sign in
          with the password you set.
        </p>
        <button
          type="button"
          :disabled="verifyStatus === 'loading' || !canVerify"
          class="text-xs py-1.5 px-3 rounded bg-primary text-primary-foreground disabled:opacity-40 w-fit"
          @click="onVerify"
        >
          {{ verifyStatus === 'loading' ? 'Starting…' : 'Save & start' }}
        </button>
        <p v-if="verifyError" class="text-xs text-destructive">{{ verifyError }}</p>
        <ul v-if="urls.length" class="text-xs font-mono space-y-1 pt-2 break-all">
          <li v-for="(url, i) in urls" :key="i">
            <button type="button" class="text-primary underline text-left" @click="openUrl(url)">
              {{ url }}
            </button>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import StepBadge from '@/components/StepBadge.vue'
import { useLocalWebSetup } from '@/assets/js/store/useLocalWebSetup'

const emit = defineEmits<{ verified: [] }>()

const setup = useLocalWebSetup()
const {
  portInput,
  allowLan,
  passwordInput,
  showPassword,
  verifyStatus,
  verifyError,
  urls,
  hasSavedPassword,
  portError,
  canVerify,
  runVerify,
  loadSavedIntoForm,
} = setup

async function onVerify() {
  await runVerify()
  if (verifyStatus.value === 'success') emit('verified')
}

function openUrl(url: string) {
  window.electronAPI.openUrl(url)
}

onMounted(() => {
  void loadSavedIntoForm()
})
</script>
