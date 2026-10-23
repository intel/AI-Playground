import { describe, expect, it, vi } from 'vitest'
import { bindRendererBusyReset, resolveClosePolicy } from '../../kernel/windowLifecycle'

// The hidden-window close policy (architecture-target §5.1). Closing the app
// window hides it while headless work a quit would orphan; otherwise it is a
// real close. Every combination that matters:

const idle = {
  homeAgentRunning: false,
  rendererBusy: false,
  agentTurnActive: false,
  chatTurnActive: false,
  artifactWorkOpen: false,
}

describe('resolveClosePolicy', () => {
  it('closes when nothing is in flight', () => {
    expect(resolveClosePolicy(idle)).toBe('close')
  })

  it('hides while the Home Agent serves its channels', () => {
    expect(resolveClosePolicy({ ...idle, homeAgentRunning: true })).toBe('hide')
  })

  it('hides while the renderer reports tracked work', () => {
    expect(resolveClosePolicy({ ...idle, rendererBusy: true })).toBe('hide')
  })

  it('hides while an agent turn runs in main', () => {
    expect(resolveClosePolicy({ ...idle, agentTurnActive: true })).toBe('hide')
  })

  it('hides while a chat turn runs in main', () => {
    expect(resolveClosePolicy({ ...idle, chatTurnActive: true })).toBe('hide')
  })

  it('hides while artifact work is admitted, executing, or queued', () => {
    expect(resolveClosePolicy({ ...idle, artifactWorkOpen: true })).toBe('hide')
  })

  it('hides when several are in flight at once', () => {
    expect(
      resolveClosePolicy({
        homeAgentRunning: true,
        rendererBusy: true,
        agentTurnActive: true,
        chatTurnActive: true,
        artifactWorkOpen: true,
      }),
    ).toBe('hide')
  })
})

describe('bindRendererBusyReset', () => {
  it('clears busy when the webContents is destroyed', () => {
    const listeners = new Map<string, () => void>()
    const webContents = {
      once: (event: 'destroyed', listener: () => void) => {
        listeners.set(event, listener)
      },
    }
    const setBusy = vi.fn()
    bindRendererBusyReset(webContents, setBusy)
    listeners.get('destroyed')?.()
    expect(setBusy).toHaveBeenCalledWith(false)
  })
})
