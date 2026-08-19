import { type Locator, type Page, expect } from '@playwright/test'
import { type ChatMode } from './MainPage'

/**
 * Page object for the mode-specific settings sidebar (the one with the PRESET
 * grid) opened from the prompt area's "<Mode> Settings" button. Used here to
 * pick the chat preset that puts the assistant in agentic mode.
 */
export class SpecificSettingsPage {
  constructor(private readonly page: Page) {}

  // The settings sidebar renders with `hide-header` (no <h2> banner — see
  // SideModalSpecificSettings.vue), so its only stable handle is the SideModalBase
  // region, whose aria-label is `${mode} Settings`.
  private panel(mode: ChatMode): Locator {
    return this.page.getByRole('region', { name: `${mode} Settings` })
  }

  private openButton(mode: ChatMode): Locator {
    return this.page.getByRole('button', { name: `${mode} Settings` })
  }

  async open(mode: ChatMode = 'Chat'): Promise<void> {
    if (
      await this.panel(mode)
        .isVisible()
        .catch(() => false)
    )
      return
    await this.openButton(mode).click()
    await expect(this.panel(mode)).toBeVisible()
  }

  /**
   * Reference-image file inputs of the active ComfyUI preset, inside the settings
   * sidebar. Each is a `<input type="file">` rendered by the LoadImage control; we
   * target them as a semantic element type scoped to the mode's settings region
   * (the labels differ per preset — "Reference Image", "Input Image", etc.).
   */
  private imageInputs(mode: ChatMode): Locator {
    return this.page.getByRole('region', { name: `${mode} Settings` }).locator('input[type="file"]')
  }

  /**
   * Load the same fixture image into every reference-image slot of the active preset
   * (edit-image, image-to-video and reference-based create-image presets need one).
   * Returns how many slots were filled.
   */
  async attachReferenceImages(mode: ChatMode, filePath: string): Promise<number> {
    const inputs = this.imageInputs(mode)
    // The LoadImage inputs render a beat after the preset's settings load, so wait for
    // the first one before counting rather than racing an empty grid.
    await inputs
      .first()
      .waitFor({ state: 'attached', timeout: 15_000 })
      .catch(() => {})
    const count = await inputs.count()
    for (let i = 0; i < count; i++) {
      await inputs.nth(i).setInputFiles(filePath)
    }
    return count
  }

  /**
   * The chat "Backend" picker trigger (a DropDownNew button). Present only when the
   * active preset allows more than one backend (see SettingsChat.vue `isBackendLocked`);
   * located via its "Backend" label row inside the settings region.
   */
  private backendTrigger(mode: ChatMode): Locator {
    return this.panel(mode).locator('div.grid', { hasText: 'Backend' }).getByRole('button')
  }

  /**
   * Backend labels offered by the picker (e.g. 'llamaCPP - GGUF', 'OpenVINO'), or an
   * empty list when the preset is locked to one backend / the picker isn't shown.
   * Opens and closes the dropdown without changing the selection.
   */
  async availableBackends(mode: ChatMode = 'Chat'): Promise<string[]> {
    const trigger = this.backendTrigger(mode)
    if (!(await trigger.isVisible().catch(() => false))) return []
    await trigger.click()
    const menu = this.page.getByRole('menu')
    await menu.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
    const labels = (await menu.getByRole('menuitem').allInnerTexts())
      .map((l) => l.trim())
      .filter(Boolean)
    await this.page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
    return labels
  }

  /**
   * Select a chat backend by its picker label and wait for the switch to land (the
   * trigger's label reflects the active backend). Must be called with the settings
   * sidebar open. Switching backend can kick off a backend (re)start, so callers
   * should let the app settle (and resolve any model-download dialog) before sending.
   */
  async selectBackend(label: string, mode: ChatMode = 'Chat'): Promise<void> {
    const trigger = this.backendTrigger(mode)
    await trigger.click()
    const menu = this.page.getByRole('menu')
    await menu.getByRole('menuitem', { name: label, exact: true }).click()
    await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
    await expect(trigger).toContainText(label, { timeout: 15_000 })
  }

  /**
   * The chat "Device" (inference hardware) picker trigger — a DropDownNew button in the
   * "Device" label row (SettingsChat.vue). Shown for local backends; Cloud Mode swaps
   * it for a Provider picker, so it's absent there.
   */
  private deviceTrigger(mode: ChatMode): Locator {
    return this.panel(mode).locator('div.grid', { hasText: 'Device' }).getByRole('button')
  }

  /**
   * Inference-device labels offered by the chat "Device" picker (e.g. "GPU.0: Intel…",
   * "NPU: Intel(R) AI Boost", "CPU"), or an empty list when no device picker is shown
   * (cloud backend, or a backend with no selectable device). Opens and closes the
   * dropdown without changing the selection.
   */
  async availableDevices(mode: ChatMode = 'Chat'): Promise<string[]> {
    const trigger = this.deviceTrigger(mode)
    if (!(await trigger.isVisible().catch(() => false))) return []
    await trigger.click()
    const menu = this.page.getByRole('menu')
    await menu.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
    const labels = (await menu.getByRole('menuitem').allInnerTexts())
      .map((l) => l.trim())
      .filter(Boolean)
    await this.page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
    return labels
  }

  /**
   * Select the first chat inference device whose label contains `substring`
   * (case-insensitive) — e.g. "NPU". Must be called with the settings sidebar open.
   * Switching device restarts the backend, so callers should let the app settle (and
   * resolve any model-download dialog) before sending. Returns false — selection
   * unchanged — when no device matches or no device picker is shown.
   */
  async selectDeviceContaining(substring: string, mode: ChatMode = 'Chat'): Promise<boolean> {
    const trigger = this.deviceTrigger(mode)
    if (!(await trigger.isVisible().catch(() => false))) return false
    await trigger.click()
    const menu = this.page.getByRole('menu')
    await menu.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
    const match = menu
      .getByRole('menuitem')
      .filter({ hasText: new RegExp(substring, 'i') })
      .first()
    if ((await match.count()) === 0) {
      await this.page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
      return false
    }
    await match.click()
    await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
    // The trigger's label reflects the active device once the switch (and backend
    // restart) lands.
    await expect(trigger).toContainText(new RegExp(substring, 'i'), { timeout: 30_000 })
    return true
  }

  /**
   * Create a custom ("designed") TTS voice from the Text-to-Speech preset's settings
   * (SettingsTts.vue "Create a custom voice" form): fill the name + description, save,
   * and confirm it lands in the "Your voices" list. Saving makes the new voice the
   * active one (see `saveCurrentVoice` → `applySavedVoice`), so the next synthesis uses
   * it. Requires the settings sidebar open with the "Text to Speech" preset active.
   */
  async createTtsVoice(
    opts: { name: string; description: string },
    mode: ChatMode = 'Chat',
  ): Promise<void> {
    const panel = this.panel(mode)
    // The form fields are the only inputs carrying these placeholders (name = "e.g.
    // Tammy", description = the "…British man…" example), so they're stable handles
    // that don't depend on label wiring.
    await panel.getByPlaceholder('e.g. Tammy').fill(opts.name)
    await panel.getByPlaceholder(/British man/).fill(opts.description)

    const save = panel.getByRole('button', { name: 'Save voice' })
    await expect(save, 'Save voice is disabled until name + description are filled').toBeEnabled()
    await save.click()

    // Saved voices render in the "Your voices" list; our new one proves the save landed.
    // Match the name exactly and take the first hit: the active-voice dropdown also shows
    // it (as "<name> (your voice)"), so a loose match would be ambiguous under strict mode.
    await expect(
      panel.getByText(opts.name, { exact: true }).first(),
      'the newly created voice should appear in the "Your voices" list',
    ).toBeVisible({ timeout: 5_000 })
  }

  /**
   * The "Voice" picker row in the Text-to-Speech settings (SettingsTts.vue). Anchored
   * on a label whose text is exactly "Voice", so it can't drift onto the neighbouring
   * "Your voices" list or the two "Language" rows.
   */
  private ttsVoiceTrigger(mode: ChatMode): Locator {
    return this.panel(mode)
      .locator('div.grid')
      .filter({ has: this.page.getByText('Voice', { exact: true }) })
      .getByRole('button')
  }

  /**
   * Select an entry from the "Voice" picker — a built-in speaker (listed as
   * "Ryan — English") or a saved one ("Tammy (your voice)"). Pass a regex to match a
   * prefix. Requires the settings sidebar open with the "Text to Speech" preset active.
   */
  async selectTtsVoice(label: string | RegExp, mode: ChatMode = 'Chat'): Promise<void> {
    const trigger = this.ttsVoiceTrigger(mode)
    await trigger.click()
    const menu = this.page.getByRole('menu')
    await menu.getByRole('menuitem', { name: label }).first().click()
    await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
    await expect(trigger).toContainText(label, { timeout: 15_000 })
  }

  /**
   * Remove a saved TTS voice if it is listed, so a run that shares persisted app state
   * with an earlier one still *creates* the voice rather than re-saving it. No-op when
   * the voice isn't there.
   */
  async deleteTtsVoiceIfPresent(name: string, mode: ChatMode = 'Chat'): Promise<void> {
    const row = this.panel(mode).locator('li').filter({ hasText: name })
    if ((await row.count()) === 0) return
    await row.first().getByRole('button', { name: 'Remove' }).click()
    await expect(row, `saved voice "${name}" should be gone after Remove`).toHaveCount(0)
  }

  /**
   * Re-roll a saved TTS voice: draw a different speaker for the same description by
   * giving the voice a new seed (SettingsTts.vue → `rerollVoiceSeed`). The counterpart
   * of the pinned seed — proof that the seed is what fixes the voice, since audio
   * synthesized after a re-roll must differ from audio synthesized before it.
   * Requires the settings sidebar open with the "Text to Speech" preset active.
   */
  async rerollTtsVoice(name: string, mode: ChatMode = 'Chat'): Promise<void> {
    const row = this.panel(mode).locator('li').filter({ hasText: name })
    await expect(row, `saved voice "${name}" should be listed under "Your voices"`).toHaveCount(1)
    await row.getByRole('button', { name: 'Re-roll' }).click()
  }

  /** Close the sidebar via its (responsive) Close button, scoped to the sidebar
   *  region so it can't match the header's window-close (X) button. */
  async close(mode: ChatMode = 'Chat'): Promise<void> {
    const sidebar = this.page.getByRole('region', { name: `${mode} Settings` })
    const closers = sidebar.getByRole('button', { name: 'Close' })
    const count = await closers.count()
    for (let i = 0; i < count; i++) {
      const button = closers.nth(i)
      if (await button.isVisible()) {
        await button.click()
        break
      }
    }
    await expect(sidebar).toBeHidden()
  }
}
