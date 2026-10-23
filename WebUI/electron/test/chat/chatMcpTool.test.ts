import { describe, expect, it, vi } from 'vitest'

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../adapters/mcp/mcpManager', () => ({
  invokeMcpServerTool: vi.fn(),
  listMcpServers: vi.fn(() => []),
}))

const { parseMcpToolName, isChatMcpTool } = await import('../../chat/chatMcpTool')

describe('parseMcpToolName', () => {
  it('splits a plain server id and tool name', () => {
    expect(parseMcpToolName('mcp__files__read_file', ['files'])).toEqual({
      serverId: 'files',
      toolName: 'read_file',
    })
  })

  it('prefers a configured server id that itself contains the separator', () => {
    expect(parseMcpToolName('mcp__my__server__do_thing', ['my__server'])).toEqual({
      serverId: 'my__server',
      toolName: 'do_thing',
    })
  })

  it('falls back to the first separator for an unknown server', () => {
    expect(parseMcpToolName('mcp__gone__read', [])).toEqual({
      serverId: 'gone',
      toolName: 'read',
    })
  })

  it('rejects names that carry no routing', () => {
    expect(parseMcpToolName('mcp__files', ['files'])).toBeNull()
    expect(parseMcpToolName('searchWeb', [])).toBeNull()
    expect(isChatMcpTool('searchWeb')).toBe(false)
  })
})
