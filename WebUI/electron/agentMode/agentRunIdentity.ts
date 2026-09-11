import { readGame } from '../gameLibrary.ts'
import {
  enabledCapabilityIds,
  GAME_STUDIO_ID,
  GAME_STUDIO_QUICK_ID,
} from '@/types/agentCapabilities'
import type { AgentRunIdentity } from '../laminarAttributes.ts'
import type { AgentModeTurnConfig } from '@/types/agentIpc'

// ── Which run a trace belongs to ─────────────────────────────────────────────
//
// Every agent run reaches Laminar as a row called `pi agent run`, so thirty of
// them say nothing apart from the machine and the backend. What tells them apart
// is what the user picked (the preset), what the harness gave it (capabilities,
// and the kind of run they add up to) and what it built (the game). None of that
// is derivable from a span, so it is collected here per turn.

/** `quick-coder` and `game-agent` are shapes of run, not preset names — a rebranded preset keeps its type. */
function runType(capabilityIds: string[]): AgentRunIdentity['type'] {
  if (capabilityIds.includes(GAME_STUDIO_QUICK_ID)) return 'quick-coder'
  if (capabilityIds.includes(GAME_STUDIO_ID)) return 'game-agent'
  return 'agent'
}

/**
 * A description of this turn's run, read fresh on every call: the agent names
 * its game mid-run with the `game` tool, and Laminar merges a trace's metadata
 * last-write-wins, so a trace settles on the name as of the turn that produced
 * it while the folder id never moves.
 */
export function agentRunIdentity(config: AgentModeTurnConfig): () => AgentRunIdentity {
  const capabilityIds = enabledCapabilityIds(config)
  const base = {
    preset: config.presetName,
    type: runType(capabilityIds),
    capabilities: capabilityIds.join(', '),
    appSession: config.sessionId,
  }
  return () => {
    const game = readGame(config.workspaceDir)
    return { ...base, game: game?.name, gameId: game?.id }
  }
}
