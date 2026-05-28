import { ref, computed } from 'vue'
import { useHomeAgent } from './homeAgent'
import { useConversations } from './conversations'
import * as toast from '@/assets/js/toast'

const DETECT_POLL_INTERVAL_MS = 2000
const DETECT_TIMEOUT_MS = 5000

export function useTelegramSetup() {
  const homeAgent = useHomeAgent()
  const conversations = useConversations()

  const tokenInput = ref('')
  const showToken = ref(false)
  const detectedChatId = ref('')
  const detectStatus = ref<'idle' | 'loading' | 'error'>('idle')
  const detectError = ref('')
  const verifyStatus = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
  const verifyError = ref('')

  const isAlreadyConfigured = computed(
    () => !!(homeAgent.channels.telegram.config as { token?: string }).token,
  )

  // A valid token is <digits>:<35 alphanumeric chars>, total ≥ 40 chars with a colon.
  const tokenFormatOk = computed(() => {
    const t = tokenInput.value.trim()
    return t.includes(':') && t.split(':')[0].length > 0 && t.length >= 40
  })

  const hasAnyToken = computed(() => !!tokenInput.value || isAlreadyConfigured.value)
  const hasAnyChatId = computed(() => !!detectedChatId.value || isAlreadyConfigured.value)

  const canVerify = computed(() => hasAnyToken.value && hasAnyChatId.value)
  const canSave = computed(
    () => hasAnyChatId.value && (isAlreadyConfigured.value || tokenFormatOk.value),
  )

  function currentSavedToken(): string {
    return (homeAgent.channels.telegram.config as { token?: string }).token?.trim() ?? ''
  }

  async function pollForChatId(token: string): Promise<{ chatId: string } | { error: string }> {
    try {
      const quick = await window.electronAPI.homeAgent.channel.detectIdentity('telegram', { token })
      if ('identity' in quick) return { chatId: quick.identity }
    } catch (e) {
      console.error('pollForChatId initial detectIdentity failed:', e)
      detectError.value = 'Failed to contact Home Agent backend. Is it running?'
      return { error: detectError.value }
    }

    detectError.value = 'Waiting for a message… Open your bot in Telegram and send any message.'
    const deadline = Date.now() + DETECT_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DETECT_POLL_INTERVAL_MS))
      try {
        const r = await window.electronAPI.homeAgent.channel.detectIdentity('telegram', { token })
        if ('identity' in r) {
          detectError.value = ''
          return { chatId: r.identity }
        }
      } catch (e) {
        console.error('pollForChatId poll detectIdentity failed:', e)
        detectError.value = 'Failed to contact Home Agent backend. Is it running?'
        return { error: detectError.value }
      }
    }
    return {
      error:
        'Timed out waiting for a message. Make sure the bot is running and send any message to it, then click Detect again.',
    }
  }

  async function runDetectChatId() {
    detectStatus.value = 'loading'
    detectError.value = ''
    try {
      let result: { chatId: string } | { error: string }
      const trimmedToken = tokenInput.value.trim()
      if (trimmedToken) {
        try {
          await window.electronAPI.homeAgent.channel.inject('telegram', { token: trimmedToken })
        } catch (e) {
          console.error('runDetectChatId: inject(telegram) failed:', e)
        }
        result = await pollForChatId(trimmedToken)
      } else {
        const r = await window.electronAPI.homeAgent.channel.detectIdentityFromSaved('telegram')
        result = 'identity' in r ? { chatId: r.identity } : { error: r.error }
      }
      if ('chatId' in result) {
        detectedChatId.value = result.chatId
        detectStatus.value = 'idle'
        const tok = tokenInput.value.trim() || currentSavedToken()
        if (tok) {
          try {
            await window.electronAPI.homeAgent.channel.inject('telegram', {
              token: tok,
              chatId: result.chatId,
            })
          } catch (e) {
            console.error('runDetectChatId: inject(telegram) with chatId failed:', e)
          }
        }
        try {
          await window.electronAPI.homeAgent.channel.flushPending('telegram')
        } catch (e) {
          console.error('runDetectChatId: flushPending(telegram) failed:', e)
        }
      } else {
        detectStatus.value = 'error'
        detectError.value = result.error
      }
    } catch (e) {
      console.error('runDetectChatId failed:', e)
      detectStatus.value = 'error'
      detectError.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function verify() {
    const token = tokenInput.value.trim()
    const chatId = detectedChatId.value || homeAgent.telegramChatId
    verifyStatus.value = 'loading'
    verifyError.value = ''
    try {
      if (token && chatId) {
        const saveResult = await homeAgent.saveChannelConfig('telegram', {
          kind: 'telegram',
          token,
          chatId,
        })
        if (!saveResult.success) {
          verifyStatus.value = 'error'
          verifyError.value = saveResult.error ?? 'Failed to save config'
          return
        }
      }
      if (!chatId) {
        verifyStatus.value = 'error'
        verifyError.value = 'No chat ID — complete Step 2 (Detect) first.'
        return
      }
      const result = await window.electronAPI.homeAgent.channel.test('telegram')
      if (result.success) {
        homeAgent.setVerified('telegram')
        verifyStatus.value = 'success'
        const tokForInject = token || currentSavedToken()
        if (tokForInject && chatId) {
          try {
            await window.electronAPI.homeAgent.channel.inject('telegram', {
              token: tokForInject,
              chatId,
            })
          } catch (e) {
            console.error('verify: inject(telegram) failed:', e)
          }
        }
      } else {
        verifyStatus.value = 'error'
        verifyError.value = result.error ?? 'Unknown error'
      }
    } catch (e) {
      console.error('verify: test(telegram) failed:', e)
      verifyStatus.value = 'error'
      verifyError.value = e instanceof Error ? e.message : 'Verification failed'
    }
  }

  async function saveAndContinue(): Promise<boolean> {
    const token = tokenInput.value.trim()
    const chatId = detectedChatId.value || homeAgent.telegramChatId || ''
    let success = true
    try {
      if (token && chatId) {
        const wasVerified = homeAgent.telegramVerified
        let saveResult: { success: boolean; error?: string }
        try {
          saveResult = await homeAgent.saveChannelConfig('telegram', {
            kind: 'telegram',
            token,
            chatId,
          })
        } catch (e) {
          console.error('saveAndContinue: failed to save Home Agent config:', e)
          toast.error('Failed to save Home Agent configuration')
          return false
        }
        if (!saveResult.success) {
          console.error('saveAndContinue: saveChannelConfig returned failure:', saveResult.error)
          toast.error(saveResult.error ?? 'Failed to save Home Agent configuration')
          return false
        }
        if (wasVerified) {
          homeAgent.setVerified('telegram')
        }
        try {
          await window.electronAPI.homeAgent.channel.inject('telegram', { token, chatId })
        } catch (e) {
          console.error('saveAndContinue: inject(telegram) failed:', e)
          toast.error('Saved config, but failed to apply token to the running service')
          success = false
        }
      }
    } finally {
      conversations.addNewConversation()
    }
    return success
  }

  function syncSetupFieldsFromStore() {
    if (homeAgent.telegramChatId) {
      detectedChatId.value = homeAgent.telegramChatId
    }
  }

  async function clearConfig() {
    try {
      await homeAgent.clearChannelConfig('telegram')
    } catch (e) {
      console.error('clearConfig: failed to clear Home Agent config:', e)
    } finally {
      tokenInput.value = ''
      detectedChatId.value = ''
      detectStatus.value = 'idle'
      detectError.value = ''
      verifyStatus.value = 'idle'
      verifyError.value = ''
    }
  }

  return {
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
  }
}
