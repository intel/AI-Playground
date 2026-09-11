import type { UIMessage } from 'ai'
import { computed, type Ref } from 'vue'
import { currentPresetName } from '@/lib/presetRenames'
import { MCP_CAPABILITY_PREFIX } from '@/types/agentCapabilities'

export type AgentSessionRecord = {
  id: string
  workspaceDir: string
  /** Derived from the first user message (see deriveSessionTitle). */
  title: string
  messages: UIMessage[]
  createdAt: number
  updatedAt: number
  /**
   * Capability ids the session runs with. Frozen when the session starts, so
   * changing the defaults never re-equips an ongoing conversation behind the
   * user's back (it would also restart its Pi session).
   */
  capabilities?: string[]
  /**
   * The agent preset the conversation was held with (Agent, Game Agent). A
   * session only makes sense under it — the instructions, capabilities and
   * surrounding UI all come from the preset — so resuming one switches back to
   * it, and the Sessions panel only lists the active preset's own sessions.
   * Absent on sessions archived before presets drove Agent Mode.
   */
  presetName?: string
}

/**
 * The two agent presets sessions can predate `presetName` (see
 * `migrateSessionPresets`). Named rather than looked up, because the migration
 * runs on hydration, before the preset catalog is loaded.
 */
export const GAME_AGENT_PRESET = 'Game Agent'
export const QUICK_CODER_PRESET = 'Quick Coder'
export const AGENT_PRESET = 'Agent'

function isGamesPreset(name: string): boolean {
  const current = currentPresetName(name)
  return current === GAME_AGENT_PRESET || current === QUICK_CODER_PRESET
}

export function mintSessionId(): string {
  return `aipg-agent-${crypto.randomUUID()}`
}

export function deriveSessionTitle(sessionMessages: UIMessage[]): string {
  const firstUser = sessionMessages.find((m) => m.role === 'user')
  const text =
    firstUser?.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join(' ')
      .trim() ?? ''
  if (!text) return 'New session'
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

/** The game library's folder, which every game folder sits directly under. */
const GAMES_SEGMENT = 'games'

/**
 * A game's workspace path is its library folder plus a slug, and the library
 * part is the same for every row — so it collapses into the path icon, leaving
 * the slug. Anything else (the folder-picking Agent) is shown whole.
 */
export function collapseGamesPrefix(workspaceDir: string): { collapsed: boolean; rest: string } {
  const segments = workspaceDir.split(/[\\/]/)
  const index = segments.lastIndexOf(GAMES_SEGMENT)
  if (index < 0 || index === segments.length - 1) return { collapsed: false, rest: workspaceDir }
  return { collapsed: true, rest: segments.slice(index + 1).join('/') }
}

/**
 * What a session card reads: the preset it was held with, then the game it
 * produced. The name is read live from the library rather than the record, so a
 * game renamed with `set_metadata` shows up without re-archiving the session.
 */
export function sessionDisplayTitle(options: {
  title: string
  presetLabel?: string
  gameName?: string
}): { mode: string; name: string } {
  return {
    mode: options.presetLabel?.trim() || AGENT_PRESET,
    name: options.gameName?.trim() || options.title,
  }
}

/**
 * Whether a session shows up in the list an agent preset owns. Game Agent and
 * Quick Coder share the games library, so their sessions sit in one list;
 * resuming one still switches back to the preset it was held with.
 */
export function sessionListedUnderPreset(
  sessionPresetName: string | undefined,
  agentPresetName: string,
): boolean {
  if (!sessionPresetName) return true
  if (sessionPresetName === agentPresetName) return true
  return isGamesPreset(agentPresetName) && isGamesPreset(sessionPresetName)
}

export function listPresetSessions(
  sessions: Record<string, AgentSessionRecord>,
  agentPresetName: string,
): AgentSessionRecord[] {
  return Object.values(sessions).filter((session) =>
    sessionListedUnderPreset(session.presetName, agentPresetName),
  )
}

export function migrateMcpServerIdsIntoCapabilities(
  mcpServerIds: string[],
  defaultCapabilities: string[],
): { mcpServerIds: string[]; defaultCapabilities: string[] } {
  if (mcpServerIds.length === 0) {
    return { mcpServerIds, defaultCapabilities }
  }
  const migrated = mcpServerIds.map((serverId) => `${MCP_CAPABILITY_PREFIX}${serverId}`)
  return {
    mcpServerIds: [],
    defaultCapabilities: [...new Set([...defaultCapabilities, ...migrated])],
  }
}

/**
 * Name every session the preset it was really held with. Sessions archived
 * before presets drove Agent Mode name none; the workspace folder says which
 * they were: a folder in the game library was the game preset's, anything else
 * was the folder-picking Agent.
 */
export function applySessionPresetNames(
  sessions: Record<string, AgentSessionRecord>,
  gameFolders: Set<string>,
): Record<string, AgentSessionRecord> {
  const renamed = Object.values(sessions).filter(
    (session) => session.presetName && currentPresetName(session.presetName) !== session.presetName,
  )
  const legacy = Object.values(sessions).filter((session) => !session.presetName)
  if (legacy.length === 0 && renamed.length === 0) return sessions
  const next = { ...sessions }
  for (const session of renamed) {
    next[session.id] = {
      ...session,
      presetName: currentPresetName(session.presetName!),
    }
  }
  for (const session of legacy) {
    next[session.id] = {
      ...session,
      presetName: gameFolders.has(session.workspaceDir) ? GAME_AGENT_PRESET : AGENT_PRESET,
    }
  }
  return next
}

export function snapshotSession(options: {
  id: string
  workspaceDir: string
  messages: UIMessage[]
  existing?: AgentSessionRecord
  capabilities: string[]
  presetName: string
}): AgentSessionRecord | null {
  const plainMessages = JSON.parse(JSON.stringify(options.messages)) as UIMessage[]
  if (plainMessages.length === 0) return null
  // `stop()` archives the session you are leaving so a switch can tear down Pi.
  // That is not new work — keep the clock unless the transcript actually moved.
  const existing = options.existing
  const unchanged =
    existing !== undefined && JSON.stringify(existing.messages) === JSON.stringify(plainMessages)
  return {
    id: options.id,
    workspaceDir: existing?.workspaceDir ?? options.workspaceDir,
    title: deriveSessionTitle(plainMessages),
    messages: plainMessages,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: unchanged && existing ? existing.updatedAt : Date.now(),
    capabilities: options.existing?.capabilities ?? [...options.capabilities],
    presetName: options.existing?.presetName ?? options.presetName,
  }
}

/**
 * The first message of the session Game Agent takes a one-shot game over in. It
 * starts empty on purpose — a Quick Coder transcript is a plan and one `write`,
 * under instructions ("there is no browser", "you cannot read the file back")
 * that are wrong for the agent now holding the folder — so this is the only
 * context it gets: what was built, what the user asked for next, and the one
 * thing about the folder it would otherwise assume wrongly.
 */
export function gameAgentHandoffPrompt(options: {
  summary: string
  request: string
  gameName?: string
  gameDescription?: string
}): string {
  const card = [options.gameName?.trim(), options.gameDescription?.trim()]
    .filter(Boolean)
    .join(' — ')
  const built = options.summary.trim() || card || 'A browser game, written in one step.'
  const request = options.request.trim()
  return [
    'Taking over a game another agent wrote in one step. You did not see that conversation.',
    '',
    `What it built: ${built}`,
    '',
    request ? `What the user asks for now: ${request}` : 'The user will say what to change next.',
    '',
    'The whole game is `index.html` in this folder — one file, no `game.js` scaffold and no ' +
      'plan on disk. Read it before changing anything.',
  ].join('\n')
}

/**
 * Lift Agent Mode's planning-thinking switch out of chat `settingsPerPreset`.
 * Returns the value to keep (preferring `preferredKey`) and bags with the key
 * stripped so later hydrations do not overwrite the Agent Mode persist copy.
 */
export function takeLegacyPlanningThinkingOnly(
  bags: Record<string, Record<string, unknown>>,
  preferredKey: string,
): { value?: boolean; bags: Record<string, Record<string, unknown>> } {
  let value: boolean | undefined
  const preferred = bags[preferredKey]?.planningThinkingOnly
  if (typeof preferred === 'boolean') value = preferred
  else {
    for (const bag of Object.values(bags)) {
      if (typeof bag?.planningThinkingOnly === 'boolean') {
        value = bag.planningThinkingOnly
        break
      }
    }
  }
  let stripped = false
  const next: Record<string, Record<string, unknown>> = {}
  for (const [key, bag] of Object.entries(bags)) {
    if (bag && 'planningThinkingOnly' in bag) {
      const { planningThinkingOnly: _removed, ...rest } = bag
      next[key] = rest
      stripped = true
    } else {
      next[key] = bag
    }
  }
  return { value, bags: stripped ? next : bags }
}

export function toggleCapabilityIds(current: string[], id: string, enabled: boolean): string[] {
  return enabled ? [...new Set([...current, id])] : current.filter((entry) => entry !== id)
}

export function ensureSessionId(activeSessionId: Ref<string>): string {
  if (!activeSessionId.value) activeSessionId.value = mintSessionId()
  return activeSessionId.value
}

export function computedPresetSessions(
  sessions: Ref<Record<string, AgentSessionRecord>>,
  agentPresetName: Ref<string>,
) {
  return computed(() => listPresetSessions(sessions.value, agentPresetName.value))
}
