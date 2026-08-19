import { type Page, type Locator, test, expect } from '@playwright/test'

/**
 * Page object for the Home Agent setup page (HomeAgentSetupPage.vue) and the
 * title-bar master toggle (HomeAgentToggle.vue). Scoped to the "Local web chat"
 * channel — the browser-served, LAN-reachable third option alongside Telegram
 * and Slack.
 */
export class HomeAgentPage {
  constructor(private readonly window: Page) {}

  private get heading(): Locator {
    return this.window.getByRole('heading', { name: 'Home Agent Setup' })
  }

  private get setupCog(): Locator {
    return this.window.getByRole('button', { name: 'Revisit Home Agent setup' })
  }

  private get masterToggle(): Locator {
    return this.window.getByRole('switch', { name: /^Home Agent: (on|off)$/ })
  }

  /** Reach the Home Agent setup page — either it's already showing (we were
   *  routed here straight after installing the backend) or we open it from the
   *  title-bar gear. */
  async open(): Promise<void> {
    await test.step('Open Home Agent setup', async () => {
      if (await this.heading.isVisible().catch(() => false)) return
      await expect(this.setupCog).toBeEnabled({ timeout: 120_000 })
      await this.setupCog.click()
      await expect(this.heading).toBeVisible({ timeout: 30_000 })
    })
  }

  /**
   * Configure and start the local web chat: pick the tab, set the port + a chat
   * password, opt into LAN if requested, then "Save & start". Success collapses
   * the panel to a "Connected & verified" summary — which is what we wait on.
   */
  async configureLocalWeb(opts: {
    port: number
    password: string
    allowLan?: boolean
  }): Promise<void> {
    await test.step(`Configure local web chat on port ${opts.port}`, async () => {
      // The "LAN chat" tile is the first (default) channel tab; click it
      // explicitly so this is order-independent.
      await this.window.getByText('LAN chat', { exact: true }).first().click()

      // A previously-verified channel (config persists in safeStorage across
      // runs) renders a collapsed "Connected & verified" summary instead of the
      // input steps — expand it via "Reconfigure" so the form is present.
      const reconfigure = this.window.getByRole('button', { name: 'Reconfigure' })
      if (await reconfigure.isVisible().catch(() => false)) await reconfigure.click()

      const port = this.window.getByLabel('Port', { exact: true })
      await expect(port).toBeVisible({ timeout: 15_000 })
      await port.fill(String(opts.port))

      // Drive the toggle to the requested state rather than only switching it on:
      // the channel config survives in safeStorage between runs, so an earlier
      // LAN-enabled run would otherwise leave the server bound to 0.0.0.0 while
      // this test believes it is testing loopback.
      const allowLan = opts.allowLan ?? false
      const lan = this.window.getByRole('checkbox', { name: /Allow other devices/ })
      if ((await lan.isChecked().catch(() => false)) !== allowLan) {
        if (allowLan) await lan.check()
        else await lan.uncheck()
      }

      await this.window.getByLabel('Chat password').fill(opts.password)
      await this.window.getByRole('button', { name: 'Save & start' }).click()

      // Verification (re)starts the Python HTTP server and, on success, emits
      // `verified` → the panel collapses to the connected summary.
      await expect(this.window.getByText('Connected & verified')).toBeVisible({ timeout: 60_000 })
    })
  }

  /** Leave the setup page via the footer primary button ("Continue" / "Done"). */
  async finishSetup(): Promise<void> {
    await test.step('Finish Home Agent setup', async () => {
      const primary = this.window.getByRole('button', { name: /^(Continue|Done)$/ })
      if (await primary.isVisible().catch(() => false)) await primary.click()
      await expect(this.heading).toBeHidden({ timeout: 30_000 })
    })
  }

  /** Ensure the title-bar master switch is on so verified channels actually run. */
  async ensureMasterOn(): Promise<void> {
    await test.step('Turn the Home Agent master switch on', async () => {
      await expect(this.masterToggle).toBeEnabled({ timeout: 60_000 })
      if ((await this.masterToggle.getAttribute('aria-checked')) !== 'true') {
        await this.masterToggle.click()
      }
      await expect(this.masterToggle).toHaveAttribute('aria-checked', 'true')
    })
  }
}
