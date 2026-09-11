import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The `game` tool is how the agent fills in the library card (title, description,
// cover) for the game it is building. It writes through gameLibrary against the
// real filesystem here — that round trip is the point — with Electron and Pi
// mocked away.

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-game-tool-'))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => agentDir, getAppPath: () => agentDir },
  BrowserWindow: class {},
  net: {},
}))

vi.mock('../../logging/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../agentMode/piRuntime.ts', () => ({
  loadPi: async () => ({ defineTool: (definition: unknown) => definition }),
}))

const { gameStudioCapability } = await import('../../agentMode/capabilities/gameStudio.ts')
const { createGame, readGame } = await import('../../gameLibrary.ts')

type GameTool = {
  name: string
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>
}

async function gameToolFor(workspaceDir: string): Promise<GameTool> {
  const tools = await gameStudioCapability.buildTools!({
    sessionId: 'session-1',
    workspaceDir,
    agentDir,
    toolSpecs: [],
  } as unknown as Parameters<NonNullable<typeof gameStudioCapability.buildTools>>[0])
  return tools[0] as unknown as GameTool
}

function textOf(result: unknown): string {
  return ((result as { content: { text: string }[] }).content ?? [])
    .map((part) => part.text)
    .join('\n')
}

let root: string
let workspaceDir: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-games-'))
  workspaceDir = createGame({ name: 'a game about dodging' }, root).dir
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('game tool', () => {
  it('is offered as one small tool alongside the skill', async () => {
    const tool = await gameToolFor(workspaceDir)
    expect(tool.name).toBe('game')
    expect(gameStudioCapability.skills?.map((skill) => skill.name)).toEqual(['html-game-studio'])
    // Deferring it would cost a round trip right at the end of the task.
    expect(gameStudioCapability.lazyEligible).toBe(false)
  })

  it('names and describes the game', async () => {
    const tool = await gameToolFor(workspaceDir)
    const result = await tool.execute('call-1', {
      action: 'set_metadata',
      name: 'Space Dodger',
      description: 'Dodge asteroids for as long as you can.',
    })
    expect(textOf(result)).toContain('Space Dodger')
    expect(readGame(workspaceDir)).toMatchObject({
      name: 'Space Dodger',
      description: 'Dodge asteroids for as long as you can.',
    })
  })

  it('sets the description without clearing the name', async () => {
    const tool = await gameToolFor(workspaceDir)
    await tool.execute('call-1', { action: 'set_metadata', name: 'Space Dodger' })
    await tool.execute('call-2', { action: 'set_metadata', description: 'Dodge asteroids.' })
    expect(readGame(workspaceDir)).toMatchObject({
      name: 'Space Dodger',
      description: 'Dodge asteroids.',
    })
  })

  it('asks for something to write when told nothing', async () => {
    const tool = await gameToolFor(workspaceDir)
    const result = await tool.execute('call-1', { action: 'set_metadata' })
    expect(textOf(result)).toMatch(/Provide a name/)
  })

  it('adopts generated art as the cover', async () => {
    fs.mkdirSync(path.join(workspaceDir, 'generated'))
    fs.writeFileSync(path.join(workspaceDir, 'generated', 'AIPG_00002_.png'), 'png')
    const tool = await gameToolFor(workspaceDir)
    const result = await tool.execute('call-1', {
      action: 'set_icon',
      path: 'generated/AIPG_00002_.png',
    })
    expect(textOf(result)).toContain('icon.png')
    expect(readGame(workspaceDir)?.icon).toBe('icon.png')
  })

  it('tells the model what went wrong instead of throwing', async () => {
    const tool = await gameToolFor(workspaceDir)
    expect(textOf(await tool.execute('call-1', { action: 'set_icon' }))).toMatch(/Provide the path/)
    expect(
      textOf(await tool.execute('call-2', { action: 'set_icon', path: 'generated/missing.png' })),
    ).toMatch(/does not exist/)
    expect(
      textOf(await tool.execute('call-3', { action: 'set_icon', path: '../escape.png' })),
    ).toMatch(/inside the game folder/)
  })

  it('reads the card back, including whether the user saved it', async () => {
    const tool = await gameToolFor(workspaceDir)
    await tool.execute('call-1', { action: 'set_metadata', name: 'Space Dodger' })
    const result = textOf(await tool.execute('call-2', { action: 'get' }))
    expect(result).toContain('name: Space Dodger')
    expect(result).toContain('saved to library: not yet')
  })

  it('explains itself in a workspace that is not a game', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-plain-'))
    try {
      const tool = await gameToolFor(plain)
      const result = await tool.execute('call-1', { action: 'set_metadata', name: 'Nope' })
      expect(textOf(result)).toMatch(/not a game folder/i)
    } finally {
      fs.rmSync(plain, { recursive: true, force: true })
    }
  })
})
