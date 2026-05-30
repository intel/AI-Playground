import { ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { app, BrowserWindow, ipcMain, net, safeStorage } from 'electron'
import { LocalSettings } from '../main.ts'
import { GitService, LongLivedPythonApiService, createEnhancedErrorDetails } from './service.ts'
import { aipgBaseDir, checkBackend, installBackend } from './uvBasedBackends/uv.ts'

// ── Channel-agnostic types ────────────────────────────────────────────────
// Mirrored from WebUI/src/assets/js/store/channels/types.ts. Keeping a local
// copy avoids the renderer-side store importing electron types and vice
// versa; the contract is small enough that drift is easy to spot.

type ChannelKind = 'telegram' | 'slack' | 'discord'

type EncryptedField = { type: string; data: number[] }

/** Per-channel safeStorage blob. `encryptedFields` stores any number of
 *  secret strings (token, botToken, appToken, …) so adding a new channel does
 *  not require new code in this file — only new key names. `publicFields`
 *  carries non-sensitive bits (chatId, userId, …) in plaintext for display. */
export type ChannelConfigFile = {
  kind: ChannelKind
  encryptedFields: Record<string, EncryptedField>
  publicFields: Record<string, string>
}

/** Legacy on-disk shapes that pre-date the channel-registry refactor. */
export type LegacyTelegramConfig = { encryptedToken?: EncryptedField; chatId?: string }
export type LegacySlackConfig = {
  encryptedBotToken?: EncryptedField
  encryptedAppToken?: EncryptedField
  userId?: string
}

/** Pure helpers for legacy → channel-config migration. Exported so unit tests
 *  can exercise the transformation without mocking `fs` / `safeStorage`. */
export function migrateLegacyTelegramConfig(data: LegacyTelegramConfig): ChannelConfigFile | null {
  if (!data.encryptedToken) return null
  return {
    kind: 'telegram',
    encryptedFields: { token: data.encryptedToken },
    publicFields: { chatId: data.chatId ?? '' },
  }
}

export function migrateLegacySlackConfig(data: LegacySlackConfig): ChannelConfigFile | null {
  if (!data.encryptedBotToken || !data.encryptedAppToken) return null
  return {
    kind: 'slack',
    encryptedFields: {
      botToken: data.encryptedBotToken,
      appToken: data.encryptedAppToken,
    },
    publicFields: { userId: data.userId ?? '' },
  }
}

/** Generic send-payload envelope. The renderer assembles channel-native
 *  values (HTML for Telegram, mrkdwn for Slack); this layer just forwards. */
type ChannelSendPayload = Record<string, unknown>

/** Which fields of which kind are secret vs public. Centralized so both
 *  save and load can use the same shape, and the renderer's `loadConfig`
 *  response remains backwards-shaped for downstream code. */
const SECRET_FIELDS: Record<ChannelKind, string[]> = {
  telegram: ['token'],
  slack: ['botToken', 'appToken'],
  discord: ['botToken'],
}
const PUBLIC_FIELDS: Record<ChannelKind, string[]> = {
  telegram: ['chatId'],
  slack: ['userId'],
  discord: ['userId'],
}

export class HomeAgentBackendService extends LongLivedPythonApiService {
  readonly serviceFolder = 'home-agent'
  readonly baseDir = path.resolve(path.join(aipgBaseDir, this.serviceFolder))
  readonly serviceDir = this.baseDir
  readonly pythonEnvDir = path.resolve(path.join(this.serviceDir, '.venv'))
  devices: InferenceDevice[] = [{ id: '*', name: 'Auto select device', selected: true }]
  readonly git = new GitService()

  isSetUp: boolean = false
  readonly isRequired = false
  healthEndpointUrl = `${this.baseUrl}/healthy`

  // Per-launch loopback auth token. The backend binds to 127.0.0.1 so remote
  // hosts cannot reach it, but on a multi-user / multi-tenant box other local
  // processes (low-IL services, host-networked containers, other UIDs on the
  // same machine) could still hit our port. Requiring an `X-AIPG-Auth` header
  // keyed by a fresh per-launch secret blocks that path. Mirrors the pattern
  // used by `aiBackendService` and `comfyUIBackendService`.
  private loopbackAuthToken: string = randomBytes(32).toString('hex')

  getLoopbackAuthToken(): string {
    return this.loopbackAuthToken
  }

  /**
   * Headers to attach to every outbound request from the Electron main process
   * to this backend. `/healthy` is exempt on the server side, so polling it
   * before the token is known still works.
   */
  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return { 'X-AIPG-Auth': this.loopbackAuthToken, ...(extra ?? {}) }
  }

  constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
    super(name, port, win, settings)

    this.serviceIsSetUp().then(async (setUp) => {
      this.isSetUp = setUp
      if (this.isSetUp) {
        await this.updateCachedVersion()
        this.setStatus('notYetStarted')
      }
      this.appLogger.info(`Service ${this.name} isSetUp: ${this.isSetUp}`, this.name)
    })

    // One-shot migration: legacy `home-agent-config.json` (Telegram) and
    // `home-agent-slack-config.json` (Slack) move to the new uniform
    // `home-agent-channel-<kind>.json` layout. Runs once per process; safe to
    // run repeatedly since it deletes the legacy file after a successful copy.
    this.migrateLegacyConfigs()
  }

  async serviceIsSetUp(): Promise<boolean> {
    const result = await checkBackend(this.serviceFolder)
      .then(() => true)
      .catch(() => false)
    this.appLogger.info(`Service ${this.name} isSetUp: ${result}`, this.name)
    return result
  }

  async detectDevices(): Promise<void> {}

  async *set_up(): AsyncIterable<SetupProgress> {
    this.setStatus('installing')
    this.appLogger.info('setting up home-agent service', this.name)

    let currentStep = 'start'

    try {
      currentStep = 'start'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'starting to set up environment',
      }

      await this.git.ensureInstalled()

      currentStep = 'install dependencies'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'installing dependencies',
      }

      await installBackend(this.serviceFolder)

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'dependencies installed',
      }

      this.setStatus('notYetStarted')
      currentStep = 'end'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'success',
        debugMessage: 'home-agent service set up completely',
      }
    } catch (e) {
      this.appLogger.warn(`Set up of home-agent failed due to ${e}`, this.name, true)
      this.setStatus('installationFailed')

      const errorDetails = await createEnhancedErrorDetails(e, `${currentStep} operation`)

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'failed',
        debugMessage: `Failed to setup python environment due to ${e}`,
        errorDetails,
      }
    }
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    const pathSep = process.platform === 'win32' ? ';' : ':'
    // Regenerate the token on every spawn so a previously-leaked env block
    // cannot be reused after a restart.
    this.loopbackAuthToken = randomBytes(32).toString('hex')
    const additionalEnvVariables: Record<string, string | undefined> = {
      VIRTUAL_ENV: this.pythonEnvDir,
      PATH: [
        path.join(this.pythonEnvDir, 'bin'),
        path.join(this.pythonEnvDir, 'Scripts'),
        path.join(this.pythonEnvDir, 'Library', 'bin'),
        process.env.PATH,
        path.join(this.git.dir, 'cmd'),
      ].join(pathSep),
      PYTHONNOUSERSITE: 'true',
      PYTHONIOENCODING: 'utf-8',
      PIP_CONFIG_FILE: 'nul',
      AIPG_LOOPBACK_TOKEN: this.loopbackAuthToken,
    }

    const pythonBinary = path.join(
      this.pythonEnvDir,
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python',
    )
    const apiProcess = spawn(pythonBinary, ['web_api.py', '--port', this.port.toString()], {
      cwd: this.serviceDir,
      windowsHide: true,
      env: { ...process.env, ...additionalEnvVariables },
    })

    const didProcessExitEarlyTracker = new Promise<boolean>((resolve, _reject) => {
      apiProcess.on('error', (error) => {
        this.appLogger.error(`encountered error of process in ${this.name} : ${error}`, this.name)
        resolve(true)
      })
      apiProcess.on('exit', () => {
        this.appLogger.error(`encountered unexpected exit in ${this.name}.`, this.name)
        resolve(true)
      })
    })

    return {
      process: apiProcess,
      didProcessExitEarlyTracker,
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  private channelConfigPath(kind: ChannelKind): string {
    return path.join(app.getPath('userData'), `home-agent-channel-${kind}.json`)
  }

  /**
   * Legacy config migration: copy the per-channel JSON blobs that pre-date
   * the registry refactor into the new uniform layout. We don't unlink the
   * legacy files yet — if migration ever surfaces a bug, users can still
   * roll back to an older build without losing credentials.
   */
  private migrateLegacyConfigs(): void {
    try {
      const legacyTelegram = path.join(app.getPath('userData'), 'home-agent-config.json')
      const newTelegram = this.channelConfigPath('telegram')
      if (fs.existsSync(legacyTelegram) && !fs.existsSync(newTelegram)) {
        const raw = fs.readFileSync(legacyTelegram, 'utf-8')
        const data = JSON.parse(raw) as LegacyTelegramConfig
        const migrated = migrateLegacyTelegramConfig(data)
        if (migrated) {
          fs.writeFileSync(newTelegram, JSON.stringify(migrated), 'utf-8')
          this.appLogger.info('Migrated legacy telegram config to channel layout', this.name)
        }
      }
    } catch (e) {
      this.appLogger.warn(`Telegram config migration skipped: ${e}`, this.name)
    }
    try {
      const legacySlack = path.join(app.getPath('userData'), 'home-agent-slack-config.json')
      const newSlack = this.channelConfigPath('slack')
      if (fs.existsSync(legacySlack) && !fs.existsSync(newSlack)) {
        const raw = fs.readFileSync(legacySlack, 'utf-8')
        const data = JSON.parse(raw) as LegacySlackConfig
        const migrated = migrateLegacySlackConfig(data)
        if (migrated) {
          fs.writeFileSync(newSlack, JSON.stringify(migrated), 'utf-8')
          this.appLogger.info('Migrated legacy slack config to channel layout', this.name)
        }
      }
    } catch (e) {
      this.appLogger.warn(`Slack config migration skipped: ${e}`, this.name)
    }
  }

  /** Save a channel config blob. `config` is a flat object with both secret
   *  and public fields; this method partitions them according to
   *  `SECRET_FIELDS[kind]` / `PUBLIC_FIELDS[kind]` and encrypts the secrets. */
  saveChannelConfig(
    kind: ChannelKind,
    config: Record<string, string>,
  ): { success: boolean; error?: string } {
    try {
      const secretKeys = SECRET_FIELDS[kind] ?? []
      const publicKeys = PUBLIC_FIELDS[kind] ?? []
      const encryptedFields: Record<string, EncryptedField> = {}
      const publicFields: Record<string, string> = {}
      for (const k of secretKeys) {
        const raw = (config[k] ?? '').trim().replace(/\s+/g, '')
        if (raw) {
          encryptedFields[k] = safeStorage.encryptString(raw).toJSON()
        }
      }
      for (const k of publicKeys) {
        publicFields[k] = (config[k] ?? '').trim()
      }
      const data: ChannelConfigFile = { kind, encryptedFields, publicFields }
      fs.writeFileSync(this.channelConfigPath(kind), JSON.stringify(data), 'utf-8')
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  loadChannelConfig(kind: ChannelKind): Record<string, string> | null {
    try {
      const raw = fs.readFileSync(this.channelConfigPath(kind), 'utf-8')
      const data = JSON.parse(raw) as ChannelConfigFile
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(data.encryptedFields ?? {})) {
        try {
          out[k] = safeStorage.decryptString(Buffer.from(v.data))
        } catch (e) {
          this.appLogger.warn(`Failed to decrypt ${kind}.${k}: ${e}`, this.name)
        }
      }
      for (const [k, v] of Object.entries(data.publicFields ?? {})) {
        out[k] = v
      }
      return out
    } catch {
      return null
    }
  }

  clearChannelConfig(kind: ChannelKind): void {
    try {
      fs.unlinkSync(this.channelConfigPath(kind))
    } catch {
      // ignore if not found
    }
  }

  // ── Generic channel dispatcher ──────────────────────────────────────────

  /** Inject credentials into the running backend so its channel bot starts.
   *  Returns `{status: 'not_running'}` when the service hasn't started yet —
   *  the renderer's auto-injection watcher will retry once the service comes
   *  up.
   */
  async channelSetConfig(
    kind: ChannelKind,
    config: Record<string, string | undefined>,
  ): Promise<{ status: string; error?: string }> {
    if (this.currentStatus !== 'running') return { status: 'not_running' }
    try {
      const res = await net.fetch(`${this.baseUrl}/channel/${kind}/config`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(config),
      })
      if (!res.ok) {
        let errorBody = ''
        try {
          errorBody = await res.text()
        } catch {
          // ignore
        }
        return {
          status: 'error',
          error: `HTTP ${res.status} ${res.statusText}${errorBody ? `: ${errorBody}` : ''}`,
        }
      }
      const body = (await res.json()) as { status?: string }
      return { status: body.status ?? 'ok' }
    } catch (e) {
      return { status: 'error', error: e instanceof Error ? e.message : String(e) }
    }
  }

  async channelGetIdentity(kind: ChannelKind): Promise<{ identity: string } | { error: string }> {
    if (this.currentStatus !== 'running') return { error: 'service_not_running' }
    try {
      const res = await net.fetch(`${this.baseUrl}/channel/${kind}/identity`, {
        headers: this.authHeaders(),
      })
      const data = (await res.json()) as { identity?: string; error?: string }
      if (data.identity) return { identity: data.identity }
      return { error: data.error ?? 'no identity yet' }
    } catch (e) {
      return { error: String(e) }
    }
  }

  async channelPoll(kind: ChannelKind): Promise<
    Array<{
      text?: string
      chat_id: string
      channel?: string
      ts?: string
      images?: Array<{ mime: string; data_base64: string }>
      audio?: Array<{ mime: string; data_base64: string }>
      callback?: string
    }>
  > {
    if (this.currentStatus !== 'running') return []
    try {
      const res = await net.fetch(`${this.baseUrl}/channel/${kind}/poll`, {
        headers: this.authHeaders(),
      })
      return (await res.json()) as Array<{
        text?: string
        chat_id: string
        channel?: string
        ts?: string
        images?: Array<{ mime: string; data_base64: string }>
        audio?: Array<{ mime: string; data_base64: string }>
        callback?: string
      }>
    } catch {
      return []
    }
  }

  async channelFlushPending(kind: ChannelKind): Promise<void> {
    if (this.currentStatus !== 'running') return
    try {
      await net.fetch(`${this.baseUrl}/channel/${kind}/flush`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: '{}',
      })
    } catch {
      // ignore
    }
  }

  /** Generic send dispatcher. `action` is one of reply/update/photo/typing/keyboard.
   *  The Python channel module's matching `send_<action>` method receives the
   *  raw payload, so renderer-side wrappers (telegramAdapter, slackAdapter)
   *  are free to shape it however the platform requires. */
  async channelSend(
    kind: ChannelKind,
    action: 'reply' | 'update' | 'photo' | 'video' | 'voice' | 'document' | 'typing' | 'keyboard',
    payload: ChannelSendPayload,
  ): Promise<{ success: boolean; ts?: string; channel?: string; error?: string }> {
    if (this.currentStatus !== 'running') return { success: false, error: 'Home Agent not running' }
    try {
      const url = `${this.baseUrl}/channel/${kind}/send/${action}`
      const res = await net.fetch(url, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      })
      const parsed = (await res.json().catch(() => ({}))) as {
        status?: string
        ts?: string
        channel?: string
        error?: string
      }
      if (!res.ok || parsed.error) {
        return {
          success: false,
          error: parsed.error ?? `status ${res.status}`,
        }
      }
      return { success: true, ts: parsed.ts, channel: parsed.channel }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  // ── Verification / detection helpers ────────────────────────────────────
  // Channel-specific verification (auth.test + sendMessage / sendTelegramTest)
  // talks directly to the platform's API from the main process so the user
  // can verify credentials before saving them locally. These remain channel-
  // specific because each platform has its own auth shape.

  async testTelegram(): Promise<{ success: boolean; error?: string }> {
    try {
      const config = this.loadChannelConfig('telegram')
      if (!config) return { success: false, error: 'No config saved' }
      const { token, chatId } = config
      if (!token || !chatId) return { success: false, error: 'Incomplete telegram config' }
      const res = await net.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          parse_mode: 'HTML',
          text:
            '✅ <b>Home Agent is connected!</b>\n\n' +
            'Send me any message — the AI will decide whether to reply with text or generate an image.\n' +
            'Use /help to see all explicit command overrides.',
        }),
      })
      if (res.ok) return { success: true }
      return { success: false, error: await res.text() }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async testSlack(): Promise<{ success: boolean; error?: string }> {
    try {
      const config = this.loadChannelConfig('slack')
      if (!config) return { success: false, error: 'No Slack config saved' }
      const { botToken, userId } = config
      if (!botToken) return { success: false, error: 'No bot token saved' }
      if (!userId) {
        return {
          success: false,
          error: 'No DM partner detected yet — DM the bot, then click Detect.',
        }
      }
      const auth = await net.fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${botToken}`,
        },
      })
      const authBody = (await auth.json()) as { ok?: boolean; error?: string }
      if (!authBody.ok) {
        return { success: false, error: `auth.test failed: ${authBody.error ?? 'unknown'}` }
      }
      const post = await net.fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify({
          channel: userId,
          text:
            ':white_check_mark: *Home Agent is connected to Slack!*\n\n' +
            'Send me any message — the AI will decide whether to reply with text or generate an image.\n' +
            'Use `/help` to see all explicit command overrides.',
        }),
      })
      const postBody = (await post.json()) as { ok?: boolean; error?: string }
      if (!postBody.ok) {
        return {
          success: false,
          error: `chat.postMessage failed: ${postBody.error ?? 'unknown'}`,
        }
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /** Channel verification dispatcher — picks the right `test*` method for `kind`. */
  async channelTest(kind: ChannelKind): Promise<{ success: boolean; error?: string }> {
    if (kind === 'telegram') return this.testTelegram()
    if (kind === 'slack') return this.testSlack()
    return { success: false, error: `verification not implemented for ${kind}` }
  }

  // ── Identity detection ──────────────────────────────────────────────────
  // Channels use platform APIs to validate credentials when the bot isn't
  // running yet (e.g. so the wizard can surface "invalid token" before
  // dropping into the polling detection loop).

  private async detectTelegramIdentityWithToken(
    token: string,
  ): Promise<{ identity: string } | { error: string }> {
    try {
      const cleanToken = token.trim().replace(/\s+/g, '')
      const meRes = await net.fetch(`https://api.telegram.org/bot${cleanToken}/getMe`)
      const meBody = await meRes.text()
      if (!meRes.ok) {
        let msg = 'Invalid bot token. Copy it again from BotFather.'
        try {
          const parsed = JSON.parse(meBody) as { description?: string }
          if (parsed.description) msg = `Telegram error: ${parsed.description}`
        } catch {
          /* ignore */
        }
        return { error: `${msg} (token length: ${cleanToken.length})` }
      }
      // Defer to the backend (if running) for the actual chat id.
      const fromBackend = await this.channelGetIdentity('telegram')
      if ('identity' in fromBackend) return fromBackend
      return { error: 'No messages received yet. Send any message to your bot, then try again.' }
    } catch (e) {
      return { error: String(e) }
    }
  }

  private async detectSlackIdentityWithToken(
    botToken: string,
  ): Promise<{ identity: string } | { error: string }> {
    // Try the backend first (bot may be running already from a prior token).
    const fromBackend = await this.channelGetIdentity('slack')
    if ('identity' in fromBackend) return fromBackend
    // Bot not running yet — at least validate the token via auth.test so the
    // wizard surfaces a useful error.
    try {
      const cleanToken = botToken.trim().replace(/\s+/g, '')
      const auth = await net.fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${cleanToken}`,
        },
      })
      const body = (await auth.json()) as { ok?: boolean; error?: string }
      if (!body.ok) {
        return { error: `Slack auth.test failed: ${body.error ?? 'unknown'}` }
      }
      return { error: 'No DM received yet. DM your Slack bot, then click Detect.' }
    } catch (e) {
      return { error: String(e) }
    }
  }

  /** Detect identity for a channel using a freshly-pasted credential before
   *  the user has saved it. Falls back to the backend's persisted identity
   *  when the user hasn't pasted anything (used by "redetect from saved"). */
  async channelDetectIdentity(
    kind: ChannelKind,
    config: Record<string, string | undefined>,
  ): Promise<{ identity: string } | { error: string }> {
    // Try the backend's cached identity first regardless of channel — saves
    // a roundtrip when the bot has already seen a message.
    const fromBackend = await this.channelGetIdentity(kind)
    if ('identity' in fromBackend) return fromBackend

    if (kind === 'telegram') {
      const token = config.token ?? ''
      if (!token) return { error: 'No saved token' }
      return this.detectTelegramIdentityWithToken(token)
    }
    if (kind === 'slack') {
      const botToken = config.botToken ?? ''
      if (!botToken) return { error: 'No saved bot token' }
      return this.detectSlackIdentityWithToken(botToken)
    }
    return { error: `identity detection not implemented for ${kind}` }
  }

  async channelDetectIdentityFromSaved(
    kind: ChannelKind,
  ): Promise<{ identity: string } | { error: string }> {
    const config = this.loadChannelConfig(kind)
    if (!config) return { error: 'Could not read saved config' }
    return this.channelDetectIdentity(kind, config)
  }

  // ── Upstream URL ────────────────────────────────────────────────────────

  async setUpstreamUrl(url: string): Promise<void> {
    try {
      const res = await net.fetch(`${this.baseUrl}/set-upstream`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ url }),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`set-upstream returned ${res.status}: ${body}`)
      }
    } catch (e) {
      this.appLogger.warn(`Failed to set upstream URL for home-agent: ${e}`, this.name)
    }
  }

  notifyUpstreamReady(baseUrl: string): void {
    if (this.currentStatus === 'running') {
      void this.setUpstreamUrl(baseUrl)
    }
  }

  // ── IPC registration ────────────────────────────────────────────────────

  registerIpcHandlers(): void {
    // Persistence — channel-keyed by first arg.
    ipcMain.handle(
      'channel:saveConfig',
      (_event, kind: ChannelKind, config: Record<string, string>) =>
        this.saveChannelConfig(kind, config),
    )
    ipcMain.handle('channel:loadConfig', (_event, kind: ChannelKind) =>
      this.loadChannelConfig(kind),
    )
    ipcMain.handle('channel:clearConfig', (_event, kind: ChannelKind) =>
      this.clearChannelConfig(kind),
    )

    // Backend dispatch — channel-keyed by first arg.
    ipcMain.handle('channel:test', (_event, kind: ChannelKind) => this.channelTest(kind))
    ipcMain.handle(
      'channel:inject',
      (_event, kind: ChannelKind, config: Record<string, string | undefined>) =>
        this.channelSetConfig(kind, config),
    )
    ipcMain.handle(
      'channel:detectIdentity',
      (_event, kind: ChannelKind, config: Record<string, string | undefined>) =>
        this.channelDetectIdentity(kind, config),
    )
    ipcMain.handle('channel:detectIdentityFromSaved', (_event, kind: ChannelKind) =>
      this.channelDetectIdentityFromSaved(kind),
    )
    ipcMain.handle('channel:poll', (_event, kind: ChannelKind) => this.channelPoll(kind))
    ipcMain.handle('channel:flushPending', (_event, kind: ChannelKind) =>
      this.channelFlushPending(kind),
    )
    ipcMain.handle(
      'channel:send',
      (
        _event,
        kind: ChannelKind,
        action:
          | 'reply'
          | 'update'
          | 'photo'
          | 'video'
          | 'voice'
          | 'document'
          | 'typing'
          | 'keyboard',
        payload: ChannelSendPayload,
      ) => this.channelSend(kind, action, payload),
    )
  }
}
