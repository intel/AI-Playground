import { type Locator, type Page, expect } from '@playwright/test'

/**
 * Set a reka-ui checkbox/switch (role=checkbox|switch) to `enabled`. reka's source of
 * truth is the `aria-checked` attribute — Playwright's isChecked()/toBeChecked() are
 * unreliable for these — so read and assert that. Waits for the control, clicks only
 * when the state must change, and always asserts the final state (an authoritative
 * post-condition, so a control that silently fails to flip fails the test here).
 */
export async function setRekaToggle(
  toggle: Locator,
  enabled: boolean,
  message?: string,
): Promise<void> {
  await toggle.waitFor({ state: 'visible', timeout: 15_000 })
  if ((await toggle.getAttribute('aria-checked')) !== String(enabled)) {
    await toggle.click()
  }
  await expect(toggle, message).toHaveAttribute('aria-checked', String(enabled))
}

/** The settings tabs of the open Session's view (SessionTabView.vue). */
export type SettingsTab = 'Inferencing' | 'Attributes'

/** A tab panel of the open Session's view, named after its tab. */
export function sessionTabPanel(page: Page, tab: SettingsTab | 'Viewport'): Locator {
  return page.getByRole('tabpanel', { name: tab })
}

/** Show a tab of the open Session's view; a no-op when it is already shown. */
export async function showSessionTab(page: Page, tab: SettingsTab | 'Viewport'): Promise<void> {
  const button = page.getByRole('tablist', { name: 'Session' }).getByRole('tab', { name: tab })
  if ((await button.getAttribute('aria-selected')) !== 'true') await button.click()
  await expect(sessionTabPanel(page, tab)).toBeVisible()
}
