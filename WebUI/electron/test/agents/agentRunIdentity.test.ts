import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// What a trace says an agent run was. The capability list decides the run's
// type, and the game's title is read per call because the agent names its game
// while the run is under way.

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-run-identity-'))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => agentDir, getAppPath: () => agentDir },
  BrowserWindow: class {},
  net: {},
}))

const { agentRunIdentity } = await import('../../agentMode/agentRunIdentity.ts')

function workspace(name: string): string {
  const dir = fs.mkdtempSync(path.join(agentDir, `${name}-`))
  return dir
}

function writeCard(dir: string, id: string, name: string): void {
  fs.writeFileSync(path.join(dir, 'game.json'), JSON.stringify({ id, name }), 'utf-8')
}

function config(overrides: Partial<AgentModeTurnConfig> = {}): AgentModeTurnConfig {
  return {
    sessionId: 'aipg-agent-1',
    workspaceDir: workspace('ws'),
    modelConfig: { source: 'local', model: 'm', baseUrl: 'http://127.0.0.1:1/v1' },
    ...overrides,
  }
}

describe('agentRunIdentity', () => {
  it('reads the run off its capabilities and preset', () => {
    const identity = agentRunIdentity(
      config({ presetName: 'Game Agent', capabilities: ['media', 'game-studio', 'web-debug'] }),
    )()
    expect(identity.preset).toBe('Game Agent')
    expect(identity.type).toBe('game-agent')
    expect(identity.capabilities).toBe('game-studio, media, web-debug')
    expect(identity.appSession).toBe('aipg-agent-1')
  })

  it('calls a one-step build a quick coder, even beside the iterative capability', () => {
    const quick = agentRunIdentity(config({ capabilities: ['game-studio-quick'] }))()
    expect(quick.type).toBe('quick-coder')
    const both = agentRunIdentity(config({ capabilities: ['game-studio', 'game-studio-quick'] }))()
    expect(both.type).toBe('quick-coder')
  })

  it('is a plain agent without a game capability, and falls back to the default list', () => {
    const identity = agentRunIdentity(config({ presetName: 'Agent' }))()
    expect(identity.type).toBe('agent')
    expect(identity.capabilities).toBe('media, web-debug')
  })

  it('has no game for a workspace that is not one', () => {
    const identity = agentRunIdentity(config())()
    expect(identity.game).toBeUndefined()
    expect(identity.gameId).toBeUndefined()
  })

  it('re-reads the title the agent gives its game, keeping the folder id', () => {
    const workspaceDir = workspace('game')
    writeCard(workspaceDir, 'new-game', 'New game')
    const identity = agentRunIdentity(config({ workspaceDir }))
    expect(identity().game).toBe('New game')
    writeCard(workspaceDir, 'new-game', 'Asteroid Rush')
    expect(identity().game).toBe('Asteroid Rush')
    expect(identity().gameId).toBe('new-game')
  })
})
