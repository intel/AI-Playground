import { type Locator, type Page, expect } from '@playwright/test'

/** Outcome of handling the model-download dialog for one turn. */
export type DownloadOutcome =
  | 'none' // no dialog appeared — required models were already present
  | 'downloaded' // models were missing; download was confirmed and completed
  | 'blocked' // models are gated / access not granted — can't proceed here

/**
 * Page object for the model-download dialog (`DownloadDialog.vue`). It pops up the
 * first time a preset needs a model that isn't on disk yet — which is most presets
 * on a fresh machine, across chat, image and video. Generation blocks on it: the
 * turn stays "busy" until the models are downloaded (or the dialog is dismissed),
 * so every send/generate flow must clear it.
 *
 * Flow: a confirm phase (model list + a terms checkbox + Confirm), then a progress
 * phase, then the dialog closes on success. Confirm only enables once model sizes
 * have loaded, the terms box is ticked, and access to (gated) models is granted.
 */
export class DownloadDialogPage {
  constructor(private readonly page: Page) {}

  // Model downloads are multi-GB; allow generously for them to finish.
  static readonly DOWNLOAD_TIMEOUT = 20 * 60_000

  get dialog(): Locator {
    return this.page.getByRole('dialog', { name: 'Model download' })
  }

  private get termsCheckbox(): Locator {
    return this.dialog.getByRole('checkbox')
  }

  private get confirmButton(): Locator {
    return this.dialog.getByRole('button', { name: 'Confirm', exact: true })
  }

  private get cancelButton(): Locator {
    return this.dialog.getByRole('button', { name: 'Cancel', exact: true })
  }

  /** True if the download dialog is currently on screen. */
  async isOpen(): Promise<boolean> {
    return this.dialog.isVisible().catch(() => false)
  }

  /**
   * If the download dialog is showing, accept the terms, start the download and wait
   * for it to finish (the dialog closes). No-op if it isn't showing. If Confirm never
   * enables — gated models with no granted access, which can't be downloaded without
   * a Hugging Face token/license acceptance — the dialog is cancelled and `'blocked'`
   * is returned so the caller can skip the test rather than hang.
   */
  async resolve(timeout: number = DownloadDialogPage.DOWNLOAD_TIMEOUT): Promise<DownloadOutcome> {
    // Give the dialog a moment to appear after a send/generate before concluding
    // the models were already present.
    try {
      await this.dialog.waitFor({ state: 'visible', timeout: 10_000 })
    } catch {
      return 'none'
    }

    if (await this.termsCheckbox.isVisible().catch(() => false)) {
      await this.termsCheckbox.click()
    }

    // Confirm enables once sizes have loaded and access is granted.
    try {
      await expect(this.confirmButton).toBeEnabled({ timeout: 90_000 })
    } catch {
      await this.cancelButton.click().catch(() => {})
      await expect(this.dialog)
        .toBeHidden({ timeout: 30_000 })
        .catch(() => {})
      return 'blocked'
    }

    await this.confirmButton.click()
    // On success the dialog closes; on a download error it stays up in its error
    // phase and this rightly times out with the dialog still visible.
    await expect(this.dialog).toBeHidden({ timeout })
    return 'downloaded'
  }
}
