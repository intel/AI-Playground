import { ref, computed } from 'vue'
import { useHomeAgent } from './homeAgent'
import { useConversations } from './conversations'
import * as toast from '@/assets/js/toast'

const DETECT_POLL_INTERVAL_MS = 2000
const DETECT_TIMEOUT_MS = 5000

export function useHomeAgentSetup() {
  const homeAgent = useHomeAgent()
  const conversations = useConversations()

  const tokenInput = ref('')
  const showToken = ref(false)
  const detectedChatId = ref('')
  const detectStatus = ref<'idle' | 'loading' | 'error'>('idle')
  const detectError = ref('')
  const verifyStatus = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
  const verifyError = ref('')

  const isAlreadyConfigured = computed(() => homeAgent.isTelegramConfigured)

  // A valid token is <digits>:<35 alphanumeric chars>, total ≥ 40 chars with a colon
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

  async function pollForChatId(token: string): Promise<{ chatId: string } | { error: string }> {
    // First try immediately (chat ID may already be in backend memory/file)
    try {
      const quick = await window.electronAPI.homeAgent.detectChatId(token)
      if ('chatId' in quick) return quick
    } catch (e) {
      console.error('pollForChatId initial detectChatId failed:', e)
      detectError.value = 'Failed to contact Home Agent backend. Is it running?'
      return { error: detectError.value }
    }

    // Not found yet — tell user to send a message and poll for up to DETECT_TIMEOUT_MS
    detectError.value = 'Waiting for a message… Open your bot in Telegram and send any message.'
    const deadline = Date.now() + DETECT_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DETECT_POLL_INTERVAL_MS))
      try {
        const r = await window.electronAPI.homeAgent.detectChatId(token)
        if ('chatId' in r) {
          detectError.value = ''
          return r
        }
      } catch (e) {
        console.error('pollForChatId poll detectChatId failed:', e)
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
      // Match `verify()` / `saveAndContinue()` — both trim. A pasted token with
      // a trailing newline would otherwise fail inject/poll even though the
      // later save path accepts it.
      const trimmedToken = tokenInput.value.trim()
      if (trimmedToken) {
        // Inject token into running backend so it can start polling (if not already)
        try {
          await window.electronAPI.homeAgent.injectToken(trimmedToken)
        } catch (e) {
          console.error('runDetectChatId: injectToken failed:', e)
          // Non-fatal — proceed to poll anyway; backend may already have it
        }
        // Poll /get-chat-id for up to DETECT_TIMEOUT_MS waiting for a message to arrive
        result = await pollForChatId(trimmedToken)
      } else {
        result = await window.electronAPI.homeAgent.detectChatIdFromSaved()
      }
      if ('chatId' in result) {
        detectedChatId.value = result.chatId
        detectStatus.value = 'idle'
        const tok = tokenInput.value.trim() || homeAgent.telegramToken?.trim() || ''
        if (tok) {
          try {
            await window.electronAPI.homeAgent.injectToken(tok, result.chatId)
          } catch (e) {
            console.error('runDetectChatId: injectToken with chatId failed:', e)
          }
        }
        // Discard the message(s) used for detection so they aren't replayed as prompts
        try {
          await window.electronAPI.homeAgent.flushPending()
        } catch (e) {
          console.error('runDetectChatId: flushPending failed:', e)
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
      // Save config first so testTelegram() can read it from the config file
      if (token && chatId) {
        const saveResult = await homeAgent.saveConfig(token, chatId)
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
      const result = await window.electronAPI.homeAgent.testTelegram()
      if (result.success) {
        homeAgent.setVerified()
        verifyStatus.value = 'success'
        const tokForInject = token || homeAgent.telegramToken?.trim()
        const cidForInject = chatId
        if (tokForInject && cidForInject) {
          try {
            await window.electronAPI.homeAgent.injectToken(tokForInject, cidForInject)
          } catch (e) {
            console.error('verify: injectToken failed:', e)
          }
        }
      } else {
        verifyStatus.value = 'error'
        verifyError.value = result.error ?? 'Unknown error'
      }
    } catch (e) {
      console.error('verify: testTelegram failed:', e)
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
        // Preserve verified state across the save — if the user already verified
        // (either in this session or a previous one), keep it true.
        const wasVerified = homeAgent.telegramVerified
        // `saveConfig` returns `{ success, error }` and can fail without throwing
        // (e.g. safeStorage / disk errors). Both code paths need to be handled
        // so the user isn't told "saved" when the config wasn't actually written.
        let saveResult: { success: boolean; error?: string }
        try {
          saveResult = await homeAgent.saveConfig(token, chatId)
        } catch (e) {
          console.error('saveAndContinue: failed to save Home Agent config:', e)
          toast.error('Failed to save Home Agent configuration')
          return false
        }
        if (!saveResult.success) {
          console.error('saveAndContinue: saveConfig returned failure:', saveResult.error)
          toast.error(saveResult.error ?? 'Failed to save Home Agent configuration')
          return false
        }
        if (wasVerified) {
          homeAgent.setVerified()
        }
        try {
          await window.electronAPI.homeAgent.injectToken(token, chatId)
        } catch (e) {
          console.error('saveAndContinue: injectToken failed:', e)
          toast.error('Saved config, but failed to apply token to the running service')
          success = false
        }
      }
    } finally {
      // Clear the active conversation so the message sent during detection
      // isn't picked up as the first user prompt in Home Agent mode.
      conversations.addNewConversation()
    }
    return success
  }

  /** Rehydrate local setup UI from Pinia + safeStorage (e.g. after revisiting the wizard). */
  function syncSetupFieldsFromStore() {
    if (homeAgent.telegramChatId) {
      detectedChatId.value = homeAgent.telegramChatId
    }
  }

  async function clearConfig() {
    try {
      await homeAgent.clearConfig()
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
