import { type Locator, type Page } from '@playwright/test'
import { setRekaToggle, settingsRegion } from './uiControls'

/** Built-in tool names — the `#builtin-tool-<name>` checkbox id suffixes (see
 *  SettingsBuiltinTools.vue `builtinTools`, keyed to `aipgTools`). */
export const BUILTIN_TOOLS = [
  'comfyUI',
  'comfyUiImageEdit',
  'visualizeObjectDetections',
  'captureScreenshot',
  'browseWeb',
  'synthesizeTextToSpeech',
] as const

/** Preset-backed tools that expose per-workflow switches inside a collapsible. */
const WORKFLOW_TOOLS = ['comfyUI', 'comfyUiImageEdit'] as const

/**
 * Page object for the tool-selection controls in the Chat settings sidebar
 * (SettingsChat.vue → SettingsBuiltinTools.vue + SettingsMcp.vue). Lets the agentic
 * specs enforce a deterministic tool set so the model's context isn't bloated by tool
 * schemas it doesn't need (the default 8192-token window fills fast when every
 * built-in tool, MCP server and ComfyUI workflow is advertised).
 *
 * Settings persist to disk across spec launches, so each profile is *enforced* (read
 * current state, change if it differs) rather than assumed. The section only renders
 * when the active chat model supports tool calling, so the agentic "Assistant" preset
 * must be active and the Chat settings sidebar open before use.
 */
export class ToolSettingsPage {
  constructor(private readonly page: Page) {}

  private get region(): Locator {
    return settingsRegion(this.page)
  }

  /** Master "Built-in tools" checkbox (SettingsChat.vue `id="tools"`). */
  private get builtinMasterToggle(): Locator {
    return this.region.locator('#tools')
  }

  /** Master "MCP tools" checkbox. */
  private get mcpMasterToggle(): Locator {
    return this.region.locator('#mcp-tools')
  }

  private builtinToolToggle(name: string): Locator {
    return this.region.locator(`#builtin-tool-${name}`)
  }

  /** True when the tools section is present (i.e. the model supports tool calling). */
  async isAvailable(): Promise<boolean> {
    return this.builtinMasterToggle.isVisible().catch(() => false)
  }

  /** The header row of a preset-backed tool, located via its checkbox's ancestor. */
  private toolHeader(toolName: string): Locator {
    return this.builtinToolToggle(toolName).locator(
      'xpath=ancestor::div[contains(@class,"justify-between")][1]',
    )
  }

  private workflowSwitches(toolName: string): Locator {
    return this.region.locator(`[id^="builtin-tool-${toolName}-preset-"]`)
  }

  /** Expand a tool's per-workflow list (reka Collapsible unmounts it while closed). */
  private async expandWorkflows(toolName: string): Promise<void> {
    const anySwitch = this.workflowSwitches(toolName).first()
    if (await anySwitch.isVisible().catch(() => false)) return
    const trigger = this.toolHeader(toolName).getByRole('button', { name: /enabled/ })
    if (!(await trigger.isVisible().catch(() => false))) return
    await trigger.click()
    await anySwitch.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
  }

  /** Enable exactly one workflow of a tool (by name), disabling all others. */
  private async keepOnlyWorkflow(toolName: string, keepName: string): Promise<void> {
    await this.expandWorkflows(toolName)
    const switches = this.workflowSwitches(toolName)
    const count = await switches.count()
    const prefix = `builtin-tool-${toolName}-preset-`
    for (let i = 0; i < count; i++) {
      const toggle = switches.nth(i)
      const id = (await toggle.getAttribute('id')) ?? ''
      const workflowName = id.slice(prefix.length)
      await setRekaToggle(toggle, workflowName === keepName)
    }
  }

  /** Re-enable every workflow of a tool (undo any prior trimming). */
  private async enableAllWorkflows(toolName: string): Promise<void> {
    await this.expandWorkflows(toolName)
    const switches = this.workflowSwitches(toolName)
    const count = await switches.count()
    for (let i = 0; i < count; i++) {
      await setRekaToggle(switches.nth(i), true)
    }
  }

  /**
   * Minimal set for the fast agentic smoke (haiku → image via "Draft Image"): enable
   * only the "Generate media" tool with only the "Draft Image" workflow; turn MCP and
   * every other built-in tool off. Returns false when the tools section isn't shown.
   */
  async applyMinimalImageTools(): Promise<boolean> {
    if (!(await this.isAvailable())) return false
    await setRekaToggle(this.builtinMasterToggle, true)
    if (await this.mcpMasterToggle.isVisible().catch(() => false)) {
      await setRekaToggle(this.mcpMasterToggle, false)
    }
    for (const name of BUILTIN_TOOLS) {
      await setRekaToggle(this.builtinToolToggle(name), name === 'comfyUI')
    }
    await this.keepOnlyWorkflow('comfyUI', 'Draft Image')
    return true
  }

  /**
   * App defaults for the full agentic flow: all built-in tools on except Capture
   * screenshot, MCP on, and every workflow re-enabled. Enforced (not assumed) so a
   * prior fast run that trimmed tools/workflows on disk doesn't leak in. Returns false
   * when the tools section isn't shown.
   */
  async applyDefaultTools(): Promise<boolean> {
    if (!(await this.isAvailable())) return false
    await setRekaToggle(this.builtinMasterToggle, true)
    if (await this.mcpMasterToggle.isVisible().catch(() => false)) {
      await setRekaToggle(this.mcpMasterToggle, true)
    }
    for (const name of BUILTIN_TOOLS) {
      await setRekaToggle(this.builtinToolToggle(name), name !== 'captureScreenshot')
    }
    for (const toolName of WORKFLOW_TOOLS) {
      await this.enableAllWorkflows(toolName)
    }
    return true
  }
}
