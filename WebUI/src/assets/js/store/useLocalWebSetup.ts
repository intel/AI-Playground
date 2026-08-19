import { ref, computed, watch } from 'vue'
import { useHomeAgent } from './homeAgent'
import { useErrors } from './errors'
import {
  DEFAULT_LOCAL_WEB_PORT,
  MAX_LOCAL_WEB_PORT,
  MIN_LOCAL_WEB_PORT,
  parseLocalWebPort,
} from './localWebPort'

const MIN_PASSWORD_LEN = 4

/**
 * Local-web mirror of `useTelegramSetup` / `useSlackSetup`. Same wizard shape
 * (configure → save → verify), but the "credentials" are a port + LAN toggle +
 * chat password. Verification asks the backend to actually bind the HTTP+SSE
 * server (`channel.test('local-web')`); on success we surface the LAN URLs the
 * served chat page is reachable at.
 */
export function useLocalWebSetup() {
  const homeAgent = useHomeAgent()
  const errors = useErrors()

  // String initially, but Vue's implicit `.number` on the `<input type="number">`
  // turns it into a number once the user edits it — `parseLocalWebPort` takes both.
  const portInput = ref<string | number>(String(DEFAULT_LOCAL_WEB_PORT))
  // Default OFF: binding 0.0.0.0 exposes the (plaintext) chat to the whole LAN,
  // so the user must opt in explicitly.
  const allowLan = ref(false)
  const passwordInput = ref('')
  const showPassword = ref(false)
  const verifyStatus = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
  const verifyError = ref('')
  const urls = ref<string[]>([])

  /** The password held in the (asynchronously loaded) runtime config. */
  const savedPassword = computed(
    () => (homeAgent.channels['local-web'].config as { password?: string }).password?.trim() ?? '',
  )
  // Only a password we can actually see lets the user leave the field blank.
  // `channelPrefs.verified` restores synchronously from persisted state while the
  // config is still loading over IPC, so trusting it here accepted a blank
  // password during that window and saved an empty one.
  const hasSavedPassword = computed(() => savedPassword.value.length > 0)

  // Display-only: "this channel has been set up before", which is true as soon as
  // the persisted flag says so. Never use it to authorize a blank password.
  const isAlreadyConfigured = computed(
    () => hasSavedPassword.value || homeAgent.channelPrefs['local-web'].verified,
  )

  /** The typed port, or null when it is out of range / not a number. Tracked
   *  separately from `portNumber` so a bad entry is refused instead of quietly
   *  becoming the default — which would start the server on a port the user
   *  never asked for. */
  const parsedPort = computed(() => parseLocalWebPort(portInput.value))
  const portValid = computed(() => parsedPort.value !== null)
  const portError = computed(() =>
    portValid.value ? '' : `Enter a port between ${MIN_LOCAL_WEB_PORT} and ${MAX_LOCAL_WEB_PORT}.`,
  )

  const portNumber = computed(() => parsedPort.value ?? DEFAULT_LOCAL_WEB_PORT)

  const passwordReady = computed(() => {
    const p = passwordInput.value.trim()
    if (p.length >= MIN_PASSWORD_LEN) return true
    return hasSavedPassword.value && !p
  })

  const canVerify = computed(() => portValid.value && passwordReady.value)

  function currentPasswordForSave(): string {
    return passwordInput.value.trim()
  }

  async function refreshUrls() {
    if (!portValid.value) {
      urls.value = []
      return
    }
    try {
      // Mirror the bind: with LAN access off the server only answers on loopback,
      // so listing this machine's other addresses would be dead links.
      urls.value = await window.electronAPI.homeAgent.localWeb.getUrls(
        portNumber.value,
        allowLan.value,
      )
    } catch (e) {
      urls.value = []
      errors.report(e, {
        category: 'channel',
        code: 'channel/local-web-url-discovery-failed',
        userMessage: 'Could not determine the addresses the LAN chat is reachable at.',
        // The setup screen simply shows no addresses; a toast would add nothing.
        surface: 'silent',
      })
    }
  }

  // Keep the address list honest as the form changes — the port and the LAN
  // toggle both change which URLs can answer.
  watch([portInput, allowLan], () => void refreshUrls())

  async function runVerify() {
    verifyStatus.value = 'loading'
    verifyError.value = ''
    if (!portValid.value) {
      verifyStatus.value = 'error'
      verifyError.value = portError.value
      return
    }
    const password = currentPasswordForSave()
    const effectivePassword = password || savedPassword.value
    if (effectivePassword && effectivePassword.length < MIN_PASSWORD_LEN) {
      verifyStatus.value = 'error'
      verifyError.value = `Password must be at least ${MIN_PASSWORD_LEN} characters.`
      return
    }
    if (!effectivePassword) {
      verifyStatus.value = 'error'
      verifyError.value = 'Choose a password for the LAN chat page.'
      return
    }
    try {
      const saveResult = await homeAgent.saveChannelConfig('local-web', {
        kind: 'local-web',
        port: String(portNumber.value),
        allowLan: allowLan.value ? 'true' : 'false',
        sessionId: 'local',
        password: effectivePassword,
      })
      if (!saveResult.success) {
        verifyStatus.value = 'error'
        verifyError.value = saveResult.error ?? 'Failed to save LAN chat config.'
        return
      }
      const test = await window.electronAPI.homeAgent.channel.test('local-web')
      if (!test.success) {
        verifyStatus.value = 'error'
        verifyError.value = test.error ?? 'Could not start LAN chat server.'
        return
      }
      homeAgent.channelPrefs['local-web'].identity = 'local'
      homeAgent.setVerified('local-web')
      verifyStatus.value = 'success'
      passwordInput.value = ''
      await refreshUrls()
    } catch (e) {
      const error = errors.report(e, {
        category: 'channel',
        code: 'channel/local-web-verify-failed',
        userMessage: 'Could not start the LAN chat server.',
        // Shown inline on the setup step; the sink only needs to log and track it.
        surface: 'silent',
      })
      verifyStatus.value = 'error'
      verifyError.value = error.userMessage
    }
  }

  async function loadSavedIntoForm() {
    const cfg = homeAgent.channels['local-web'].config as {
      port?: string
      allowLan?: string
    }
    if (cfg.port) portInput.value = cfg.port
    if (cfg.allowLan !== undefined) allowLan.value = cfg.allowLan === 'true'
    await refreshUrls()
  }

  return {
    portInput,
    allowLan,
    passwordInput,
    showPassword,
    verifyStatus,
    verifyError,
    urls,
    isAlreadyConfigured,
    hasSavedPassword,
    portNumber,
    portValid,
    portError,
    canVerify,
    runVerify,
    refreshUrls,
    loadSavedIntoForm,
  }
}
