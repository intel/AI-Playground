// Friendly, user-facing labels for tool calls. Shared by the desktop chat tool
// card (ChatToolDisplay.vue) and the remote channel markers (channel adapters)
// so a tool reads the same on every surface.

const FRIENDLY_LABELS: Record<string, string> = {
  getHomeAgentSettings: 'Read settings',
  listHomeAgentModels: 'List models',
  configureHomeAgent: 'Change settings',
  captureScreenshot: 'Capture screenshot',
  comfyUI: 'Generate media',
  comfyUiImageEdit: 'Edit image',
  visualizeObjectDetections: 'Visualize detections',
}

/**
 * Turn a raw tool name (a static tool name, a `tool-*` part type, or an MCP
 * `mcp__<server>__<tool>` dynamic name) into a concise human-readable label.
 */
export function toolDisplayLabel(rawName: string): string {
  // Tolerate being handed a part type like `tool-getHomeAgentSettings`.
  const name = rawName.startsWith('tool-') ? rawName.slice('tool-'.length) : rawName

  if (name.startsWith('mcp__')) {
    const parts = name.split('__')
    if (parts.length >= 3) {
      const serverId = parts[1]
      const toolName = parts.slice(2).join('__')
      return `${serverId} - ${toolName}`
    }
    return name
  }

  return FRIENDLY_LABELS[name] ?? name
}
