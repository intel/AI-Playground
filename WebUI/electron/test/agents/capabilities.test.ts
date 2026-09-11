import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Capability resolution: which capabilities a session gets, what they contribute,
// and when their tools start dormant. The capability modules reach Electron, the
// renderer bridge and the MCP manager, so those edges are mocked — what is under
// test is the registry's own arithmetic.

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-capabilities-'))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => agentDir, getAppPath: () => agentDir },
  BrowserWindow: class {},
  net: {},
}))

vi.mock('../../logging/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Pi is ESM-only and loaded lazily; `defineTool` is an identity function as far
// as these tests are concerned.
vi.mock('../../agentMode/piRuntime.ts', () => ({
  loadPi: async () => ({ defineTool: (definition: unknown) => definition }),
}))

vi.mock('../../subprocesses/agentBrowser.ts', () => ({ runBrowserAction: vi.fn() }))
vi.mock('../../subprocesses/mcpManager.ts', () => ({
  getMcpServerTools: vi.fn(async () => {
    const { jsonSchema } = await import('ai')
    return {
      search: {
        description: 'search the web',
        inputSchema: jsonSchema({ type: 'object', properties: { q: { type: 'string' } } }),
        execute: vi.fn(async () => 'ok'),
      },
    }
  }),
}))

const {
  DEFAULT_CAPABILITY_IDS,
  capabilityCatalog,
  listCapabilities,
  resolveCapabilities,
  CAPABILITIES_TOOL_NAME,
} = await import('../../agentMode/capabilities/index.ts')
const { expandCapabilityIds, estimateToolTokens, shouldDeferCapabilityTools } =
  await import('../../agentMode/capabilities/types.ts')
const { createCapabilitiesExtension } = await import('../../agentMode/capabilities/core.ts')
const { testables: memoryTestables } = await import('../../agentMode/capabilities/memory.ts')

type Host = Parameters<typeof resolveCapabilities>[0]

// Shaped like what the renderer actually ships: a single delegating `media` tool
// with a long description. The size matters — the activation policy weighs tool
// schemas against the context window.
const MEDIA_TOOL_SPEC = {
  name: 'media',
  description:
    'Generate or transform images, videos and 3D models. Describe the desired result in one ' +
    'natural-language request: subject, style, aspect ratio and quality level. Multi-step ' +
    'requests belong in a single call. To transform an image already in the workspace, pass ' +
    'its workspace-relative path as sourceImagePath. The result lists the generated files ' +
    'under "generated/". Generation takes minutes; call once and wait for the result.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      request: { type: 'string', description: 'What to create, in natural language.' },
      sourceImagePath: { type: 'string', description: 'Workspace-relative image to transform.' },
    },
    required: ['request'],
  },
  workspacePathInputs: ['sourceImagePath'],
}

function hostWith(overrides: Partial<Host> = {}): Host {
  return {
    sessionId: 'session-1',
    workspaceDir: path.join(agentDir, 'workspace'),
    agentDir,
    toolSpecs: [MEDIA_TOOL_SPEC] as Host['toolSpecs'],
    ...overrides,
  }
}

/** A stand-in ExtensionAPI recording what a capability registered. */
function fakeExtensionApi() {
  const tools: { name: string }[] = []
  let active: string[] = []
  return {
    api: {
      registerTool: (tool: { name: string }) => {
        tools.push(tool)
        active.push(tool.name)
      },
      registerCommand: vi.fn(),
      on: vi.fn(),
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => {
        active = [...names]
      },
    },
    tools,
    activeTools: () => [...active],
  }
}

beforeEach(() => {
  fs.rmSync(path.join(agentDir, 'pi-hermes-memory'), { recursive: true, force: true })
  fs.rmSync(path.join(agentDir, 'projects-memory'), { recursive: true, force: true })
})

afterAll(() => {
  fs.rmSync(agentDir, { recursive: true, force: true })
})

describe('the capability catalog', () => {
  it('offers the built-ins plus one capability per requested MCP server', () => {
    const ids = capabilityCatalog(['mcp:filesystem', 'media', 'mcp:filesystem']).map(({ id }) => id)
    expect(ids).toContain('media')
    expect(ids).toContain('memory')
    expect(ids).toContain('game-studio')
    // Exactly one entry per server, and MCP registers before the built-ins so a
    // server cannot shadow a built-in tool name.
    expect(ids.filter((id) => id === 'mcp:filesystem')).toEqual(['mcp:filesystem'])
    expect(ids.indexOf('mcp:filesystem')).toBeLessThan(ids.indexOf('media'))
  })

  it('defaults to media and web debugging, with memory opt-in', () => {
    expect([...DEFAULT_CAPABILITY_IDS]).toEqual(['media', 'web-debug'])
  })

  it('reports availability and commands for the settings UI', () => {
    const withoutMedia = listCapabilities(hostWith({ toolSpecs: [] }))
    const media = withoutMedia.find((entry) => entry.id === 'media')
    expect(media?.unavailableReason).toMatch(/ComfyUI/)
    const memory = withoutMedia.find((entry) => entry.id === 'memory')
    expect(memory?.commands.map((command) => command.command)).toContain('/memory-insights')
    expect(capabilityCatalog().find((entry) => entry.id === 'game-studio')?.requires).toEqual([
      'media',
      'web-debug',
    ])
  })

  it('keeps session-shaping capabilities out of the settings list', () => {
    const catalogIds = capabilityCatalog().map(({ id }) => id)
    expect(catalogIds).toContain('game-studio')
    expect(catalogIds).toContain('game-studio-quick')
    const listed = listCapabilities(hostWith()).map(({ id }) => id)
    expect(listed).not.toContain('game-studio')
    expect(listed).not.toContain('game-studio-quick')
  })
})

describe('expandCapabilityIds', () => {
  const catalog = [
    { id: 'a', label: 'a', summary: 'a', requires: ['b'] },
    { id: 'b', label: 'b', summary: 'b', requires: ['c'] },
    { id: 'c', label: 'c', summary: 'c' },
    { id: 'd', label: 'd', summary: 'd' },
  ]

  it('pulls in requirements transitively, in catalog order', () => {
    expect(expandCapabilityIds(catalog, ['a'])).toEqual(['a', 'b', 'c'])
  })

  it('drops ids the catalog does not know and never loops', () => {
    const cyclic = [
      { id: 'x', label: 'x', summary: 'x', requires: ['y'] },
      { id: 'y', label: 'y', summary: 'y', requires: ['x'] },
    ]
    expect(expandCapabilityIds(catalog, ['d', 'gone'])).toEqual(['d'])
    expect(expandCapabilityIds(cyclic, ['x'])).toEqual(['x', 'y'])
  })
})

describe('the activation policy', () => {
  it('sizes a tool set from its rendered schema', () => {
    const tokens = estimateToolTokens([
      { name: 'media', description: 'x'.repeat(200), parameters: { type: 'object' } },
    ] as never)
    expect(tokens).toBeGreaterThan(50)
    expect(estimateToolTokens([])).toBe(0)
  })

  it('defers only when the tools would eat a quarter of the context window', () => {
    expect(shouldDeferCapabilityTools({ contextWindow: 128000, capabilityToolTokens: 600 })).toBe(
      false,
    )
    expect(shouldDeferCapabilityTools({ contextWindow: 2048, capabilityToolTokens: 600 })).toBe(
      true,
    )
    // An unknown context window is not a reason to pay for an activation later.
    expect(shouldDeferCapabilityTools({ capabilityToolTokens: 100000 })).toBe(false)
  })
})

describe('resolveCapabilities', () => {
  it('builds tools, skills and one extension factory per capability', async () => {
    const resolution = await resolveCapabilities(hostWith(), ['media', 'web-debug'])

    expect(resolution.resolved.map(({ capability }) => capability.id)).toEqual([
      'web-debug',
      'media',
    ])
    expect(resolution.extensionFactories).toHaveLength(2)
    expect(resolution.skillSources.map((skill) => skill.name)).toEqual([
      'browser-debugging',
      'media-generation',
    ])
    expect(resolution.announcedSkillNames).toEqual(['browser-debugging', 'media-generation'])
    expect(resolution.dormantIds).toEqual([])
    expect(resolution.dormantToolNames).toEqual([])
    expect(resolution.dormantPromptSection).toBe('')

    const registry = fakeExtensionApi()
    for (const factory of resolution.extensionFactories) factory(registry.api as never)
    expect(registry.tools.map((tool) => tool.name)).toEqual(['browser', 'media'])
  })

  it('shows a browser screenshot to the user without inlining it for the model', async () => {
    const host = hostWith()
    const shot = path.join(host.workspaceDir, 'generated', 'shot.png')
    fs.mkdirSync(path.dirname(shot), { recursive: true })
    fs.writeFileSync(shot, Buffer.from('89504e470d0a1a0a', 'hex'))
    const { runBrowserAction } = await import('../../subprocesses/agentBrowser.ts')
    vi.mocked(runBrowserAction).mockResolvedValue({
      text: 'Saved screenshot to generated/shot.png',
      screenshotPath: 'generated/shot.png',
    })
    const send = vi.fn()
    const { setToolBridgeWindow } = await import('../../agentMode/piCustomTools.ts')
    setToolBridgeWindow({ webContents: { send } } as never)

    const resolution = await resolveCapabilities(host, ['web-debug'])
    const registry = fakeExtensionApi()
    for (const factory of resolution.extensionFactories) factory(registry.api as never)
    const browser = registry.tools.find((tool) => tool.name === 'browser') as unknown as {
      execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }>
    }
    const result = await browser.execute('call-1', { action: 'screenshot' })

    expect(send).toHaveBeenCalledWith('agentMode:toolImage', {
      toolCallId: 'call-1',
      dataUri: expect.stringMatching(/^data:image\/png;base64,/),
      label: 'generated/shot.png',
    })
    expect(result.content[0].text).toBe('Saved screenshot to generated/shot.png')
  })

  it('skips a capability that cannot run and says why in the log', async () => {
    const resolution = await resolveCapabilities(hostWith({ toolSpecs: [] }), [
      'media',
      'web-debug',
    ])
    expect(resolution.resolved.map(({ capability }) => capability.id)).toEqual(['web-debug'])
  })

  it('pulls in required capabilities when a skills bundle is enabled', async () => {
    const resolution = await resolveCapabilities(hostWith(), ['game-studio'])
    expect(resolution.resolved.map(({ capability }) => capability.id)).toEqual([
      'web-debug',
      'media',
      'game-studio',
    ])
    expect(resolution.announcedSkillNames).toContain('html-game-studio')
  })

  // The one-shot game preset: the same library card tool, none of the workflow
  // around it, and a session shape the manager reads off the resolution.
  it('reports the session shape a capability that owns the session asks for', async () => {
    const resolution = await resolveCapabilities(hostWith(), ['game-studio-quick'])

    expect(resolution.resolved.map(({ capability }) => capability.id)).toEqual([
      'game-studio-quick',
    ])
    expect(resolution.skillSources).toEqual([])
    // One tool, one file: everything this run produces is `index.html`, and the
    // hand-off to Game Agent is written on the strength of that.
    expect(resolution.ownSession).toEqual({
      baseTools: ['write'],
      writableFiles: ['index.html'],
    })
    expect(resolution.planningEnd).toBe('first-write')
    // The turn is split in two, so the harness has a build request to send.
    expect(resolution.planHandoff).toMatch(/index\.html/)

    const registry = fakeExtensionApi()
    for (const factory of resolution.extensionFactories) factory(registry.api as never)
    // The library card, plus the way out: a one-shot run cannot revise the game
    // it wrote, so it can offer to hand it to Game Agent instead.
    expect(registry.tools.map((tool) => tool.name)).toEqual(['game', 'offer_game_agent'])
    // The session Game Agent takes over in starts empty, so the summary asked
    // for here is the only account of the game it ever gets.
    const offer = registry.tools.find((tool) => tool.name === 'offer_game_agent') as {
      parameters?: { required?: string[] }
    }
    expect(offer.parameters?.required).toEqual(['reason', 'summary'])
  })

  it('leaves the iterative game preset planning on disk, with the full session', async () => {
    const resolution = await resolveCapabilities(hostWith(), ['game-studio'])
    expect(resolution.ownSession).toBeUndefined()
    expect(resolution.planningEnd).toBe('plan-file')
  })

  // Game Agent already has the tools the offer buys, so offering it would only
  // give the model a way to interrupt itself.
  it('offers the switch to Game Agent only from the one-shot preset', async () => {
    const resolution = await resolveCapabilities(hostWith(), ['game-studio'])
    const registry = fakeExtensionApi()
    for (const factory of resolution.extensionFactories) factory(registry.api as never)
    expect(registry.tools.map((tool) => tool.name)).not.toContain('offer_game_agent')
  })

  it('refuses to mix two session-shaping capabilities', async () => {
    await expect(
      resolveCapabilities(hostWith(), ['game-studio', 'game-studio-quick']),
    ).rejects.toThrow(/game-studio, game-studio-quick/)
  })

  it('attaches MCP servers as capabilities of their own', async () => {
    const resolution = await resolveCapabilities(hostWith(), ['mcp:web'])
    const registry = fakeExtensionApi()
    for (const factory of resolution.extensionFactories) factory(registry.api as never)
    expect(registry.tools.map((tool) => tool.name)).toEqual(['search'])
  })

  it('parks lazy-eligible tools when the context window is tight', async () => {
    const resolution = await resolveCapabilities(hostWith({ contextWindow: 1024 }), [
      'media',
      'web-debug',
      'game-studio',
    ])

    expect(resolution.dormantIds).toEqual(['web-debug', 'media'])
    expect(resolution.dormantToolNames).toEqual(['browser', 'media'])
    // Dormant capabilities are described in one line each instead of a schema,
    // and their skills are not advertised until they are activated.
    expect(resolution.dormantPromptSection).toContain('<capability id="media">')
    expect(resolution.announcedSkillNames).toEqual(['html-game-studio'])
    expect(resolution.skillSources.map((skill) => skill.name)).toContain('media-generation')

    // The meta-tool is the way back to them, so it comes with the dormant set.
    const registry = fakeExtensionApi()
    for (const factory of resolution.extensionFactories) factory(registry.api as never)
    expect(registry.tools.map((tool) => tool.name)).toContain(CAPABILITIES_TOOL_NAME)
  })

  it('never parks a capability whose value is its lifecycle hooks', async () => {
    const resolution = await resolveCapabilities(hostWith({ contextWindow: 1024 }), [
      'media',
      'web-debug',
      'memory',
    ])
    expect(resolution.dormantIds).toContain('media')
    expect(resolution.dormantIds).not.toContain('memory')
  })
})

describe('the capabilities meta-tool', () => {
  const resolvedEntry = (id: string, toolNames: string[]) => ({
    capability: { id, label: id, summary: `${id} summary` },
    tools: toolNames.map((name) => ({ name })),
    skills: [{ name: `${id}-skill`, description: 'd', body: 'b' }],
  })

  async function callTool(
    api: ReturnType<typeof fakeExtensionApi>,
    dormantIds: string[],
    params: Record<string, unknown>,
  ) {
    const resolved = [resolvedEntry('media', ['media']), resolvedEntry('web-debug', ['browser'])]
    const dormant = resolved.filter(({ capability }) => dormantIds.includes(capability.id))
    // The session starts with the eager capabilities' tools already active.
    api.api.setActiveTools(
      resolved
        .filter(({ capability }) => !dormantIds.includes(capability.id))
        .flatMap(({ tools }) => tools.map((tool) => tool.name)),
    )
    const extension = createCapabilitiesExtension({
      resolved: resolved as never,
      dormant: dormant as never,
      skillLocations: { media: ['media-skill/SKILL.md'] },
    })
    extension.factory(api.api as never)
    const tool = api.tools.find(
      (candidate) => candidate.name === CAPABILITIES_TOOL_NAME,
    ) as unknown as {
      execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }>
    }
    const result = await tool.execute('call-1', params)
    return result.content[0].text
  }

  it('lists every capability with its load state', async () => {
    const api = fakeExtensionApi()
    const text = await callTool(api, ['media'], { action: 'list' })
    expect(text).toContain('media (not loaded)')
    expect(text).toContain('web-debug (loaded)')
  })

  it('activates a dormant capability and points at its skill', async () => {
    const api = fakeExtensionApi()
    const text = await callTool(api, ['media'], { action: 'activate', id: 'media' })
    expect(text).toContain('Activated "media"')
    expect(text).toContain('media-skill/SKILL.md')
    expect(api.activeTools()).toContain('media')
  })

  it('answers instead of failing when there is nothing to activate', async () => {
    const api = fakeExtensionApi()
    expect(await callTool(api, ['media'], { action: 'activate', id: 'web-debug' })).toContain(
      'No dormant capability',
    )
    expect(await callTool(api, ['media'], { action: 'activate' })).toContain('needs an "id"')
  })
})

describe('the memory capability', () => {
  it('pins the settings the app depends on', () => {
    const config = memoryTestables.hermesConfig('/memory')
    // The subprocess review transport shells out to a `pi` CLI the app does not
    // ship, and the memory dir must stay inside the app's own agent dir.
    expect(config.reviewTransport).toBe('direct')
    expect(config.memoryDir).toBe('/memory')
    expect(config.memoryMode).toBe('policy-only')
  })

  it('reads the skills the extension wrote, global and per project', () => {
    const write = (dir: string, name: string, description: string) => {
      fs.mkdirSync(path.join(dir, name), { recursive: true })
      fs.writeFileSync(
        path.join(dir, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${description}\n---\n\nProcedure body\n`,
      )
    }
    write(path.join(agentDir, 'pi-hermes-memory', 'skills'), 'debug-vite', 'Fix vite builds')
    write(path.join(agentDir, 'projects-memory', 'game', 'skills'), 'ship-game', 'Release a game')

    const skills = memoryTestables.readGeneratedSkills(hostWith())
    expect(skills.map((skill) => skill.name).sort()).toEqual(['debug-vite', 'ship-game'])
    expect(skills[0].body).toBe('Procedure body')
  })

  // The extension keeps everything in SQLite, so a build whose native addon was
  // not compiled for Electron would fail on the first memory tool call. The
  // capability has to refuse up front instead.
  it('finds the SQLite addon this build was set up with', () => {
    expect(memoryTestables.nativeBinaryPath()).toMatch(/better_sqlite3\.node$/)
  })

  it('ignores a skill file it cannot make sense of', () => {
    const dir = path.join(agentDir, 'pi-hermes-memory', 'skills', 'broken')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'no frontmatter here\n')
    expect(memoryTestables.readGeneratedSkills(hostWith())).toEqual([])
    expect(memoryTestables.readSkillFile(path.join(dir, 'missing.md'))).toBeUndefined()
  })
})
