import { ref, computed } from 'vue'
import { useHomeAgent } from './homeAgent'
import { useConversations } from './conversations'
import * as toast from '@/assets/js/toast'

const DETECT_POLL_INTERVAL_MS = 2000
const DETECT_TIMEOUT_MS = 8000

const BOT_TOKEN_RE = /^xox[bp]-\d+-\d+-[A-Za-z0-9-]+$/
const APP_TOKEN_RE = /^xapp-\d+-[A-Z0-9]+-[A-Za-z0-9]+$/

/**
 * Slack-side mirror of `useTelegramSetup`. Provides the same shape so the
 * setup-wizard UI can be a thin shell over the same wizard-step pattern
 * (paste tokens → detect user → verify → save).
 */
export function useSlackSetup() {
  const homeAgent = useHomeAgent()
  const conversations = useConversations()

  const botTokenInput = ref('')
  const appTokenInput = ref('')
  const showTokens = ref(false)
  const detectedUserId = ref('')
  const detectStatus = ref<'idle' | 'loading' | 'error'>('idle')
  const detectError = ref('')
  const verifyStatus = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
  const verifyError = ref('')

  const isAlreadyConfigured = computed(() => {
    const cfg = homeAgent.channels.slack.config as { botToken?: string; appToken?: string }
    return !!(cfg.botToken && cfg.appToken)
  })

  function currentSavedBot(): string {
    return (homeAgent.channels.slack.config as { botToken?: string }).botToken?.trim() ?? ''
  }
  function currentSavedApp(): string {
    return (homeAgent.channels.slack.config as { appToken?: string }).appToken?.trim() ?? ''
  }

  // Soft format validation — we don't enforce on the inputs themselves so a
  // newly-rotated token shape can still be pasted; we just dim the next-step
  // buttons until both fields look plausible.
  const botTokenFormatOk = computed(() => {
    const t = botTokenInput.value.trim()
    return BOT_TOKEN_RE.test(t) || (t.startsWith('xoxb-') && t.length >= 30)
  })
  const appTokenFormatOk = computed(() => {
    const t = appTokenInput.value.trim()
    return APP_TOKEN_RE.test(t) || (t.startsWith('xapp-') && t.length >= 30)
  })
  const tokensFormatOk = computed(() => botTokenFormatOk.value && appTokenFormatOk.value)

  const hasAnyBotToken = computed(() => !!botTokenInput.value || isAlreadyConfigured.value)
  const hasAnyAppToken = computed(() => !!appTokenInput.value || isAlreadyConfigured.value)
  const hasAnyUserId = computed(() => !!detectedUserId.value || isAlreadyConfigured.value)

  const canDetect = computed(() => hasAnyBotToken.value && hasAnyAppToken.value)
  const canVerify = computed(
    () => hasAnyBotToken.value && hasAnyAppToken.value && hasAnyUserId.value,
  )
  const canSave = computed(
    () =>
      hasAnyUserId.value &&
      (isAlreadyConfigured.value ||
        (botTokenInput.value && appTokenInput.value && tokensFormatOk.value)),
  )

  async function injectIfPossible() {
    const bot = (botTokenInput.value || currentSavedBot()).trim()
    const appT = (appTokenInput.value || currentSavedApp()).trim()
    if (!bot || !appT) return
    try {
      await window.electronAPI.homeAgent.channel.inject('slack', {
        botToken: bot,
        appToken: appT,
        userId: detectedUserId.value || undefined,
      })
    } catch (e) {
      console.error('useSlackSetup.injectIfPossible failed:', e)
    }
  }

  async function pollForUserId(): Promise<{ userId: string } | { error: string }> {
    const bot = botTokenInput.value.trim()
    try {
      const quick = await window.electronAPI.homeAgent.channel.detectIdentity('slack', {
        botToken: bot,
      })
      if ('identity' in quick) return { userId: quick.identity }
    } catch (e) {
      console.error('pollForUserId initial detectIdentity failed:', e)
      detectError.value = 'Failed to contact Home Agent backend. Is it running?'
      return { error: detectError.value }
    }

    detectError.value = 'Waiting for a DM… open your Slack bot and send any message.'
    const deadline = Date.now() + DETECT_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DETECT_POLL_INTERVAL_MS))
      try {
        const r = await window.electronAPI.homeAgent.channel.detectIdentity('slack', {
          botToken: bot,
        })
        if ('identity' in r) {
          detectError.value = ''
          return { userId: r.identity }
        }
      } catch (e) {
        console.error('pollForUserId detectIdentity failed:', e)
        detectError.value = 'Failed to contact Home Agent backend. Is it running?'
        return { error: detectError.value }
      }
    }
    return {
      error:
        'Timed out waiting for a DM. Make sure the bot is added to your workspace and DM it any message, then click Detect again.',
    }
  }

  async function runDetectUserId() {
    detectStatus.value = 'loading'
    detectError.value = ''
    try {
      let result: { userId: string } | { error: string }
      const bot = botTokenInput.value.trim()
      const appT = appTokenInput.value.trim()
      if (bot && appT) {
        try {
          await window.electronAPI.homeAgent.channel.inject('slack', {
            botToken: bot,
            appToken: appT,
          })
        } catch (e) {
          console.error('runDetectUserId: inject(slack) failed:', e)
        }
        result = await pollForUserId()
      } else {
        const r = await window.electronAPI.homeAgent.channel.detectIdentityFromSaved('slack')
        result = 'identity' in r ? { userId: r.identity } : { error: r.error }
      }
      if ('userId' in result) {
        detectedUserId.value = result.userId
        detectStatus.value = 'idle'
        const bot2 = botTokenInput.value.trim() || currentSavedBot()
        const appT2 = appTokenInput.value.trim() || currentSavedApp()
        if (bot2 && appT2) {
          try {
            await window.electronAPI.homeAgent.channel.inject('slack', {
              botToken: bot2,
              appToken: appT2,
              userId: result.userId,
            })
          } catch (e) {
            console.error('runDetectUserId: inject(slack) with userId failed:', e)
          }
        }
        try {
          await window.electronAPI.homeAgent.channel.flushPending('slack')
        } catch (e) {
          console.error('runDetectUserId: flushPending(slack) failed:', e)
        }
      } else {
        detectStatus.value = 'error'
        detectError.value = result.error
      }
    } catch (e) {
      console.error('runDetectUserId failed:', e)
      detectStatus.value = 'error'
      detectError.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function verify() {
    const bot = botTokenInput.value.trim()
    const appT = appTokenInput.value.trim()
    const userId = detectedUserId.value || homeAgent.slackUserId || ''
    verifyStatus.value = 'loading'
    verifyError.value = ''
    try {
      if (bot && appT && userId) {
        const saveResult = await homeAgent.saveChannelConfig('slack', {
          kind: 'slack',
          botToken: bot,
          appToken: appT,
          userId,
        })
        if (!saveResult.success) {
          verifyStatus.value = 'error'
          verifyError.value = saveResult.error ?? 'Failed to save Slack config'
          return
        }
      }
      if (!userId) {
        verifyStatus.value = 'error'
        verifyError.value = 'No DM partner detected — complete Step 3 (Detect) first.'
        return
      }
      const result = await window.electronAPI.homeAgent.channel.test('slack')
      if (result.success) {
        homeAgent.setVerified('slack')
        verifyStatus.value = 'success'
        await injectIfPossible()
      } else {
        verifyStatus.value = 'error'
        verifyError.value = result.error ?? 'Unknown error'
      }
    } catch (e) {
      console.error('verify slack failed:', e)
      verifyStatus.value = 'error'
      verifyError.value = e instanceof Error ? e.message : 'Verification failed'
    }
  }

  async function saveAndContinue(): Promise<boolean> {
    const bot = botTokenInput.value.trim()
    const appT = appTokenInput.value.trim()
    const userId = detectedUserId.value || homeAgent.slackUserId || ''
    let success = true
    try {
      if (bot && appT && userId) {
        const wasVerified = homeAgent.slackVerified
        let saveResult: { success: boolean; error?: string }
        try {
          saveResult = await homeAgent.saveChannelConfig('slack', {
            kind: 'slack',
            botToken: bot,
            appToken: appT,
            userId,
          })
        } catch (e) {
          console.error('saveAndContinue (slack): saveChannelConfig threw:', e)
          toast.error('Failed to save Slack configuration')
          return false
        }
        if (!saveResult.success) {
          console.error(
            'saveAndContinue (slack): saveChannelConfig returned failure:',
            saveResult.error,
          )
          toast.error(saveResult.error ?? 'Failed to save Slack configuration')
          return false
        }
        if (wasVerified) homeAgent.setVerified('slack')
        try {
          await window.electronAPI.homeAgent.channel.inject('slack', {
            botToken: bot,
            appToken: appT,
            userId,
          })
        } catch (e) {
          console.error('saveAndContinue (slack): inject(slack) failed:', e)
          toast.error('Saved config, but failed to apply tokens to the running service')
          success = false
        }
      }
    } finally {
      conversations.addNewConversation()
    }
    return success
  }

  function syncSetupFieldsFromStore() {
    if (homeAgent.slackUserId) detectedUserId.value = homeAgent.slackUserId
  }

  async function clearConfig() {
    try {
      await homeAgent.clearChannelConfig('slack')
    } catch (e) {
      console.error('clearConfig (slack) failed:', e)
    } finally {
      botTokenInput.value = ''
      appTokenInput.value = ''
      detectedUserId.value = ''
      detectStatus.value = 'idle'
      detectError.value = ''
      verifyStatus.value = 'idle'
      verifyError.value = ''
    }
  }

  return {
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
    canSave,
    runDetectUserId,
    verify,
    saveAndContinue,
    clearConfig,
    syncSetupFieldsFromStore,
  }
}
