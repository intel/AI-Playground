import { type Locator, type Page, expect } from '@playwright/test'
import { setRekaToggle, settingsRegion } from './uiControls'

/**
 * Page object for the MCP section of the Chat settings sidebar (SettingsChat.vue →
 * SettingsMcp.vue). Drives the "MCP tools" master toggle and the per-server
 * Start/Stop button + connection status used by the MCP e2e specs.
 *
 * The section only renders when the active chat model supports tool calling, so
 * callers should have the agentic "Assistant" preset active and the Chat settings
 * sidebar open before using it.
 */
export class McpSettingsPage {
  constructor(private readonly page: Page) {}

  private get region(): Locator {
    return settingsRegion(this.page)
  }

  /** The "MCP tools:" master checkbox (shadcn Checkbox → role=checkbox, id=mcp-tools). */
  private get mcpToolsToggle(): Locator {
    return this.region.locator('#mcp-tools')
  }

  /** The row for one server, matched by its mcp.json displayName. */
  private serverRow(displayName: string): Locator {
    return this.region
      .locator('div.flex.items-center.justify-between.gap-3')
      .filter({ hasText: displayName })
  }

  private startStopButton(displayName: string): Locator {
    return this.serverRow(displayName).getByRole('button', { name: /^(Start|Stop)$/ })
  }

  /**
   * The "Connected" status text of a row. Matched exactly so it can't also match the
   * "Disconnected" state (of which "Connected" is a substring).
   */
  private statusConnected(displayName: string): Locator {
    return this.serverRow(displayName).getByText('Connected', { exact: true })
  }

  /** The red per-server error line rendered below the rows: "<name>: <error>". */
  private serverError(displayName: string): Locator {
    return this.region.getByText(new RegExp(`^${displayName}:`))
  }

  /** True when the MCP section is present (i.e. the active model supports tool calling). */
  async isAvailable(): Promise<boolean> {
    return this.mcpToolsToggle.isVisible().catch(() => false)
  }

  /** Ensure the "MCP tools" master toggle is on (it gates the per-server controls). */
  async ensureMcpToolsEnabled(): Promise<void> {
    await setRekaToggle(this.mcpToolsToggle, true)
  }

  /**
   * Start a server and wait for it to connect. Returns false when it can't connect in
   * this environment — the MCP section isn't shown, the row is absent, or Start yields
   * an Error status (e.g. `uvx` or network access missing) — so the caller can skip.
   * Idempotent: a server already Connected returns true without re-clicking.
   */
  async connectServer(displayName: string): Promise<boolean> {
    if (!(await this.isAvailable())) return false
    await this.ensureMcpToolsEnabled()

    const row = this.serverRow(displayName)
    if (!(await row.isVisible().catch(() => false))) return false

    if (
      await this.statusConnected(displayName)
        .isVisible()
        .catch(() => false)
    )
      return true

    const button = this.startStopButton(displayName)
    // Only click when the button reads "Start"; a Connected/Starting server reads "Stop".
    if ((await button.innerText().catch(() => '')).trim() === 'Start') {
      await button.click()
    }

    // Starting a server spawns the `uvx …` command and negotiates the tool list over
    // stdio, which can take a while on first run (uvx may resolve/download the package).
    // Settle on either a Connected status or a surfaced error, then report which won.
    const connected = this.statusConnected(displayName)
    await expect(connected.or(this.serverError(displayName))).toBeVisible({ timeout: 180_000 })
    return connected.isVisible().catch(() => false)
  }
}
