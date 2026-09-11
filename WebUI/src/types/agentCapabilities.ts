export const DEFAULT_CAPABILITY_IDS = ['media', 'web-debug'] as const

export const MCP_CAPABILITY_PREFIX = 'mcp:'

export const GAME_STUDIO_ID = 'game-studio'
export const GAME_STUDIO_QUICK_ID = 'game-studio-quick'

/**
 * Renderer-side name of the tool Quick Coder offers the switch to Game Agent
 * with. The offer is a card in the transcript and the switch is Pinia state, so
 * the Pi tool in main only dispatches under this name and the Agent Mode store
 * answers it (`storeTools` in agentModeTurn.ts).
 */
export const OFFER_GAME_AGENT_TOOL = 'offerGameAgent'

export function mcpCapabilityId(serverId: string): string {
  return `${MCP_CAPABILITY_PREFIX}${serverId}`
}

export function mcpServerIdOf(capabilityId: string): string | undefined {
  return capabilityId.startsWith(MCP_CAPABILITY_PREFIX)
    ? capabilityId.slice(MCP_CAPABILITY_PREFIX.length)
    : undefined
}

/**
 * The capabilities a turn asks for. Older persisted sessions (and any caller
 * that has not been updated) carry no list, so they fall back to the defaults
 * plus whatever MCP servers they had attached.
 */
export function enabledCapabilityIds(config: {
  capabilities?: string[]
  mcpServerIds?: string[]
}): string[] {
  const ids = config.capabilities ?? [
    ...DEFAULT_CAPABILITY_IDS,
    ...(config.mcpServerIds ?? []).map((serverId) => mcpCapabilityId(serverId)),
  ]
  return [...new Set(ids)].sort()
}
