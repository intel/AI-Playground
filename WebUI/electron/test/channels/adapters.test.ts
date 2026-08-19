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
import { createLocalWebAdapter } from '../../../src/assets/js/store/channels/localWebAdapter'
import type { RawPart } from '../../../src/assets/js/store/channels/adapter'

describe('channel adapters', () => {
  const telegram = createTelegramAdapter()
  const slack = createSlackAdapter()
  const localWeb = createLocalWebAdapter()

  it('expose their kind', () => {
    expect(telegram.kind).toBe('telegram')
    expect(slack.kind).toBe('slack')
    expect(localWeb.kind).toBe('local-web')
  })

  it('local web routes sends through the generic local-web channel', async () => {
    sendMock.mockClear()
    sendMock.mockResolvedValueOnce({ success: true })
    await localWeb.reply('Here is your haiku')
    expect(sendMock).toHaveBeenCalledWith(
      'local-web',
      'reply',
      expect.objectContaining({ text: 'Here is your haiku' }),
    )
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

  it('local web stops the typing indicator when the turn ends', async () => {
    // Regression: the disposer was a no-op, so a turn that produced no output left
    // the browser showing the typing dots for good.
    sendMock.mockClear()
    const stop = localWeb.startTypingHeartbeat('typing')
    expect(sendMock).toHaveBeenCalledWith('local-web', 'typing', { action: 'typing' })
    stop()
    expect(sendMock).toHaveBeenLastCalledWith('local-web', 'typing', { action: 'stop' })
  })

  it('local web settles a keyboard prompt with editMessage, not a plain reply', async () => {
    // The page keys off this action to retire the buttons; sending it as a reply
    // left an answered prompt tappable, re-firing its callback.
    sendMock.mockClear()
    sendMock.mockResolvedValueOnce({ success: true })
    await localWeb.editKeyboardMessage({ ts: '1', channel: 'local-web' }, 'Confirmed.')
    expect(sendMock).toHaveBeenCalledWith('local-web', 'editMessage', { text: 'Confirmed.' })
  })

  it('local web renders the image preset + prompt (draft and final)', () => {
    // Regression: the generic tool marker skips image tools (Telegram renders
    // them specially), so without a dedicated image renderer the browser only
    // got the finished photo — never the "Generating using preset … <prompt>"
    // line the desktop app shows.
    const parts: RawPart[] = [
      {
        type: 'tool-comfyUI',
        state: 'input-available',
        input: { workflow: 'Line Art', prompt: 'a friendly lizard on a surfboard' },
      },
    ]
    const draft = localWeb.formatDraft(parts)
    expect(draft).toContain('Line Art')
    expect(draft).toContain('a friendly lizard on a surfboard')
    expect(draft).toContain('Generating')

    const doneParts: RawPart[] = [{ ...parts[0], state: 'output-available' }]
    const final = localWeb.formatFinal(doneParts)
    expect(final).toContain('Line Art')
    expect(final).toContain('a friendly lizard on a surfboard')
    expect(final).toContain('Generated')
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
