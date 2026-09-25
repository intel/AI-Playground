import { ref, computed } from 'vue'
import QRCode from 'qrcode'
import { useHomeAgent } from './homeAgent'

const DETECT_POLL_INTERVAL_MS = 2000
const DETECT_TIMEOUT_MS = 8000
const LINK_POLL_INTERVAL_MS = 2000
const LINK_TIMEOUT_MS = 5 * 60_000

/** Drives the Signal setup wizard: download signal-cli, link the device by QR,
 *  detect the contact, and verify. Mirrors useTelegramSetup, with device
 *  linking standing in for "paste a bot token". */
export function useSignalSetup() {
  const homeAgent = useHomeAgent()

  const linkStatus = ref<'idle' | 'preparing' | 'waiting' | 'linked' | 'error'>('idle')
  const linkError = ref('')
  const qrDataUri = ref('')
  const account = ref('')

  const detectedPeer = ref('')
  const detectStatus = ref<'idle' | 'loading' | 'error'>('idle')
  const detectError = ref('')

  const verifyStatus = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
  const verifyError = ref('')

  const isLinked = computed(() => !!account.value || !!homeAgent.signalAccount)
  const isAlreadyConfigured = computed(() => isLinked.value)
  const canVerify = computed(
    () => isLinked.value && (!!detectedPeer.value || !!homeAgent.signalPeer),
  )

  async function ensureCli(): Promise<boolean> {
    const res = await window.electronAPI.homeAgent.signal.ensureCli()
    if (!res.success) {
      linkStatus.value = 'error'
      linkError.value = res.error ?? 'Could not install signal-cli.'
      return false
    }
    return true
  }

  async function pollLinkCompletion() {
    const deadline = Date.now() + LINK_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, LINK_POLL_INTERVAL_MS))
      if (linkStatus.value !== 'waiting') return
      try {
        const status = await window.electronAPI.homeAgent.channel.command(
          'signal',
          'linkStatus',
          {},
        )
        if (status.linked && typeof status.account === 'string') {
          account.value = status.account
          qrDataUri.value = ''
          linkStatus.value = 'linked'
          // Persist the linked number so the daemon can send from it and the
          // auto-inject watcher restarts it on the next launch.
          await homeAgent.saveChannelConfig('signal', {
            kind: 'signal',
            account: account.value,
            peer: detectedPeer.value || homeAgent.signalPeer,
          })
          return
        }
      } catch (e) {
        console.error('useSignalSetup: linkStatus poll failed:', e)
      }
    }
    if (linkStatus.value === 'waiting') {
      linkStatus.value = 'error'
      linkError.value = 'Linking timed out. Start again and scan the QR code with your phone.'
    }
  }

  async function startLink() {
    linkStatus.value = 'preparing'
    linkError.value = ''
    qrDataUri.value = ''
    if (!(await ensureCli())) return
    try {
      const res = await window.electronAPI.homeAgent.channel.command('signal', 'startLink', {})
      const linkUri = typeof res.linkUri === 'string' ? res.linkUri : ''
      if (!linkUri) {
        linkStatus.value = 'error'
        linkError.value =
          typeof res.error === 'string' ? res.error : 'Could not start device linking.'
        return
      }
      qrDataUri.value = await QRCode.toDataURL(linkUri, { width: 240, margin: 1 })
      linkStatus.value = 'waiting'
      void pollLinkCompletion()
    } catch (e) {
      linkStatus.value = 'error'
      linkError.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function runDetectPeer() {
    detectStatus.value = 'loading'
    detectError.value = ''
    try {
      // Ensure the daemon has the account so it is receiving, then wait for the
      // first inbound message to reveal the contact (like Telegram chat-id).
      await window.electronAPI.homeAgent.channel
        .inject('signal', { account: account.value || homeAgent.signalAccount })
        .catch((e: unknown) => console.error('useSignalSetup: inject failed:', e))
      const deadline = Date.now() + DETECT_TIMEOUT_MS
      detectError.value = 'Waiting for a message… open Signal and message your linked number.'
      let found = ''
      // First try is immediate; then poll.
      for (;;) {
        const r = await window.electronAPI.homeAgent.channel.detectIdentity('signal', {
          account: account.value || homeAgent.signalAccount,
        })
        if ('identity' in r) {
          found = r.identity
          break
        }
        if (Date.now() >= deadline) break
        await new Promise((res) => setTimeout(res, DETECT_POLL_INTERVAL_MS))
      }
      if (found) {
        detectedPeer.value = found
        detectStatus.value = 'idle'
        detectError.value = ''
        await window.electronAPI.homeAgent.channel
          .inject('signal', { account: account.value || homeAgent.signalAccount, peer: found })
          .catch((e: unknown) => console.error('useSignalSetup: inject(peer) failed:', e))
      } else {
        detectStatus.value = 'error'
        detectError.value = 'Timed out. Message your Signal number, then click Detect again.'
      }
    } catch (e) {
      detectStatus.value = 'error'
      detectError.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function verify() {
    const acct = account.value || homeAgent.signalAccount
    const peer = detectedPeer.value || homeAgent.signalPeer
    verifyStatus.value = 'loading'
    verifyError.value = ''
    try {
      if (!acct) {
        verifyStatus.value = 'error'
        verifyError.value = 'Link your Signal account first.'
        return
      }
      if (!peer) {
        verifyStatus.value = 'error'
        verifyError.value = 'No contact detected — complete the Detect step first.'
        return
      }
      const saveResult = await homeAgent.saveChannelConfig('signal', {
        kind: 'signal',
        account: acct,
        peer,
      })
      if (!saveResult.success) {
        verifyStatus.value = 'error'
        verifyError.value = saveResult.error ?? 'Failed to save config'
        return
      }
      const result = await window.electronAPI.homeAgent.channel.test('signal')
      if (result.success) {
        homeAgent.setVerified('signal')
        verifyStatus.value = 'success'
      } else {
        verifyStatus.value = 'error'
        verifyError.value = result.error ?? 'Unknown error'
      }
    } catch (e) {
      verifyStatus.value = 'error'
      verifyError.value = e instanceof Error ? e.message : 'Verification failed'
    }
  }

  function syncSetupFieldsFromStore() {
    if (homeAgent.signalAccount) account.value = homeAgent.signalAccount
    if (homeAgent.signalPeer) detectedPeer.value = homeAgent.signalPeer
    if (isLinked.value && linkStatus.value === 'idle') linkStatus.value = 'linked'
  }

  async function clearConfig() {
    try {
      await homeAgent.clearChannelConfig('signal')
    } catch (e) {
      console.error('useSignalSetup: clearConfig failed:', e)
    } finally {
      account.value = ''
      detectedPeer.value = ''
      qrDataUri.value = ''
      linkStatus.value = 'idle'
      linkError.value = ''
      detectStatus.value = 'idle'
      detectError.value = ''
      verifyStatus.value = 'idle'
      verifyError.value = ''
    }
  }

  return {
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
  }
}
