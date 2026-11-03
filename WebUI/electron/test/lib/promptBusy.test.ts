import { describe, expect, it } from 'vitest'
import { promptBusy, promptOnBusyChange } from '@/lib/promptBusy'

const idle = { agentSession: false, conversation: false, panelRun: false, audioTurn: false }

describe('prompt bar busy state', () => {
  it('follows only the target of the current mode', () => {
    const agentRunning = { ...idle, agentSession: true }
    expect(promptBusy('chat', agentRunning)).toBe(false)
    expect(promptBusy('audio', agentRunning)).toBe(false)
    expect(promptBusy('imageGen', agentRunning)).toBe(false)
    expect(promptBusy('agent', agentRunning)).toBe(true)

    const conversationBusy = { ...idle, conversation: true }
    expect(promptBusy('chat', conversationBusy)).toBe(true)
    expect(promptBusy('audio', conversationBusy)).toBe(false)
    expect(promptBusy('agent', conversationBusy)).toBe(false)
    expect(promptBusy('video', conversationBusy)).toBe(false)

    const panelBusy = { ...idle, panelRun: true }
    expect(promptBusy('imageGen', panelBusy)).toBe(true)
    expect(promptBusy('imageEdit', panelBusy)).toBe(true)
    expect(promptBusy('video', panelBusy)).toBe(true)
    expect(promptBusy('chat', panelBusy)).toBe(false)

    const audioBusy = { ...idle, audioTurn: true }
    expect(promptBusy('audio', audioBusy)).toBe(true)
    expect(promptBusy('chat', audioBusy)).toBe(false)
  })
})

describe('prompt field on a busy change', () => {
  it('clears in Chat as soon as a send is accepted', () => {
    expect(promptOnBusyChange('chat', { busy: true, wasBusy: false, submitted: true })).toEqual({
      clearPrompt: true,
      resetSubmitted: true,
    })
  })

  it('keeps what was typed when Chat becomes idle or busy without a send', () => {
    expect(
      promptOnBusyChange('chat', { busy: false, wasBusy: true, submitted: false }).clearPrompt,
    ).toBe(false)
    expect(
      promptOnBusyChange('chat', { busy: true, wasBusy: false, submitted: false }).clearPrompt,
    ).toBe(false)
  })

  it('keeps the prompt after an image run, only ending the submitted state', () => {
    expect(promptOnBusyChange('imageGen', { busy: true, wasBusy: false, submitted: true })).toEqual(
      { clearPrompt: false, resetSubmitted: false },
    )
    expect(promptOnBusyChange('imageGen', { busy: false, wasBusy: true, submitted: true })).toEqual(
      { clearPrompt: false, resetSubmitted: true },
    )
  })
})
