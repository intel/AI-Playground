import { describe, expect, it } from 'vitest'
import {
  schedulesPanel,
  sessionTabs,
  sessionTabsPresetKind,
  settingsInTabs,
  type SessionTabsInput,
} from '@/lib/sessionTabs'

const chatSession: SessionTabsInput = {
  owner: 'session',
  presetKind: 'chat',
  hasAgents: false,
  landing: 'keep',
  current: 'viewport',
}

describe('sessionTabs', () => {
  it('shows Viewport, Inferencing, Attributes and Artifacts for a plain Session', () => {
    expect(sessionTabs(chatSession).tabs).toEqual([
      'viewport',
      'inferencing',
      'attributes',
      'artifacts',
    ])
  })

  it('shows the same tabs for every preset kind that is not an Agent Preset', () => {
    for (const presetKind of ['chat', 'audio', 'image', 'edit', 'video', 'agent-preset'] as const) {
      const view = sessionTabs({ ...chatSession, presetKind })
      expect(view.tabs).toEqual(['viewport', 'inferencing', 'attributes', 'artifacts'])
      expect(view.schedules).toBeNull()
    }
  })

  it('adds Schedules with full editing under Agent Maker', () => {
    const view = sessionTabs({ ...chatSession, presetKind: 'agent-maker' })
    expect(view.tabs).toEqual(['viewport', 'inferencing', 'attributes', 'artifacts', 'schedules'])
    expect(view.schedules).toBe('full')
  })

  it('keeps Schedules, run-only, under any other preset when the Session has Agents', () => {
    for (const presetKind of ['chat', 'audio', 'image', 'edit', 'video', 'agent-preset'] as const) {
      const view = sessionTabs({ ...chatSession, presetKind, hasAgents: true })
      expect(view.tabs.at(-1)).toBe('schedules')
      expect(view.schedules).toBe('run-only')
    }
  })

  it('keeps full editing under Agent Maker when the Session has Agents', () => {
    expect(
      sessionTabs({ ...chatSession, presetKind: 'agent-maker', hasAgents: true }).schedules,
    ).toBe('full')
  })

  it('limits Schedules to one Agent under a saved Agent Preset', () => {
    for (const hasAgents of [false, true]) {
      const view = sessionTabs({ ...chatSession, presetKind: 'saved-agent-preset', hasAgents })
      expect(view.tabs.at(-1)).toBe('schedules')
      expect(view.schedules).toBe('one-agent')
    }
  })

  it('gives a Home Agent thread Viewport, Inferencing and Attributes only', () => {
    for (const presetKind of ['chat', 'agent-maker'] as const) {
      const view = sessionTabs({
        ...chatSession,
        owner: 'home-agent-thread',
        presetKind,
        hasAgents: true,
      })
      expect(view.tabs).toEqual(['viewport', 'inferencing', 'attributes'])
      expect(view.schedules).toBeNull()
    }
  })

  it('lands on the Viewport when a Session is opened or started, whatever tab was shown', () => {
    const view = sessionTabs({ ...chatSession, landing: 'open-session', current: 'attributes' })
    expect(view.shown).toBe('viewport')
    expect(view.artifactsScope).toBeNull()
  })

  it('lands on Artifacts showing This Session when opened from an Artifact', () => {
    const view = sessionTabs({
      ...chatSession,
      landing: 'open-from-artifacts',
      current: 'inferencing',
    })
    expect(view.shown).toBe('artifacts')
    expect(view.artifactsScope).toBe('this-session')
  })

  it('falls back to the Viewport when an Artifact opens a Home Agent thread', () => {
    const view = sessionTabs({
      ...chatSession,
      owner: 'home-agent-thread',
      landing: 'open-from-artifacts',
    })
    expect(view.shown).toBe('viewport')
    expect(view.artifactsScope).toBeNull()
  })

  it('keeps the current tab otherwise', () => {
    for (const current of ['viewport', 'inferencing', 'attributes', 'artifacts'] as const) {
      const view = sessionTabs({ ...chatSession, current })
      expect(view.shown).toBe(current)
      expect(view.artifactsScope).toBeNull()
    }
  })

  it('falls back to the Viewport when the current tab is no longer visible', () => {
    expect(sessionTabs({ ...chatSession, current: 'schedules' }).shown).toBe('viewport')
    expect(
      sessionTabs({ ...chatSession, owner: 'home-agent-thread', current: 'artifacts' }).shown,
    ).toBe('viewport')
  })

  it('keeps Schedules shown while it stays visible after a preset switch', () => {
    expect(sessionTabs({ ...chatSession, hasAgents: true, current: 'schedules' }).shown).toBe(
      'schedules',
    )
  })
})

describe('sessionTabsPresetKind', () => {
  it('names the kind of each mode', () => {
    expect(sessionTabsPresetKind('chat', null)).toBe('chat')
    expect(sessionTabsPresetKind('audio', null)).toBe('audio')
    expect(sessionTabsPresetKind('imageGen', null)).toBe('image')
    expect(sessionTabsPresetKind('imageEdit', null)).toBe('edit')
    expect(sessionTabsPresetKind('video', null)).toBe('video')
  })

  it('tells Agent Maker, its saved Agent Presets and the other Agent Presets apart', () => {
    expect(sessionTabsPresetKind('agent', { name: 'Agent', agentPreset: true })).toBe('agent-maker')
    expect(
      sessionTabsPresetKind('agent', { name: 'Logo maker', agentPreset: true, agentTaskId: 't1' }),
    ).toBe('saved-agent-preset')
    expect(sessionTabsPresetKind('agent', { name: 'Game Agent', agentPreset: true })).toBe(
      'agent-preset',
    )
  })
})

describe('schedulesPanel', () => {
  it('offers the save bar, Steps and the whole Agent list under Agent Maker', () => {
    expect(schedulesPanel('full')).toEqual({
      editSteps: true,
      editNote: false,
      agentList: { load: true, saveAsPreset: true },
    })
  })

  it('replaces the save bar and Steps with the note under another preset', () => {
    expect(schedulesPanel('run-only')).toEqual({
      editSteps: false,
      editNote: true,
      agentList: { load: false, saveAsPreset: false },
    })
  })

  it('keeps only the bound save bar and Steps under a saved Agent Preset', () => {
    expect(schedulesPanel('one-agent')).toEqual({
      editSteps: true,
      editNote: false,
      agentList: null,
    })
  })
})

describe('settingsInTabs', () => {
  it('puts Chat settings in the Inferencing and Attributes tabs', () => {
    expect(settingsInTabs('chat')).toBe(true)
  })

  it('puts Image Gen, Image Edit and Video settings in the tabs', () => {
    for (const mode of ['imageGen', 'imageEdit', 'video'] as const) {
      expect(settingsInTabs(mode)).toBe(true)
    }
  })

  it('keeps the modes not yet moved in the settings sidebar', () => {
    for (const mode of ['audio', 'agent'] as const) {
      expect(settingsInTabs(mode)).toBe(false)
    }
  })
})
