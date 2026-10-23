import { describe, expect, it } from 'vitest'
import {
  isAipgChatToolPart,
  isChatMcpToolPart,
  isChatMediaToolPart,
  isChatWebBrowseToolPart,
} from './chatToolParts'

const aipgNames = new Set(['media', 'comfyUI', 'searchWeb', 'captureScreenshot'])

describe('chatToolParts', () => {
  it('recognizes media tools in both UI encodings', () => {
    expect(isChatMediaToolPart({ type: 'tool-media', toolCallId: 'c1' })).toBe(true)
    expect(isChatMediaToolPart({ type: 'dynamic-tool', toolName: 'media', toolCallId: 'c1' })).toBe(
      true,
    )
    expect(isChatMediaToolPart({ type: 'tool-comfyUI' })).toBe(true)
    expect(isChatMediaToolPart({ type: 'dynamic-tool', toolName: 'comfyUiImageEdit' })).toBe(true)
    expect(isChatMediaToolPart({ type: 'dynamic-tool', toolName: 'searchWeb' })).toBe(false)
    expect(isChatMediaToolPart({ type: 'text' })).toBe(false)
  })

  it('recognizes AIPG tools whether the part is static or dynamic', () => {
    expect(isAipgChatToolPart({ type: 'tool-media' }, aipgNames)).toBe(true)
    expect(isAipgChatToolPart({ type: 'dynamic-tool', toolName: 'media' }, aipgNames)).toBe(true)
    expect(isAipgChatToolPart({ type: 'dynamic-tool', toolName: 'mcp__s__t' }, aipgNames)).toBe(
      false,
    )
  })

  it('recognizes MCP tools by the mcp__ prefix in either encoding', () => {
    expect(isChatMcpToolPart({ type: 'dynamic-tool', toolName: 'mcp__files__read' })).toBe(true)
    expect(isChatMcpToolPart({ type: 'tool-mcp__files__read' })).toBe(true)
    expect(isChatMcpToolPart({ type: 'dynamic-tool', toolName: 'media' })).toBe(false)
  })

  it('recognizes web-browse tools in both encodings', () => {
    expect(isChatWebBrowseToolPart({ type: 'tool-searchWeb' })).toBe(true)
    expect(isChatWebBrowseToolPart({ type: 'dynamic-tool', toolName: 'browseWeb' })).toBe(true)
    expect(isChatWebBrowseToolPart({ type: 'tool-media' })).toBe(false)
  })
})
