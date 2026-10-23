import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/tmp' },
}))

vi.mock('../../../observability/logger', () => ({
  appLoggerInstance: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { appLoggerInstance } from '../../../observability/logger'
import {
  MAX_MCP_TOOL_LIST_PAGES,
  MAX_MCP_TOOL_LIST_TOOLS,
  MCP_TOOL_LIST_PAGE_TIMEOUT_MS,
  collectMcpToolPages,
  listClientTools,
  listMcpServerTools,
} from '../../../adapters/mcp/mcpManager'

type ListedTool = {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

const tool = (name: string): ListedTool => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
})

const tools = (count: number, offset = 0): ListedTool[] =>
  Array.from({ length: count }, (_, index) => tool(`tool-${offset + index}`))

describe('MCP tool list bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pins the page, tool, and timeout caps', () => {
    expect(MAX_MCP_TOOL_LIST_PAGES).toBe(50)
    expect(MAX_MCP_TOOL_LIST_TOOLS).toBe(500)
    expect(MCP_TOOL_LIST_PAGE_TIMEOUT_MS).toBe(15_000)
  })

  it('returns every tool when the server ends the cursor', async () => {
    const pages = [
      { tools: tools(2), nextCursor: 'page-2' },
      { tools: tools(1, 2), nextCursor: undefined },
    ]
    const result = await collectMcpToolPages('demo', async () => pages.shift()!)

    expect(result.map((entry) => entry.name)).toEqual(['tool-0', 'tool-1', 'tool-2'])
    expect(appLoggerInstance.warn).not.toHaveBeenCalled()
  })

  it('stops after the page cap when nextCursor never clears', async () => {
    let calls = 0
    const result = await collectMcpToolPages('evil', async (cursor) => {
      calls += 1
      return { tools: [tool(`page-${calls}`)], nextCursor: cursor ?? 'again' }
    })

    expect(calls).toBe(MAX_MCP_TOOL_LIST_PAGES)
    expect(result).toHaveLength(MAX_MCP_TOOL_LIST_PAGES)
    expect(appLoggerInstance.warn).toHaveBeenCalledWith(
      `Tool list for evil truncated after ${MAX_MCP_TOOL_LIST_PAGES} pages`,
      'mcp',
    )
  })

  it('keeps at most the tool cap from a single oversized page', async () => {
    let calls = 0
    const result = await collectMcpToolPages('evil', async () => {
      calls += 1
      return { tools: tools(MAX_MCP_TOOL_LIST_TOOLS + 250), nextCursor: 'more' }
    })

    expect(calls).toBe(1)
    expect(result).toHaveLength(MAX_MCP_TOOL_LIST_TOOLS)
    expect(result[0]?.name).toBe('tool-0')
    expect(result.at(-1)?.name).toBe(`tool-${MAX_MCP_TOOL_LIST_TOOLS - 1}`)
    expect(appLoggerInstance.warn).toHaveBeenCalledWith(
      `Tool list for evil truncated at ${MAX_MCP_TOOL_LIST_TOOLS} tools`,
      'mcp',
    )
  })

  it('stops requesting pages once the tool cap is reached', async () => {
    const cursors: Array<string | undefined> = []
    const result = await collectMcpToolPages('evil', async (cursor) => {
      cursors.push(cursor)
      return { tools: tools(200, cursors.length * 200), nextCursor: `page-${cursors.length + 1}` }
    })

    expect(cursors).toEqual([undefined, 'page-2', 'page-3'])
    expect(result).toHaveLength(MAX_MCP_TOOL_LIST_TOOLS)
    expect(appLoggerInstance.warn).toHaveBeenCalledTimes(1)
  })

  it('does not warn when the last page lands exactly on the tool cap', async () => {
    const result = await collectMcpToolPages('demo', async () => ({
      tools: tools(MAX_MCP_TOOL_LIST_TOOLS),
    }))

    expect(result).toHaveLength(MAX_MCP_TOOL_LIST_TOOLS)
    expect(appLoggerInstance.warn).not.toHaveBeenCalled()
  })

  it('treats an empty cursor as the end of the list', async () => {
    let calls = 0
    const result = await collectMcpToolPages('demo', async () => {
      calls += 1
      return { tools: [tool('only')], nextCursor: '' }
    })

    expect(calls).toBe(1)
    expect(result).toHaveLength(1)
  })

  it('aborts a page that never returns and does not request another', async () => {
    let calls = 0
    let signal: AbortSignal | undefined
    const pending = collectMcpToolPages('evil', (_cursor, pageSignal) => {
      calls += 1
      signal = pageSignal
      return new Promise<{ tools: ListedTool[] }>((_resolve, reject) => {
        pageSignal.addEventListener('abort', () => {
          reject(pageSignal.reason ?? new Error('aborted'))
        })
      })
    })
    const assertion = expect(pending).rejects.toThrow(
      `Tool list for evil timed out after ${MCP_TOOL_LIST_PAGE_TIMEOUT_MS}ms`,
    )

    await vi.advanceTimersByTimeAsync(MCP_TOOL_LIST_PAGE_TIMEOUT_MS)
    await assertion
    expect(calls).toBe(1)
    expect(signal?.aborted).toBe(true)
  })

  it('propagates a failed page instead of continuing', async () => {
    let calls = 0
    await expect(
      collectMcpToolPages('evil', async () => {
        calls += 1
        throw new Error('connection reset')
      }),
    ).rejects.toThrow('connection reset')
    expect(calls).toBe(1)
  })

  it('rejects a page whose tools field is not an array', async () => {
    await expect(
      collectMcpToolPages('evil', async () => ({
        tools: 'nope' as unknown as ListedTool[],
        nextCursor: 'more',
      })),
    ).rejects.toThrow('malformed page')
  })

  it('asks listTools for an abort signal and the page timeout', async () => {
    const listTools = vi.fn(async () => ({ tools: [tool('only')] }))
    const result = await listClientTools('demo', { listTools })

    expect(result.map((entry) => entry.name)).toEqual(['only'])
    expect(listTools).toHaveBeenCalledTimes(1)
    expect(listTools).toHaveBeenCalledWith({
      params: { cursor: undefined },
      options: {
        signal: expect.any(AbortSignal),
        timeout: MCP_TOOL_LIST_PAGE_TIMEOUT_MS,
      },
    })
  })

  it('returns nothing for a server that is not running', async () => {
    await expect(listMcpServerTools('missing')).resolves.toEqual([])
    expect(appLoggerInstance.error).not.toHaveBeenCalled()
  })
})
