import { describe, it, expect, vi } from 'vitest'

// The adapters wrap window.electronAPI.homeAgent.channel.send. Stub it so
// import-time and call-time references don't blow up under node-env vitest.
const sendMock = vi.fn(async () => ({ success: true }) as Record<string, unknown>)
vi.stubGlobal('window', {
  electronAPI: {
    homeAgent: {
      channel: {
        send: sendMock,
      },
    },
  },
})

import { createTelegramAdapter } from '../../../src/assets/js/store/channels/telegramAdapter'
import { createSlackAdapter } from '../../../src/assets/js/store/channels/slackAdapter'
import type { RawPart } from '../../../src/assets/js/store/channels/adapter'

describe('channel adapters', () => {
  const telegram = createTelegramAdapter()
  const slack = createSlackAdapter()

  it('expose their kind', () => {
    expect(telegram.kind).toBe('telegram')
    expect(slack.kind).toBe('slack')
  })

  it('format italic per-channel', () => {
    expect(telegram.formatItalic('hello')).toBe('<i>hello</i>')
    expect(slack.formatItalic('hello')).toBe('_hello_')
  })

  it('escape inline text', () => {
    expect(telegram.escapeInline('<script>')).toContain('&lt;')
    expect(slack.escapeInline('<safe>')).not.toContain('<')
  })

  it('emit channel-native draft text', () => {
    const parts: RawPart[] = [
      { type: 'reasoning', text: 'thinking…' },
      { type: 'text', text: '**bold**' },
    ]
    const tg = telegram.formatDraft(parts)
    const sl = slack.formatDraft(parts)
    expect(tg).toContain('<blockquote>')
    expect(sl).not.toContain('<blockquote>')
    // Slack reasoning is quoted with `> 💭`
    expect(sl).toContain('> 💭')
  })

  it('telegram keyboard returns a messageId ref and edits in place', async () => {
    sendMock.mockResolvedValueOnce({ success: true, messageId: 42 })
    const res = await telegram.keyboard('Apply settings?', [
      [
        { text: '✅ Confirm', callbackData: 'confirm:yes' },
        { text: '✖ Cancel', callbackData: 'confirm:no' },
      ],
    ])
    expect(res.ref).toEqual({ messageId: 42 })

    sendMock.mockClear()
    sendMock.mockResolvedValueOnce({ success: true })
    await telegram.editKeyboardMessage(res.ref!, '✅ Confirmed.')
    expect(sendMock).toHaveBeenCalledWith(
      'telegram',
      'editMessage',
      expect.objectContaining({ message_id: 42, text: '✅ Confirmed.' }),
    )
  })

  it('slack keyboard returns a ts/channel ref and edits in place', async () => {
    sendMock.mockResolvedValueOnce({ success: true, ts: '111.222', channel: 'C1' })
    const res = await slack.keyboard(
      'Apply settings?',
      [
        [
          { text: '✅ Confirm', callbackData: 'confirm:yes' },
          { text: '✖ Cancel', callbackData: 'confirm:no' },
        ],
      ],
      { channel: 'C1' },
    )
    expect(res.ref).toEqual({ ts: '111.222', channel: 'C1' })

    sendMock.mockClear()
    sendMock.mockResolvedValueOnce({ success: true })
    await slack.editKeyboardMessage(res.ref!, '✅ Confirmed.')
    expect(sendMock).toHaveBeenCalledWith(
      'slack',
      'update',
      expect.objectContaining({ channel: 'C1', ts: '111.222', text: '✅ Confirmed.' }),
    )
  })

  it('formatImgGenPhase reports the same lifecycle stages', () => {
    const tg = telegram.formatImgGenPhase({
      presetName: 'foo',
      state: 'generating',
      step: 'step 1 of 4',
    })
    const sl = slack.formatImgGenPhase({
      presetName: 'foo',
      state: 'generating',
      step: 'step 1 of 4',
    })
    expect(tg).toContain('✨')
    expect(sl).toContain('✨')
    // Telegram escapes HTML, Slack leaves it raw.
    expect(tg).toContain('step 1 of 4')
    expect(sl).toContain('step 1 of 4')
  })
})
