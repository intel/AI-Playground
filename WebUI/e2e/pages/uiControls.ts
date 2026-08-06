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

/** The mode-settings sidebar region (SideModalBase aria-label is `<mode> Settings`). */
export function settingsRegion(page: Page, mode = 'Chat'): Locator {
  return page.getByRole('region', { name: `${mode} Settings` })
}
