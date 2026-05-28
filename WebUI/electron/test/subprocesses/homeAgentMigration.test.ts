import { describe, it, expect, vi } from 'vitest'
import {
  migrateLegacySlackConfig,
  migrateLegacyTelegramConfig,
} from '../../subprocesses/homeAgentBackendService'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  safeStorage: {
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf-8'),
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {},
  net: { fetch: vi.fn() },
}))

describe('channel config migration', () => {
  const fakeEncrypted = { type: 'Buffer', data: [1, 2, 3, 4] }

  it('migrates a legacy Telegram blob into the channel layout', () => {
    const result = migrateLegacyTelegramConfig({
      encryptedToken: fakeEncrypted,
      chatId: '12345',
    })
    expect(result).toEqual({
      kind: 'telegram',
      encryptedFields: { token: fakeEncrypted },
      publicFields: { chatId: '12345' },
    })
  })

  it('preserves chatId as empty string when absent', () => {
    const result = migrateLegacyTelegramConfig({ encryptedToken: fakeEncrypted })
    expect(result?.publicFields).toEqual({ chatId: '' })
  })

  it('returns null when telegram has no encrypted token', () => {
    expect(migrateLegacyTelegramConfig({})).toBeNull()
    expect(migrateLegacyTelegramConfig({ chatId: '12' })).toBeNull()
  })

  it('migrates a legacy Slack blob into the channel layout', () => {
    const bot = { type: 'Buffer', data: [1, 1] }
    const appT = { type: 'Buffer', data: [2, 2] }
    const result = migrateLegacySlackConfig({
      encryptedBotToken: bot,
      encryptedAppToken: appT,
      userId: 'U0123',
    })
    expect(result).toEqual({
      kind: 'slack',
      encryptedFields: { botToken: bot, appToken: appT },
      publicFields: { userId: 'U0123' },
    })
  })

  it('returns null when Slack is missing either token', () => {
    expect(migrateLegacySlackConfig({ encryptedBotToken: fakeEncrypted, userId: 'U' })).toBeNull()
    expect(migrateLegacySlackConfig({ encryptedAppToken: fakeEncrypted, userId: 'U' })).toBeNull()
  })

  it('falls back to empty userId for partial Slack blobs', () => {
    const bot = { type: 'Buffer', data: [1] }
    const appT = { type: 'Buffer', data: [2] }
    const result = migrateLegacySlackConfig({
      encryptedBotToken: bot,
      encryptedAppToken: appT,
    })
    expect(result?.publicFields).toEqual({ userId: '' })
  })
})
