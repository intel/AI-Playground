import { type Locator, type Page, expect } from '@playwright/test'

/**
 * Page object for the Model Management view (`views/ModelManager.vue`) — the
 * full-screen model library opened from the title bar or from "Manage Models" in
 * the Chat settings sidebar.
 *
 * Everything is located by role + accessible name, so the ARIA the app carries is
 * what this drives: the overlay is a `dialog` named "Models", each row's action
 * menu is `<label> actions`, and the row checkboxes are `Select <label>`.
 */
export class ModelManagerPage {
  constructor(private readonly page: Page) {}

  private get overlay(): Locator {
    return this.page.getByRole('dialog', { name: 'Models' })
  }

  private get openButton(): Locator {
    return this.page.getByRole('button', { name: 'Model management' })
  }

  get searchBox(): Locator {
    return this.overlay.getByRole('searchbox', { name: 'Search models' })
  }

  /** The backend filter's trigger. Its label is the current value. */
  get backendFilter(): Locator {
    return this.overlay.getByRole('group', { name: 'Backend' }).getByRole('button')
  }

  /** The download-status filter's trigger. Its label is the current value. */
  get statusFilter(): Locator {
    return this.overlay.getByRole('group', { name: 'Status' }).getByRole('button')
  }

  /** A row, matched by the model's visible label (its file name). */
  row(label: string): Locator {
    return this.overlay.getByRole('row').filter({ hasText: label })
  }

  /**
   * Model rows currently rendered. Filtered on having a `cell`, which excludes the
   * header row — its cells are `columnheader`s, and it carries a select-all
   * checkbox of its own, so filtering on the checkbox would count it as a model.
   */
  get rows(): Locator {
    return this.overlay.getByRole('row').filter({ has: this.page.getByRole('cell') })
  }

  /** Open the library. Idempotent — a second call with it already open is a no-op. */
  async open(): Promise<void> {
    if (await this.isOpen()) return
    await this.openButton.click()
    await expect(this.overlay).toBeVisible()
  }

  async close(): Promise<void> {
    if (!(await this.isOpen())) return
    // Scoped to the overlay: the header's window-close control is also a "Close"
    // button and clicking it would quit the app.
    await this.overlay.getByRole('button', { name: 'Close model management' }).click()
    await expect(this.overlay).toBeHidden()
  }

  isOpen(): Promise<boolean> {
    return this.overlay.isVisible().catch(() => false)
  }

  /** Narrow the table to models whose file name contains `text`. */
  async search(text: string): Promise<void> {
    await this.searchBox.fill(text)
  }

  /** Pick a use case in the left sidebar ("All", "LLM", "Embedding", …). */
  async selectUseCase(useCase: string): Promise<void> {
    await this.overlay
      .getByRole('navigation', { name: 'Model use cases' })
      .getByText(useCase, { exact: true })
      .click()
  }

  async toggleFavorite(label: string): Promise<void> {
    await this.row(label)
      .getByRole('button', { name: new RegExp(`favorites ${escapeRegExp(label)}$`) })
      .click()
  }

  async select(label: string): Promise<void> {
    await this.row(label)
      .getByRole('checkbox', { name: `Select ${label}` })
      .click()
  }

  /** The batch download icon button, disabled until something downloadable is selected. */
  get downloadSelectedButton(): Locator {
    return this.overlay.getByRole('button', { name: 'Download selected' })
  }

  /** The batch delete icon button, disabled until something deletable is selected. */
  get deleteSelectedButton(): Locator {
    return this.overlay.getByRole('button', { name: 'Delete selected' })
  }

  /**
   * The label of every row currently listed, top to bottom. Read per row rather
   * than as one flattened cell list, which would collapse to a single match.
   * The model cell also carries the repository and "Used by" lines, so only its
   * first line is the label.
   */
  async visibleLabels(): Promise<string[]> {
    const count = await this.rows.count()
    const labels: string[] = []
    for (let index = 0; index < count; index++) {
      const cell = this.rows.nth(index).getByRole('cell').nth(2)
      labels.push((await cell.innerText()).split('\n')[0]!.trim())
    }
    return labels
  }

  async expectRowVisible(label: string): Promise<void> {
    await expect(this.row(label)).toBeVisible()
  }

  async expectRowAbsent(label: string): Promise<void> {
    await expect(this.row(label)).toHaveCount(0)
  }

  /**
   * A row's status cell ("On disk" / "Not downloaded"). Read from its own cell
   * rather than the whole row, whose text also carries the repo, the "Used by"
   * line and the size.
   */
  private statusCell(label: string): Locator {
    // Column order (ModelLibraryTable.vue): select, favorite, model, use case,
    // backend, size, modified, status, actions.
    return this.row(label).getByRole('cell').nth(7)
  }

  /** True when the model's files are on disk. */
  async isDownloaded(label: string): Promise<boolean> {
    return (await this.statusCell(label).innerText()).trim() === 'On disk'
  }

  /** Wait for the row to report the expected on-disk state (downloads/deletes are async). */
  async expectDownloaded(label: string, downloaded: boolean, timeout = 30_000): Promise<void> {
    await expect(this.statusCell(label)).toHaveText(downloaded ? 'On disk' : 'Not downloaded', {
      timeout,
    })
  }

  /** Open a row's "…" action menu and return it, so callers can pick an item. */
  private async openRowActions(label: string): Promise<Locator> {
    await this.row(label)
      .getByRole('button', { name: `${label} actions` })
      .click()
    const menu = this.page.getByRole('menu')
    await expect(menu).toBeVisible()
    return menu
  }

  /**
   * Delete one model from disk via its row action, confirming the permanent-delete
   * dialog. Returns once the row reports "Not downloaded".
   */
  async deleteFromRow(label: string): Promise<void> {
    const menu = await this.openRowActions(label)
    await menu.getByRole('menuitem', { name: /Delete from disk/ }).click()
    await this.confirmDelete(label)
    await this.expectDownloaded(label, false)
  }

  /** The permanent-delete confirmation (DeleteModelDialog.vue). */
  get deleteDialog(): Locator {
    return this.page.getByRole('dialog', { name: 'Delete model files' })
  }

  /**
   * Confirm the delete dialog, first asserting it names `label` among the files it
   * is about to remove — the dialog is the last chance to notice it is pointed at
   * the wrong model, since the files do not go to the trash.
   */
  async confirmDelete(label: string): Promise<void> {
    await expect(this.deleteDialog).toBeVisible()
    await expect(this.deleteDialog).toContainText(label)
    await this.deleteDialog.getByRole('button', { name: 'Delete permanently' }).click()
    await expect(this.deleteDialog).toBeHidden({ timeout: 60_000 })
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
