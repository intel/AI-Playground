<template>
  <div class="flex flex-col gap-4">
    <!-- Step 1: Create Slack app from manifest -->
    <div class="flex gap-3">
      <StepBadge :step="1" />
      <div class="flex-1">
        <p class="text-sm font-medium">Create a Slack App</p>
        <p class="text-xs text-muted-foreground pt-0.5">
          Open
          <button
            class="text-primary underline"
            @click="openExternalUrl('https://api.slack.com/apps?new_app=1')"
          >
            api.slack.com/apps</button
          >, click <strong>From an app manifest</strong>, pick your workspace, then paste the JSON
          below. After the app is created go to <strong>Install App</strong> and authorize it for
          your workspace.
        </p>
        <p class="text-xs text-muted-foreground pt-1">
          Home Agent uses
          <a
            class="text-primary underline"
            href="#"
            @click.prevent="openExternalUrl('https://api.slack.com/apis/socket-mode')"
            >Socket Mode</a
          >
          (no public URL required, DMs only).
        </p>
        <div class="pt-2 relative">
          <pre
            class="text-[10px] leading-snug bg-muted/50 border border-border rounded p-2 max-h-44 overflow-auto select-all whitespace-pre"
            >{{ MANIFEST_JSON }}</pre
          >
          <button
            class="absolute top-2 right-2 text-xs py-1 px-2 rounded bg-primary text-primary-foreground transition-colors"
            @click="copyManifest"
          >
            {{ manifestCopied ? '✓ Copied' : 'Copy manifest' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Step 2: Paste tokens -->
    <div class="flex gap-3">
      <StepBadge :step="2" :done="botTokenFormatOk && appTokenFormatOk" />
      <div class="flex-1">
        <p class="text-sm font-medium">Paste Your Tokens</p>
        <p class="text-xs text-muted-foreground pt-0.5">
          From the Slack app's <strong>OAuth &amp; Permissions</strong> page, copy the
          <strong>Bot User OAuth Token</strong>
          (starts with <code class="bg-muted px-1 rounded">xoxb-</code>). From
          <strong>Basic Information → App-Level Tokens</strong>, create a token with
          <code class="bg-muted px-1 rounded">connections:write</code>
          and copy that one too (starts with
          <code class="bg-muted px-1 rounded">xapp-</code>).
        </p>
        <div class="pt-2 relative">
          <input
            :type="showTokens ? 'text' : 'password'"
            v-model="botTokenInput"
            :placeholder="
              isAlreadyConfigured && !botTokenInput
                ? '••••••••  (already saved — xoxb-…)'
                : 'Bot token (xoxb-…)'
            "
            class="w-full text-xs bg-muted/50 border border-border rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary pr-16"
          />
        </div>
        <div class="pt-2 relative">
          <input
            :type="showTokens ? 'text' : 'password'"
            v-model="appTokenInput"
            :placeholder="
              isAlreadyConfigured && !appTokenInput
                ? '••••••••  (already saved — xapp-…)'
                : 'App-level token (xapp-…)'
            "
            class="w-full text-xs bg-muted/50 border border-border rounded px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary pr-16"
          />
          <button
            class="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground transition-colors"
            @click="showTokens = !showTokens"
          >
            {{ showTokens ? 'Hide' : 'Show' }}
          </button>
        </div>
        <p
          v-if="botTokenInput || appTokenInput"
          class="text-xs pt-1"
          :class="tokensFormatOk ? 'text-muted-foreground/70' : 'text-destructive'"
        >
          <template v-if="tokensFormatOk"> ✓ Both tokens look like Slack tokens. </template>
          <template v-else>
            ⚠ Bot tokens start with
            <code class="bg-muted px-1 rounded">xoxb-</code> and app tokens with
            <code class="bg-muted px-1 rounded">xapp-</code> — double-check you pasted the right one
            in each field.
          </template>
        </p>
      </div>
    </div>

    <!-- Step 3: Connect your account -->
    <div class="flex gap-3">
      <StepBadge :step="3" :done="!!detectedUserId" />
      <div class="flex-1">
        <p class="text-sm font-medium">Connect Your Account</p>
        <p class="text-xs text-muted-foreground pt-0.5">
          Open Slack, find your bot under <strong>Apps</strong> in the sidebar, and DM it any
          message (e.g. <code class="bg-muted px-1 rounded">/help</code>). Then click
          <strong>Detect</strong> — the bot will remember your Slack user ID.
        </p>
        <div v-if="canDetect || isAlreadyConfigured" class="flex flex-wrap items-center gap-2 pt-2">
          <button
            class="text-xs py-1.5 px-3 rounded border border-border hover:bg-muted transition-colors"
            @click="
              openExternalUrl(
                'https://slack.com/intl/en-gb/help/articles/202035138-Add-apps-to-your-Slack-workspace',
              )
            "
          >
            How do I find my bot? ↗
          </button>
          <button
            :disabled="detectStatus === 'loading' || (canDetect && !tokensFormatOk)"
            class="text-xs py-1.5 px-3 rounded bg-primary text-primary-foreground disabled:opacity-40 transition-colors"
            @click="runDetectUserId"
          >
            <span v-if="detectStatus === 'loading'">{{
              detectError ? 'Waiting…' : 'Detecting…'
            }}</span>
            <span v-else>Detect</span>
          </button>
          <span v-if="detectedUserId" class="text-xs text-green-500">
            ✅ User ID: {{ detectedUserId }}
          </span>
          <span v-if="detectStatus === 'error'" class="text-xs text-destructive">
            ❌ {{ detectError }}
          </span>
        </div>
        <p v-else class="text-xs text-muted-foreground/60 pt-2 italic">
          Paste both tokens above first.
        </p>
        <p
          v-if="isAlreadyConfigured && homeAgent.slackUserId && !detectedUserId"
          class="text-xs text-muted-foreground pt-1"
        >
          Previously detected: {{ homeAgent.slackUserId }}
        </p>
      </div>
    </div>

    <!-- Step 4: Verify -->
    <div class="flex gap-3">
      <StepBadge
        :step="4"
        :done="verifyStatus === 'success' || (homeAgent.slackVerified && verifyStatus === 'idle')"
      />
      <div class="flex-1">
        <p class="text-sm font-medium">Verify Connection</p>
        <p class="text-xs text-muted-foreground pt-0.5">
          Send a test DM to confirm everything works. The Home Agent Slack toggle will only be
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
            ✅ Message sent — check your Slack DMs!
          </span>
          <span v-else-if="verifyStatus === 'error'" class="text-xs text-destructive">
            ❌ {{ verifyError }}
          </span>
          <span
            v-else-if="homeAgent.slackVerified && verifyStatus === 'idle'"
            class="text-xs text-green-500"
          >
            ✅ Previously verified
          </span>
        </div>
        <div
          v-if="isAlreadyConfigured && !botTokenInput && !appTokenInput && !detectedUserId"
          class="flex items-center gap-2 pt-2"
        >
          <span class="text-xs text-muted-foreground">Slack already configured.</span>
          <button class="text-xs text-destructive underline" @click="clearConfig">Clear</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import StepBadge from '@/components/StepBadge.vue'
import { useSlackSetup } from '@/assets/js/store/useSlackSetup'

const setup = useSlackSetup()
const {
  homeAgent,
  botTokenInput,
  appTokenInput,
  showTokens,
  detectedUserId,
  detectStatus,
  detectError,
  verifyStatus,
  verifyError,
  isAlreadyConfigured,
  botTokenFormatOk,
  appTokenFormatOk,
  tokensFormatOk,
  canDetect,
  canVerify,
  runDetectUserId,
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

// Opinionated DM-only Socket Mode manifest. Slash commands match the
// Telegram parity surface; bot scopes are the minimal set required for
// DMs, file uploads from generated images, reaction-based typing
// indicators, and slash-command invocation. No HTTP request URLs —
// Slack delivers everything over the Socket Mode websocket.
const MANIFEST_JSON = JSON.stringify(
  {
    display_information: {
      name: 'AI Playground Home Agent',
      description: 'Chat with AI Playground from Slack — DMs only, runs over Socket Mode.',
      background_color: '#0f172a',
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: 'AI Playground', always_online: true },
      slash_commands: [
        { command: '/help', description: 'List available commands', should_escape: false },
        {
          command: '/chat',
          description: 'Force a text chat reply',
          usage_hint: 'your message',
          should_escape: false,
        },
        {
          command: '/imggen',
          description: 'Open the image-generation picker',
          usage_hint: '[prompt]',
          should_escape: false,
        },
        { command: '/new', description: 'Start a fresh chat thread', should_escape: false },
        {
          command: '/history',
          description: 'List your saved Home Agent chats',
          should_escape: false,
        },
        {
          command: '/load',
          description: 'Resume a recent chat',
          usage_hint: '[id]',
          should_escape: false,
        },
        { command: '/cancel', description: 'Cancel a pending /imggen flow', should_escape: false },
      ],
    },
    oauth_config: {
      scopes: {
        bot: [
          'chat:write',
          'commands',
          'files:read',
          'files:write',
          'im:history',
          'im:read',
          'im:write',
          'users:read',
          'reactions:write',
          'reactions:read',
        ],
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: ['message.im'],
      },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  },
  null,
  2,
)

const manifestCopied = ref(false)
async function copyManifest() {
  try {
    await navigator.clipboard.writeText(MANIFEST_JSON)
    manifestCopied.value = true
    setTimeout(() => {
      manifestCopied.value = false
    }, 2000)
  } catch (e) {
    console.error('copyManifest failed:', e)
  }
}

onMounted(() => {
  syncSetupFieldsFromStore()
})
</script>
