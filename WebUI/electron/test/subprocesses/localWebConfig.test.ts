import { describe, it, expect, vi } from 'vitest'
import {
  buildChannelConfigFile,
  localWebUrlsFor,
  normalizeChannelSecret,
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

describe('local web URL discovery', () => {
  const interfaces = {
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    en0: [{ family: 'IPv4', internal: false, address: '192.168.1.10' }],
    wlan1: [
      { family: 'IPv4', internal: false, address: '10.0.0.25' },
      { family: 'IPv6', internal: false, address: 'fe80::1' },
    ],
    docker0: undefined,
  }

  it('offers only loopback when LAN access is off', () => {
    // The Python server binds 127.0.0.1 in this mode, so a LAN address in the
    // setup screen would be a link that never answers.
    expect(localWebUrlsFor(8765, false, interfaces)).toEqual([
      'http://127.0.0.1:8765/',
      'http://localhost:8765/',
    ])
  })

  it('adds every non-internal IPv4 address when LAN access is on', () => {
    expect(localWebUrlsFor(8770, true, interfaces)).toEqual([
      'http://127.0.0.1:8770/',
      'http://localhost:8770/',
      'http://192.168.1.10:8770/',
      'http://10.0.0.25:8770/',
    ])
  })

  it('never lists IPv6 or internal addresses', () => {
    const urls = localWebUrlsFor(80, true, interfaces).join(' ')
    expect(urls).not.toContain('fe80')
  })
})

describe('channel secret normalization', () => {
  it('strips all whitespace from machine-issued tokens', () => {
    // Guards a copy-paste that picked up a newline.
    expect(normalizeChannelSecret('telegram', 'token', ' 123:AB cd\n')).toBe('123:ABcd')
    expect(normalizeChannelSecret('slack', 'botToken', 'xoxb-\t1 2')).toBe('xoxb-12')
  })

  it('keeps the inner spaces of a user-chosen password', () => {
    // Regression: collapsing them stored a password the user could never type
    // again, so the LAN chat login failed with no explanation.
    expect(normalizeChannelSecret('local-web', 'password', '  my pass word  ')).toBe('my pass word')
  })
})

describe('channel config file assembly', () => {
  const encrypt = (s: string) => ({ type: 'Buffer', data: [...Buffer.from(s)] })
  const saved = buildChannelConfigFile(
    'local-web',
    { password: 'hunter two', port: '8765', allowLan: 'true', sessionId: 'local' },
    null,
    encrypt,
  )

  it('encrypts secrets and stores public fields in the clear', () => {
    expect(Buffer.from(saved.encryptedFields!.password.data).toString()).toBe('hunter two')
    expect(saved.publicFields).toEqual({ port: '8765', allowLan: 'true', sessionId: 'local' })
  })

  it('keeps a stored secret when the save omits it', () => {
    // Regression: a blank password field erased the saved one, so the LAN chat
    // could no longer start and the user had to guess what had happened.
    const resaved = buildChannelConfigFile(
      'local-web',
      { password: '', port: '9000', allowLan: 'false', sessionId: 'local' },
      saved,
      encrypt,
    )
    expect(resaved.encryptedFields).toEqual(saved.encryptedFields)
    expect(resaved.publicFields!.port).toBe('9000')
  })

  it('carries the setup flags across a credential re-save', () => {
    const withPrefs = { ...saved, prefs: { verified: true, enabled: true } }
    const resaved = buildChannelConfigFile(
      'local-web',
      { password: 'new one', port: '8765', allowLan: 'true', sessionId: 'local' },
      withPrefs,
      encrypt,
    )
    expect(resaved.prefs).toEqual({ verified: true, enabled: true })
    expect(Buffer.from(resaved.encryptedFields!.password.data).toString()).toBe('new one')
  })
})
