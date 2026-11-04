import { usesSessionSettings } from '@/lib/agentSessionSettings'

export type SessionTabId = 'viewport' | 'inferencing' | 'attributes' | 'artifacts' | 'schedules'

export type SessionTabsOwner = 'session' | 'home-agent-thread'

export type SessionTabsPresetKind =
  | 'chat'
  | 'audio'
  | 'image'
  | 'edit'
  | 'video'
  | 'agent-maker'
  | 'agent-preset'
  | 'saved-agent-preset'

export type SchedulesAllowance = 'full' | 'run-only' | 'one-agent'

export type SessionTabLanding = 'open-session' | 'open-from-artifacts' | 'keep'

export type ArtifactsScope = 'this-session' | 'all-sessions'

export type SessionTabsInput = {
  owner: SessionTabsOwner
  presetKind: SessionTabsPresetKind
  hasAgents: boolean
  landing: SessionTabLanding
  current: SessionTabId
}

export type SessionTabsView = {
  tabs: SessionTabId[]
  schedules: SchedulesAllowance | null
  shown: SessionTabId
  /** Set only when the landing decides the Artifacts scope; otherwise the tab keeps its own. */
  artifactsScope: ArtifactsScope | null
}

function schedulesAllowance(input: SessionTabsInput): SchedulesAllowance | null {
  if (input.owner !== 'session') return null
  if (input.presetKind === 'agent-maker') return 'full'
  if (input.presetKind === 'saved-agent-preset') return 'one-agent'
  return input.hasAgents ? 'run-only' : null
}

export function sessionTabs(input: SessionTabsInput): SessionTabsView {
  const schedules = schedulesAllowance(input)
  const tabs: SessionTabId[] =
    input.owner === 'session'
      ? ['viewport', 'inferencing', 'attributes', 'artifacts']
      : ['viewport', 'inferencing', 'attributes']
  if (schedules) tabs.push('schedules')
  const wanted: SessionTabId =
    input.landing === 'open-session'
      ? 'viewport'
      : input.landing === 'open-from-artifacts'
        ? 'artifacts'
        : input.current
  const shown = tabs.includes(wanted) ? wanted : 'viewport'
  return {
    tabs,
    schedules,
    shown,
    artifactsScope:
      shown === 'artifacts' && input.landing === 'open-from-artifacts' ? 'this-session' : null,
  }
}

const MODE_KINDS: Record<Exclude<ModeType, 'agent'>, SessionTabsPresetKind> = {
  chat: 'chat',
  audio: 'audio',
  imageGen: 'image',
  imageEdit: 'edit',
  video: 'video',
}

export function sessionTabsPresetKind(
  mode: ModeType,
  agentPreset: { name: string; agentPreset?: boolean; agentTaskId?: string } | null,
): SessionTabsPresetKind {
  if (mode !== 'agent') return MODE_KINDS[mode]
  if (!usesSessionSettings(agentPreset)) return 'agent-preset'
  return agentPreset?.agentTaskId !== undefined ? 'saved-agent-preset' : 'agent-maker'
}
