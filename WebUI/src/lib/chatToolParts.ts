import { toolPartNameOf } from './agentTranscript'

/** Chat media tools whose card shows the artifact runs they own (ChatWorkflowResult). */
const MEDIA_TOOL_NAMES = new Set(['comfyUI', 'comfyUiImageEdit', 'media'])

const WEB_BROWSE_TOOL_NAMES = new Set(['searchWeb', 'browseWeb', 'interactWithWebPage'])

export function isChatMediaToolPart(part: unknown): boolean {
  const name = toolPartNameOf(part)
  return name !== undefined && MEDIA_TOOL_NAMES.has(name)
}

export function isChatWebBrowseToolPart(part: unknown): boolean {
  const name = toolPartNameOf(part)
  return name !== undefined && WEB_BROWSE_TOOL_NAMES.has(name)
}

export function isChatMcpToolPart(part: unknown): boolean {
  const name = toolPartNameOf(part)
  return typeof name === 'string' && name.startsWith('mcp__')
}

export function isAipgChatToolPart(part: unknown, aipgToolNames: ReadonlySet<string>): boolean {
  const name = toolPartNameOf(part)
  return name !== undefined && aipgToolNames.has(name)
}
