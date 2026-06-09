import { describe, it, expect, beforeEach } from 'vitest'

import {
  createMockAdapter,
  mockChannelBus,
} from '../../../src/assets/js/store/channels/mockAdapter'
import type { RawPart } from '../../../src/assets/js/store/channels/adapter'

describe('mock channel adapter', () => {
  const mock = createMockAdapter()

  beforeEach(() => {
    mockChannelBus.clear()
  })

  it('exposes its kind', () => {
    expect(mock.kind).toBe('mock')
  })

  it('captures replies into the outbox', async () => {
    await mock.reply('hello world')
    expect(mockChannelBus.outbox).toHaveLength(1)
    expect(mockChannelBus.outbox[0]).toMatchObject({ kind: 'reply', text: 'hello world' })
  })

  it('captures media sends with their payloads', async () => {
    await mock.photo('aGVsbG8=', 'a caption')
    await mock.video('dmlk', 'clip', 'clip.mp4')
    await mock.document('ZG9j', 'model.glb', '3d model')
    expect(mockChannelBus.outbox.map((e) => e.kind)).toEqual(['photo', 'video', 'document'])
    expect(mockChannelBus.outbox[0]).toMatchObject({ base64: 'aGVsbG8=', caption: 'a caption' })
    expect(mockChannelBus.outbox[1]).toMatchObject({ filename: 'clip.mp4' })
    expect(mockChannelBus.outbox[2]).toMatchObject({ filename: 'model.glb' })
  })

  it('captures keyboards and returns an editable ref', async () => {
    const res = await mock.keyboard('pick one', [[{ text: 'A', callbackData: 'a' }]])
    expect(mockChannelBus.outbox[0]).toMatchObject({ kind: 'keyboard', text: 'pick one' })
    expect(mockChannelBus.outbox[0].buttons?.[0]?.[0]?.callbackData).toBe('a')
    expect(res.success).toBe(true)
    expect(res.ref).toBeDefined()
  })

  it('edits a keyboard message in place', async () => {
    const res = await mock.keyboard('Apply settings?', [
      [
        { text: '✅ Confirm', callbackData: 'confirm:yes' },
        { text: '✖ Cancel', callbackData: 'confirm:no' },
      ],
    ])
    await mock.editKeyboardMessage(res.ref!, '✅ Confirmed.')
    expect(mockChannelBus.outbox.map((e) => e.kind)).toEqual(['keyboard', 'keyboardEdit'])
    expect(mockChannelBus.outbox[1]).toMatchObject({ kind: 'keyboardEdit', text: '✅ Confirmed.' })
  })

  it('records typing start/stop', () => {
    const stop = mock.startTypingHeartbeat('typing')
    stop()
    stop() // idempotent
    expect(mockChannelBus.outbox.map((e) => e.kind)).toEqual(['typingStart', 'typingStop'])
  })

  it('records draft update + finalize', async () => {
    const draft = mock.createDraftStream()
    draft.update('partial…')
    await draft.finalize('final text')
    expect(mockChannelBus.outbox.map((e) => e.kind)).toEqual(['draftUpdate', 'draftFinal'])
    expect(mockChannelBus.outbox[1].text).toBe('final text')
  })

  it('renders final message parts as plain text and strips aipg-media refs', () => {
    const parts: RawPart[] = [
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'Here it is: aipg-media://AIPG_Image_1.png' },
    ]
    const final = mock.formatFinal(parts)
    expect(final).toContain('[reasoning] thinking')
    expect(final).not.toContain('aipg-media://')
  })

  it('flattens hand-authored HTML snippets to plain text', () => {
    expect(mock.formatRichSnippet('<b>Bold</b><br>line')).toBe('Bold\nline')
  })

  it('drains the inbound queue', () => {
    mockChannelBus.pushInbound({ text: 'one' })
    mockChannelBus.pushInbound({ callback: 'imgGen:cancel' })
    const drained = mockChannelBus.drainInbound()
    expect(drained).toHaveLength(2)
    expect(mockChannelBus.drainInbound()).toHaveLength(0)
  })
})
