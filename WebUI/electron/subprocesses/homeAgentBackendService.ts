import { ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { app, BrowserWindow, ipcMain, net, safeStorage } from 'electron'
import { LocalSettings } from '../main.ts'
import { GitService, LongLivedPythonApiService, createEnhancedErrorDetails } from './service.ts'
import { aipgBaseDir, checkBackend, installBackend } from './uvBasedBackends/uv.ts'

type EncryptedTokenData = { type: string; data: number[] }
type HomeAgentConfigFile = { encryptedToken: EncryptedTokenData; chatId: string }
type HomeAgentSlackConfigFile = {
  encryptedBotToken: EncryptedTokenData
  encryptedAppToken: EncryptedTokenData
  userId: string
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
    const telegramEnv = this.getTelegramProcessEnv()
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
      ...telegramEnv,
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

  private getTelegramProcessEnv(): Record<string, string | undefined> {
    // Never pass TELEGRAM_* into the subprocess: web_api.py would start polling from env while
    // the renderer also POSTs /set-telegram-token → two concurrent getUpdates → Telegram 409 Conflict.
    return {}
  }

  // ── Config path ──────────────────────────────────────────────────────────

  private configPath(): string {
    return path.join(app.getPath('userData'), 'home-agent-config.json')
  }

  // ── Config persistence ───────────────────────────────────────────────────

  saveConfig(token: string, chatId: string): { success: boolean; error?: string } {
    try {
      const cleanToken = token.trim().replace(/\s+/g, '')
      const cleanChatId = chatId.trim()
      const encrypted = safeStorage.encryptString(cleanToken)
      const data: HomeAgentConfigFile = { encryptedToken: encrypted.toJSON(), chatId: cleanChatId }
      fs.writeFileSync(this.configPath(), JSON.stringify(data), 'utf-8')
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  loadConfig(): { token: string; chatId: string } | null {
    try {
      const raw = fs.readFileSync(this.configPath(), 'utf-8')
      const data = JSON.parse(raw) as HomeAgentConfigFile
      const buf = Buffer.from(data.encryptedToken.data)
      const token = safeStorage.decryptString(buf)
      return { token, chatId: data.chatId ?? '' }
    } catch {
      return null
    }
  }

  clearConfig(): void {
    try {
      fs.unlinkSync(this.configPath())
    } catch {
      // ignore if not found
    }
  }

  // ── Slack config persistence ─────────────────────────────────────────────
  // Kept in a separate JSON file so Telegram and Slack can be configured /
  // cleared independently. Both tokens are encrypted via `safeStorage`; the
  // detected `userId` is plaintext (non-sensitive, surfaced in the UI).

  private slackConfigPath(): string {
    return path.join(app.getPath('userData'), 'home-agent-slack-config.json')
  }

  saveSlackConfig(
    botToken: string,
    appToken: string,
    userId: string,
  ): { success: boolean; error?: string } {
    try {
      const cleanBot = botToken.trim().replace(/\s+/g, '')
      const cleanApp = appToken.trim().replace(/\s+/g, '')
      const cleanUser = userId.trim()
      const encryptedBot = safeStorage.encryptString(cleanBot)
      const encryptedApp = safeStorage.encryptString(cleanApp)
      const data: HomeAgentSlackConfigFile = {
        encryptedBotToken: encryptedBot.toJSON(),
        encryptedAppToken: encryptedApp.toJSON(),
        userId: cleanUser,
      }
      fs.writeFileSync(this.slackConfigPath(), JSON.stringify(data), 'utf-8')
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  loadSlackConfig(): { botToken: string; appToken: string; userId: string } | null {
    try {
      const raw = fs.readFileSync(this.slackConfigPath(), 'utf-8')
      const data = JSON.parse(raw) as HomeAgentSlackConfigFile
      const botToken = safeStorage.decryptString(Buffer.from(data.encryptedBotToken.data))
      const appToken = safeStorage.decryptString(Buffer.from(data.encryptedAppToken.data))
      return { botToken, appToken, userId: data.userId ?? '' }
    } catch {
      return null
    }
  }

  clearSlackConfig(): void {
    try {
      fs.unlinkSync(this.slackConfigPath())
    } catch {
      // ignore if not found
    }
  }

  // ── Telegram helpers ─────────────────────────────────────────────────────

  async testTelegram(): Promise<{ success: boolean; error?: string }> {
    try {
      const config = this.loadConfig()
      if (!config) return { success: false, error: 'No config saved' }
      const { token, chatId } = config
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

  async injectToken(
    token: string,
    chatId?: string | number,
  ): Promise<{ status: string; error?: string }> {
    if (this.currentStatus !== 'running') return { status: 'not_running' }
    try {
      const clean = token.trim().replace(/\s+/g, '')
      const cleanedChatId = chatId !== undefined ? String(chatId).trim() : undefined
      const res = await net.fetch(`${this.baseUrl}/set-telegram-token`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ token: clean, ...(cleanedChatId ? { chatId: cleanedChatId } : {}) }),
      })
      // Surface non-2xx as failure — `body.status ?? 'ok'` would otherwise
      // claim success on e.g. 500/4xx responses that still parse as JSON.
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

  async flushPending(): Promise<void> {
    if (this.currentStatus !== 'running') return
    try {
      await net.fetch(`${this.baseUrl}/flush-pending`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: '{}',
      })
    } catch {
      // ignore
    }
  }

  async pollTelegram(): Promise<
    Array<{
      text?: string
      chat_id: string
      images?: Array<{ mime: string; data_base64: string }>
      callback?: string
    }>
  > {
    if (this.currentStatus !== 'running') return []
    try {
      const res = await net.fetch(`${this.baseUrl}/poll-telegram`, {
        headers: this.authHeaders(),
      })
      return (await res.json()) as Array<{
        text?: string
        chat_id: string
        images?: Array<{ mime: string; data_base64: string }>
        callback?: string
      }>
    } catch {
      return []
    }
  }

  async sendTelegramPhoto(
    imageBase64: string,
    caption?: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (this.currentStatus !== 'running') return { success: false, error: 'Home Agent not running' }
    try {
      const url = `${this.baseUrl}/send-telegram-photo`
      const res = await net.fetch(url, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ photo: imageBase64, caption: caption ?? '' }),
      })
      if (res.ok) return { success: true }
      return { success: false, error: await res.text() }
    } catch (e) {
      this.appLogger.error(`sendTelegramPhoto error: ${e}`, this.name)
      return { success: false, error: String(e) }
    }
  }

  async sendTelegramReply(
    text: string,
    parseMode?: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (this.currentStatus !== 'running') return { success: false, error: 'Home Agent not running' }
    try {
      const url = `${this.baseUrl}/send-telegram-reply`
      // Log only metadata — message text is user content and shouldn't end up
      // in app logs (the logger's token-redactor only covers bot tokens).
      this.appLogger.info(`sendTelegramReply posting to ${url} (length=${text.length})`, this.name)
      const res = await net.fetch(url, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text, ...(parseMode ? { parse_mode: parseMode } : {}) }),
      })
      this.appLogger.info(`sendTelegramReply response: status=${res.status}`, this.name)
      if (res.ok) return { success: true }
      return { success: false, error: await res.text() }
    } catch (e) {
      this.appLogger.error(`sendTelegramReply error: ${e}`, this.name)
      return { success: false, error: String(e) }
    }
  }

  async sendTelegramDraft(opts: {
    draftId: number
    text?: string
    parseMode?: string
  }): Promise<{ success: boolean; error?: string }> {
    if (this.currentStatus !== 'running') return { success: false, error: 'Home Agent not running' }
    try {
      const url = `${this.baseUrl}/send-telegram-draft`
      const body = {
        draft_id: opts.draftId,
        text: opts.text ?? '',
        ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
      }
      const res = await net.fetch(url, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      })
      if (res.ok) return { success: true }
      return { success: false, error: await res.text() }
    } catch (e) {
      // Drafts are ephemeral UX gravy — log nothing on transient failures so a
      // brief Telegram outage doesn't spam the console during a streaming turn.
      return { success: false, error: String(e) }
    }
  }

  async sendTelegramChatAction(
    action: string = 'typing',
  ): Promise<{ success: boolean; error?: string }> {
    if (this.currentStatus !== 'running') return { success: false, error: 'Home Agent not running' }
    try {
      const url = `${this.baseUrl}/send-telegram-chat-action`
      const res = await net.fetch(url, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ action }),
      })
      if (res.ok) return { success: true }
      return { success: false, error: await res.text() }
    } catch (e) {
      // Don't spam the log — heartbeat fires every 4s; if Telegram is briefly
      // unreachable the next tick will retry.
      return { success: false, error: String(e) }
    }
  }

  async sendTelegramKeyboard(opts: {
    text: string
    parseMode?: string
    buttons: Array<Array<{ text: string; callbackData: string }>>
  }): Promise<{ success: boolean; error?: string }> {
    if (this.currentStatus !== 'running') return { success: false, error: 'Home Agent not running' }
    try {
      const url = `${this.baseUrl}/send-telegram-keyboard`
      // Translate camelCase TS payload -> snake_case JSON expected by web_api.py
      const body = {
        text: opts.text,
        ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
        buttons: opts.buttons.map((row) =>
          row.map((btn) => ({ text: btn.text, callback_data: btn.callbackData })),
        ),
      }
      this.appLogger.info(
        `sendTelegramKeyboard posting to ${url}: rows=${opts.buttons.length}`,
        this.name,
      )
      const res = await net.fetch(url, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      })
      this.appLogger.info(`sendTelegramKeyboard response: status=${res.status}`, this.name)
      if (res.ok) return { success: true }
      return { success: false, error: await res.text() }
    } catch (e) {
      this.appLogger.error(`sendTelegramKeyboard error: ${e}`, this.name)
      return { success: false, error: String(e) }
    }
  }

  // ── Slack runtime helpers ────────────────────────────────────────────────

  /**
   * Validate the Slack bot token via `auth.test`, then send a confirmation DM
   * via `chat.postMessage` to the verified user. Mirrors `testTelegram()`.
   */
  async testSlack(): Promise<{ success: boolean; error?: string }> {
    try {
      const config = this.loadSlackConfig()
      if (!config) return { success: false, error: 'No Slack config saved' }
      const { botToken, userId } = config
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
        return {
          success: false,
          error: `auth.test failed: ${authBody.error ?? 'unknown'}`,
        }
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

  async injectSlackTokens(
    botToken: string,
    appToken: string,
    userId?: string,
  ): Promise<{ status: string }> {
    if (this.currentStatus !== 'running') return { status: 'not_running' }
    try {
      const cleanBot = botToken.trim().replace(/\s+/g, '')
      const cleanApp = appToken.trim().replace(/\s+/g, '')
      const cleanUser = userId !== undefined ? String(userId).trim() : ''
      const res = await net.fetch(`${this.baseUrl}/set-slack-tokens`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          botToken: cleanBot,
          appToken: cleanApp,
          ...(cleanUser ? { userId: cleanUser } : {}),
        }),
      })
      const body = (await res.json()) as { status?: string }
      return { status: body.status ?? 'ok' }
    } catch (e) {
      return { status: `error: ${e}` }
    }
  }

  /**
   * Pull the first DM partner seen by the Slack bot. Requires the user to
   * have DMed the bot at least once. Falls back to `auth.test` when the bot
   * is not running so the wizard can still validate the bot token early.
   */
  async detectSlackUserId(botToken: string): Promise<{ userId: string } | { error: string }> {
    if (this.currentStatus === 'running') {
      try {
        const res = await net.fetch(`${this.baseUrl}/get-slack-user-id`, {
          headers: this.authHeaders(),
        })
        const data = (await res.json()) as { userId?: string; error?: string }
        if (data.userId) return { userId: data.userId }
      } catch {
        /* fall through to bot-token validation */
      }
    }
    // Validate the bot token at minimum so the user gets a useful error
    // ("invalid_auth", missing scopes, …) instead of "no user yet".
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
      return {
        error: 'No DM received yet. DM your Slack bot, then click Detect.',
      }
    } catch (e) {
      return { error: String(e) }
    }
  }

  async detectSlackUserIdFromSaved(): Promise<{ userId: string } | { error: string }> {
    if (this.currentStatus === 'running') {
      try {
        const res = await net.fetch(`${this.baseUrl}/get-slack-user-id`, {
          headers: this.authHeaders(),
        })
        const data = (await res.json()) as { userId?: string; error?: string }
        if (data.userId) return { userId: data.userId }
      } catch {
        /* fall through */
      }
    }
    const config = this.loadSlackConfig()
    if (!config) return { error: 'Could not read saved Slack config' }
    return this.detectSlackUserId(config.botToken)
  }

  async flushSlackPending(): Promise<void> {
    if (this.currentStatus !== 'running') return
    try {
      await net.fetch(`${this.baseUrl}/flush-slack-pending`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: '{}',
      })
    } catch {
      // ignore
    }
  }

  async pollSlack(): Promise<
    Array<{
      text?: string
      chat_id: string
      channel?: string
      ts?: string
      images?: Array<{ mime: string; data_base64: string }>
      callback?: string
    }>
  > {
    if (this.currentStatus !== 'running') return []
    try {
      const res = await net.fetch(`${this.baseUrl}/poll-slack`, {
        headers: this.authHeaders(),
      })
      return (await res.json()) as Array<{
        text?: string
        chat_id: string
        channel?: string
        ts?: string
        images?: Array<{ mime: string; data_base64: string }>
        callback?: string
      }>
    } catch {
      return []
    }
  }

  async sendSlackReply(opts: {
    text: string
    blocks?: unknown[]
    channel?: string
    threadTs?: string
  }): Promise<{ success: boolean; ts?: string; channel?: string; error?: string }> {
    if (this.currentStatus !== 'running') return { success: false, error: 'Home Agent not running' }
    try {
      const body = {
        text: opts.text,
        ...(opts.blocks ? { blocks: opts.blocks } : {}),
        ...(opts.channel ? { channel: opts.channel } : {}),
        ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
      }
      const res = await net.fetch(`${this.baseUrl}/send-slack-reply`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      })
      const parsed = (await res.json()) as {
        status?: string
        ts?: string
        channel?: string
        error?: string
      }
      if (!res.ok || parsed.error)
        return { success: false, error: parsed.error ?? `status ${res.status}` }
      return { success: true, ts: parsed.ts, channel: parsed.channel }
    } catch (e) {
      this.appLogger.error(`sendSlackReply error: ${e}`, this.name)
      return { success: false, error: String(e) }
    }
  }

  async sendSlackUpdate(opts: {
    channel: string
    ts: string
    text: string
    blocks?: unknown[]
  }): Promise<{ success: boolean; error?: string }> {
    if (this.currentStatus !== 'running') return { success: false, error: 'Home Agent not running' }
    try {
      const body = {
        channel: opts.channel,
        ts: opts.ts,
        text: opts.text,
        ...(opts.blocks ? { blocks: opts.blocks } : {}),
      }
      const res = await net.fetch(`${this.baseUrl}/send-slack-update`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      })
      if (res.ok) return { success: true }
      return { success: false, error: await res.text() }
    } catch (e) {
      // chat.update is best-effort (rate limits, edit-after-delete, …). Don't
      // spam the log so streaming turns stay quiet during transient failures.
      return { success: false, error: String(e) }
    }
  }

  async sendSlackPhoto(opts: {
    imageBase64: string
    caption?: string
    channel?: string
    threadTs?: string
  }): Promise<{ success: boolean; error?: string }> {
    if (this.currentStatus !== 'running') return { success: false, error: 'Home Agent not running' }
    try {
      const body = {
        photo: opts.imageBase64,
        caption: opts.caption ?? '',
        ...(opts.channel ? { channel: opts.channel } : {}),
        ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
      }
      const res = await net.fetch(`${this.baseUrl}/send-slack-photo`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      })
      if (res.ok) return { success: true }
      return { success: false, error: await res.text() }
    } catch (e) {
      this.appLogger.error(`sendSlackPhoto error: ${e}`, this.name)
      return { success: false, error: String(e) }
    }
  }

  async sendSlackTypingReaction(opts: {
    channel: string
    ts: string
    name?: string
    action: 'add' | 'remove'
  }): Promise<{ success: boolean; error?: string }> {
    if (this.currentStatus !== 'running') return { success: false, error: 'Home Agent not running' }
    try {
      const body = {
        channel: opts.channel,
        ts: opts.ts,
        name: opts.name ?? 'eyes',
        action: opts.action,
      }
      const res = await net.fetch(`${this.baseUrl}/send-slack-typing-reaction`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      })
      if (res.ok) return { success: true }
      return { success: false, error: await res.text() }
    } catch (e) {
      // Reactions are heartbeats — silent failures are acceptable.
      return { success: false, error: String(e) }
    }
  }

  async sendSlackKeyboard(opts: {
    text: string
    blocks: unknown[]
    channel?: string
  }): Promise<{ success: boolean; ts?: string; channel?: string; error?: string }> {
    if (this.currentStatus !== 'running') return { success: false, error: 'Home Agent not running' }
    try {
      const body = {
        text: opts.text,
        blocks: opts.blocks,
        ...(opts.channel ? { channel: opts.channel } : {}),
      }
      const res = await net.fetch(`${this.baseUrl}/send-slack-keyboard`, {
        method: 'POST',
        headers: this.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      })
      const parsed = (await res.json()) as {
        status?: string
        ts?: string
        channel?: string
        error?: string
      }
      if (!res.ok || parsed.error)
        return { success: false, error: parsed.error ?? `status ${res.status}` }
      return { success: true, ts: parsed.ts, channel: parsed.channel }
    } catch (e) {
      this.appLogger.error(`sendSlackKeyboard error: ${e}`, this.name)
      return { success: false, error: String(e) }
    }
  }

  // ── Chat ID detection ────────────────────────────────────────────────────

  private async detectChatIdWithToken(
    token: string,
  ): Promise<{ chatId: string } | { error: string }> {
    try {
      const cleanToken = token.trim().replace(/\s+/g, '')
      this.appLogger.info(
        `detectChatId token provided: ${cleanToken ? 'yes' : 'no'} (length=${cleanToken.length})`,
        this.name,
      )
      const meRes = await net.fetch(`https://api.telegram.org/bot${cleanToken}/getMe`)
      const meBody = await meRes.text()
      this.appLogger.info(
        `detectChatId getMe status=${meRes.status} body=${meBody.slice(0, 200)}`,
        this.name,
      )
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
      if (this.currentStatus === 'running') {
        try {
          const chatRes = await net.fetch(`${this.baseUrl}/get-chat-id`, {
            headers: this.authHeaders(),
          })
          const data = (await chatRes.json()) as { chatId?: string; error?: string }
          this.appLogger.info(`detectChatId /get-chat-id returned chatId=${data.chatId}`, this.name)
          if (data.chatId) return { chatId: data.chatId }
        } catch {
          /* fall through */
        }
      }
      return { error: 'No messages received yet. Send any message to your bot, then try again.' }
    } catch (e) {
      return { error: String(e) }
    }
  }

  async detectChatId(token: string): Promise<{ chatId: string } | { error: string }> {
    if (this.currentStatus === 'running') {
      try {
        const res = await net.fetch(`${this.baseUrl}/get-chat-id`, {
          headers: this.authHeaders(),
        })
        const data = (await res.json()) as { chatId?: string; error?: string }
        if (data.chatId) return { chatId: data.chatId }
      } catch {
        /* fall through */
      }
    }
    return this.detectChatIdWithToken(token)
  }

  async detectChatIdFromSaved(): Promise<{ chatId: string } | { error: string }> {
    if (this.currentStatus === 'running') {
      try {
        const res = await net.fetch(`${this.baseUrl}/get-chat-id`, {
          headers: this.authHeaders(),
        })
        const data = (await res.json()) as { chatId?: string; error?: string }
        if (data.chatId) return { chatId: data.chatId }
      } catch {
        /* fall through */
      }
    }
    const config = this.loadConfig()
    if (!config) return { error: 'Could not read saved config' }
    return this.detectChatIdWithToken(config.token)
  }

  // ── Upstream URL ─────────────────────────────────────────────────────────

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

  // ── IPC registration ─────────────────────────────────────────────────────

  registerIpcHandlers(): void {
    ipcMain.handle('homeAgent:saveConfig', (_event, token: string, chatId: string) =>
      this.saveConfig(token, chatId),
    )
    ipcMain.handle('homeAgent:loadConfig', () => this.loadConfig())
    ipcMain.handle('homeAgent:clearConfig', () => this.clearConfig())
    ipcMain.handle('homeAgent:testTelegram', () => this.testTelegram())
    ipcMain.handle('homeAgent:injectToken', (_event, token: string, chatId?: string) =>
      this.injectToken(token, chatId),
    )
    ipcMain.handle('homeAgent:detectChatId', (_event, token: string) => this.detectChatId(token))
    ipcMain.handle('homeAgent:detectChatIdFromSaved', () => this.detectChatIdFromSaved())
    ipcMain.handle('homeAgent:pollTelegram', () => this.pollTelegram())
    ipcMain.handle('homeAgent:flushPending', () => this.flushPending())
    ipcMain.handle('homeAgent:sendTelegramReply', (_event, text: string, parseMode?: string) =>
      this.sendTelegramReply(text, parseMode),
    )
    ipcMain.handle('homeAgent:sendTelegramPhoto', (_event, imageBase64: string, caption?: string) =>
      this.sendTelegramPhoto(imageBase64, caption),
    )
    ipcMain.handle('homeAgent:sendTelegramChatAction', (_event, action?: string) =>
      this.sendTelegramChatAction(action ?? 'typing'),
    )
    ipcMain.handle(
      'homeAgent:sendTelegramDraft',
      (_event, opts: { draftId: number; text?: string; parseMode?: string }) =>
        this.sendTelegramDraft(opts),
    )
    ipcMain.handle(
      'homeAgent:sendTelegramKeyboard',
      (
        _event,
        opts: {
          text: string
          parseMode?: string
          buttons: Array<Array<{ text: string; callbackData: string }>>
        },
      ) => this.sendTelegramKeyboard(opts),
    )

    // ── Slack IPC ──────────────────────────────────────────────────────────
    ipcMain.handle(
      'homeAgent:saveSlackConfig',
      (_event, botToken: string, appToken: string, userId: string) =>
        this.saveSlackConfig(botToken, appToken, userId),
    )
    ipcMain.handle('homeAgent:loadSlackConfig', () => this.loadSlackConfig())
    ipcMain.handle('homeAgent:clearSlackConfig', () => this.clearSlackConfig())
    ipcMain.handle('homeAgent:testSlack', () => this.testSlack())
    ipcMain.handle(
      'homeAgent:injectSlackTokens',
      (_event, botToken: string, appToken: string, userId?: string) =>
        this.injectSlackTokens(botToken, appToken, userId),
    )
    ipcMain.handle('homeAgent:detectSlackUserId', (_event, botToken: string) =>
      this.detectSlackUserId(botToken),
    )
    ipcMain.handle('homeAgent:detectSlackUserIdFromSaved', () => this.detectSlackUserIdFromSaved())
    ipcMain.handle('homeAgent:pollSlack', () => this.pollSlack())
    ipcMain.handle('homeAgent:flushSlackPending', () => this.flushSlackPending())
    ipcMain.handle(
      'homeAgent:sendSlackReply',
      (_event, opts: { text: string; blocks?: unknown[]; channel?: string; threadTs?: string }) =>
        this.sendSlackReply(opts),
    )
    ipcMain.handle(
      'homeAgent:sendSlackUpdate',
      (_event, opts: { channel: string; ts: string; text: string; blocks?: unknown[] }) =>
        this.sendSlackUpdate(opts),
    )
    ipcMain.handle(
      'homeAgent:sendSlackPhoto',
      (
        _event,
        opts: { imageBase64: string; caption?: string; channel?: string; threadTs?: string },
      ) => this.sendSlackPhoto(opts),
    )
    ipcMain.handle(
      'homeAgent:sendSlackTypingReaction',
      (_event, opts: { channel: string; ts: string; name?: string; action: 'add' | 'remove' }) =>
        this.sendSlackTypingReaction(opts),
    )
    ipcMain.handle(
      'homeAgent:sendSlackKeyboard',
      (_event, opts: { text: string; blocks: unknown[]; channel?: string }) =>
        this.sendSlackKeyboard(opts),
    )
  }
}
