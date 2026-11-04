import { type Locator, type Page, expect } from '@playwright/test'
import { sessionTabPanel, showSessionTab, type SettingsTab } from './uiControls'

/**
 * Page object for the active preset's settings: the Inferencing and Attributes tabs of
 * the open Session's view (SessionTabView.vue), which every mode and Agent Preset uses.
 */
export class SpecificSettingsPage {
  constructor(private readonly page: Page) {}

  private panel(tab: SettingsTab = 'Inferencing'): Locator {
    return sessionTabPanel(this.page, tab)
  }

  /** Show a settings tab (Inferencing by default). */
  async open(tab: SettingsTab = 'Inferencing'): Promise<void> {
    await showSessionTab(this.page, tab)
  }

  /**
   * The "Load Image" buttons of the active ComfyUI preset's reference-image slots, in its
   * Attributes tab. Each is the `<label>` of a LoadImage file input, and `setInputFiles`
   * on a label targets the input it labels — the inputs' own names differ per preset.
   */
  private imageInputs(): Locator {
    return this.panel('Attributes').getByText('Load Image', { exact: true })
  }

  /**
   * Load the same fixture image into every reference-image slot of the active preset
   * (edit-image, image-to-video and reference-based create-image presets need one).
   * Returns how many slots were filled.
   */
  async attachReferenceImages(filePath: string): Promise<number> {
    await this.open('Attributes')
    const inputs = this.imageInputs()
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
   * The chat model picker's trigger (ModelSelector.vue), reached through the stable
   * `role="group"` the Model row carries (SettingsChatInferencing.vue). The trigger itself is
   * named after the current selection, and the row holds a second button — the
   * "Manage Models" gear — so it's pinned on the menu trigger's `aria-haspopup`
   * rather than on being the only button in the group.
   */
  private modelTrigger(): Locator {
    return this.panel()
      .getByRole('group', { name: 'Model' })
      .locator('button[aria-haspopup="menu"]')
  }

  /**
   * Model names offered by the chat model picker (its visible labels, i.e. the file
   * name / last path segment).
   *
   * Opens and closes the dropdown without changing the selection.
   */
  async availableModels(): Promise<string[]> {
    const trigger = this.modelTrigger()
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
   * Select a chat model by its visible label (the file name, e.g.
   * `smollm2-1.7b-instruct-q4_k_m.gguf`) and wait for the trigger to reflect it.
   * The picker lists the whole catalog for the active backend in a short scrolling
   * viewport, so the label is typed into the picker's own search box first — that
   * narrows the list to the wanted row instead of scrolling for it. Must be called
   * with the Inferencing tab shown.
   */
  async selectModel(label: string): Promise<void> {
    const trigger = this.modelTrigger()
    await trigger.click()
    const menu = this.page.getByRole('menu')
    await menu.waitFor({ state: 'visible', timeout: 5_000 })
    await menu.getByPlaceholder('Search models').fill(label)
    const match = menu.getByRole('menuitem').filter({ hasText: label })
    // The list re-renders as the search box is typed into, so wait for it to hold
    // the wanted row before clicking — otherwise the click can land on whichever
    // model happened to be first while the filter was still catching up.
    await expect(match.first()).toBeVisible({ timeout: 5_000 })
    await match.first().click()
    await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
    await expect(trigger).toContainText(label, { timeout: 15_000 })
  }

  /**
   * Select the first of `labels` the picker is actually offering.
   *
   * For models that ship in device-specific builds: OpenVINO publishes the same
   * weights as a plain and a `-cw-` (channel-wise) variant, and ModelSelector shows
   * exactly one of them — the `-cw-` build carries `npuSupport`, which is required on
   * NPU and filtered out on GPU. A caller that wants "the model this preset prefers"
   * therefore cannot name a single label without also pinning the device.
   *
   * Fails naming what *was* offered, so a picker that has genuinely lost the model
   * doesn't read as a bad label.
   */
  async selectFirstOfferedModel(labels: readonly string[]): Promise<string> {
    const offered = await this.availableModels()
    const wanted = labels.find((label) => offered.some((item) => item.includes(label)))
    expect(
      wanted,
      `none of [${labels.join(', ')}] is offered by the model picker — it lists: ` +
        `[${offered.join(', ')}]`,
    ).toBeDefined()
    await this.selectModel(wanted!)
    return wanted!
  }

  /**
   * The chat "Backend" picker trigger (a DropDownNew button). Present only when the
   * active preset allows more than one backend (see SettingsChatInferencing.vue `isBackendLocked`);
   * located via its "Backend" row group inside the settings region.
   */
  private backendTrigger(): Locator {
    return this.panel().getByRole('group', { name: 'Backend', exact: true }).getByRole('button')
  }

  /**
   * Backend labels offered by the picker (e.g. 'llamaCPP - GGUF', 'OpenVINO'), or an
   * empty list when the preset is locked to one backend / the picker isn't shown.
   * Opens and closes the dropdown without changing the selection.
   */
  async availableBackends(): Promise<string[]> {
    const trigger = this.backendTrigger()
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
   * trigger's label reflects the active backend). Must be called with the Inferencing
   * tab shown. Switching backend can kick off a backend (re)start, so callers
   * should let the app settle (and resolve any model-download dialog) before sending.
   */
  async selectBackend(label: string): Promise<void> {
    const trigger = this.backendTrigger()
    await trigger.click()
    const menu = this.page.getByRole('menu')
    await menu.getByRole('menuitem', { name: label, exact: true }).click()
    await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
    await expect(trigger).toContainText(label, { timeout: 15_000 })
  }

  /**
   * The chat "Device" (inference hardware) picker trigger — a DropDownNew button in the
   * "Device" label row (SettingsChatInferencing.vue). Shown for local backends; Cloud Mode swaps
   * it for a Provider picker, so it's absent there.
   */
  private deviceTrigger(): Locator {
    return this.panel().getByRole('group', { name: 'Device', exact: true }).getByRole('button')
  }

  /**
   * Inference-device labels offered by the chat "Device" picker (e.g. "GPU.0: Intel…",
   * "NPU: Intel(R) AI Boost", "CPU"), or an empty list when no device picker is shown
   * (cloud backend, or a backend with no selectable device). Opens and closes the
   * dropdown without changing the selection.
   */
  async availableDevices(): Promise<string[]> {
    const trigger = this.deviceTrigger()
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
   * (case-insensitive) — e.g. "NPU". Must be called with the Inferencing tab shown.
   * Switching device restarts the backend, so callers should let the app settle (and
   * resolve any model-download dialog) before sending. Returns false — selection
   * unchanged — when no device matches or no device picker is shown.
   */
  async selectDeviceContaining(substring: string): Promise<boolean> {
    const trigger = this.deviceTrigger()
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
   * Switch to any inference device other than the one in use, which restarts the
   * serving backend (the device is a launch argument for both llama.cpp and OVMS).
   * That restart is the only way a test can get a model *unloaded*: nothing in the UI
   * stops a backend, and weights a running backend still holds open cannot be deleted
   * from disk on Windows. Must be called with the Inferencing tab shown. Returns false
   * — selection unchanged — when there is no device picker or no second device to move
   * to.
   */
  async selectOtherDevice(): Promise<boolean> {
    const trigger = this.deviceTrigger()
    if (!(await trigger.isVisible().catch(() => false))) return false
    const current = (await trigger.innerText()).trim()
    const other = (await this.availableDevices()).find((device) => device !== current)
    if (!other) return false
    await trigger.click()
    const menu = this.page.getByRole('menu')
    await menu.getByRole('menuitem', { name: other, exact: true }).click()
    await menu.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {})
    await expect(trigger).toContainText(other, { timeout: 30_000 })
    // `toContainText` alone would also pass if the trigger still showed the old
    // device and `other` merely happened to be a substring of it. The caller uses
    // the return value to claim the backend restarted, so only report a switch
    // once the label it is showing is genuinely no longer the original one.
    return (await trigger.innerText()).trim() !== current
  }

  /**
   * Create a custom ("designed") TTS voice from the Text-to-Speech preset's Attributes tab
   * (SettingsTtsAttributes.vue "Create a custom voice" form): fill the name + description, then
   * "Save & preview" — which synthesizes the voice's own introduction, plays it, and
   * only then saves the voice with that WAV as its preview.
   * Confirms it lands in the "Your voices" list. Saving makes the new voice the
   * active one (see `saveCurrentVoice` → `applySavedVoice`), so the next synthesis uses
   * it. Requires the Attributes tab shown with the "Text to Speech" preset active in the Audio mode.
   *
   * `expectOverwrite`: the name already exists, so saving raises the replace
   * confirmation, which this then accepts.
   *
   * `resolveDownloads`: run after the save is submitted and before waiting for it to
   * land. Voice design pulls its own weights at save time, so on a machine that
   * hasn't got them the click raises the model-download dialog and the save cannot
   * finish until it is confirmed — waiting for the form to clear first would just
   * deadlock against a dialog nobody is going to answer. The caller owns the
   * download policy (which models are acceptable, gated handling), so it passes the
   * resolver in rather than this page object reaching for one.
   */
  async createTtsVoice(opts: {
    name: string
    description: string
    expectOverwrite?: boolean
    resolveDownloads?: () => Promise<unknown>
  }): Promise<void> {
    const panel = this.panel('Attributes')
    // The form fields are the only inputs carrying these placeholders (name = "e.g.
    // Tammy", description = the "…British man…" example), so they're stable handles
    // that don't depend on label wiring.
    await panel.getByPlaceholder('e.g. Tammy').fill(opts.name)
    await panel.getByPlaceholder(/British man/).fill(opts.description)

    const save = panel.getByRole('button', { name: 'Save & preview' })
    await expect(
      save,
      'Save & preview is disabled until name + description are filled',
    ).toBeEnabled()
    await save.click()

    if (opts.expectOverwrite) {
      const dialog = this.page.getByRole('dialog', { name: 'Warning' })
      await expect(dialog, 'saving over an existing voice must ask first').toBeVisible({
        timeout: 15_000,
      })
      await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    }

    // Before the wait below, never after — the save blocks on these downloads.
    await opts.resolveDownloads?.()

    // Wait for the *save* to land, not merely for a row to exist: overwriting an
    // existing voice leaves its row on screen throughout, so a visibility check there
    // passes instantly and lets the caller race ahead while the preview is still being
    // synthesized -- which then clones the previous recording. The form is cleared only
    // by a successful save (`resetVoiceForm`), so an empty name field is the
    // unambiguous signal, and an idle button confirms the synthesis finished.
    await expect(
      panel.getByPlaceholder('e.g. Tammy'),
      'the create-voice form is cleared once the save completes',
    ).toHaveValue('', { timeout: 10 * 60_000 })
    // Not `toBeEnabled` on the button: clearing the form is what disables it (the save
    // needs a name and a description). Its *label* is the busy indicator, and the
    // locator above already matches on the idle one.

    // Saved voices render in the "Your voices" list; our new one proves the save landed.
    // Match the name exactly and take the first hit: the active-voice dropdown also shows
    // it (as "<name> (your voice)"), so a loose match would be ambiguous under strict mode.
    await expect(
      panel.getByText(opts.name, { exact: true }).first(),
      'the newly created voice should appear in the "Your voices" list',
    ).toBeVisible({ timeout: 30_000 })
  }

  /** The seed field on the create/edit-voice form (the shared RandomNumber row). */
  private ttsSeedGroup(): Locator {
    return this.panel('Attributes').getByRole('group', { name: 'Seed', exact: true })
  }

  private ttsSeedInput(): Locator {
    return this.ttsSeedGroup().getByRole('textbox', { name: 'Seed', exact: true })
  }

  /** Read the seed currently on the create/edit-voice form. */
  async ttsSeed(): Promise<string> {
    return (await this.ttsSeedInput().inputValue()).trim()
  }

  /** Set the seed on the create/edit-voice form, pinning which speaker is drawn. */
  async setTtsSeed(seed: number): Promise<void> {
    await this.ttsSeedInput().fill(String(seed))
    await expect(this.ttsSeedInput()).toHaveValue(String(seed))
  }

  /** Roll a different speaker for the same description (the seed row's dice). */
  async rollTtsSeed(): Promise<string> {
    const before = await this.ttsSeed()
    await this.ttsSeedGroup().getByRole('button', { name: 'Regenerate' }).click()
    await expect.poll(() => this.ttsSeed(), { timeout: 10_000 }).not.toEqual(before)
    return this.ttsSeed()
  }

  /** A saved voice's row in the "Your voices" list. */
  private savedVoiceRow(name: string): Locator {
    return this.panel('Attributes').getByRole('listitem', { name, exact: true })
  }

  /** Play a saved voice's stored preview (no synthesis). */
  async playSavedTtsVoice(name: string): Promise<void> {
    await this.savedVoiceRow(name)
      .getByRole('button', { name: `Play ${name}` })
      .click()
  }

  /** Whether a saved voice offers playback — i.e. it has a stored preview WAV. */
  async savedTtsVoiceHasPreview(name: string): Promise<boolean> {
    return this.savedVoiceRow(name)
      .getByRole('button', { name: `Play ${name}` })
      .isEnabled()
  }

  /** Load a saved voice back into the create/edit form. */
  async editSavedTtsVoice(name: string): Promise<void> {
    await this.savedVoiceRow(name)
      .getByRole('button', { name: `Edit ${name}` })
      .click()
    await expect(this.panel('Attributes').getByPlaceholder('e.g. Tammy')).toHaveValue(name)
  }

  /**
   * The "Voice" picker in the Text-to-Speech attributes (SettingsTtsAttributes.vue): its row
   * is a group named exactly "Voice", so it can't drift onto the "Your voices" list.
   */
  private ttsVoiceTrigger(): Locator {
    return this.panel('Attributes')
      .getByRole('group', { name: 'Voice', exact: true })
      .getByRole('button')
  }

  /**
   * Select an entry from the "Voice" picker — a built-in speaker (listed as
   * "Ryan — English") or a saved one ("Tammy (your voice)"). Pass a regex to match a
   * prefix. Requires the Attributes tab shown with the "Text to Speech" preset active in the Audio mode.
   */
  async selectTtsVoice(label: string | RegExp): Promise<void> {
    await this.selectFromPicker(this.ttsVoiceTrigger(), label)
  }

  /**
   * The Text-to-Speech engine ("Model") picker trigger in SettingsTtsInferencing. It's the only
   * dropdown whose label shows the current engine, so we locate it by that text
   * ("Qwen TTS" or "Kokoro …") rather than by the ambiguous "Model" row label (the
   * fallback-endpoint form also has a "Model" field).
   */
  private ttsEngineTrigger(): Locator {
    return this.panel()
      .getByRole('button')
      .filter({ hasText: /Qwen TTS|Kokoro/ })
      .first()
  }

  /**
   * Select the Text-to-Speech engine ("Qwen TTS" or "Kokoro (OpenVINO)") from the
   * Text-to-Speech preset's Model dropdown. Requires the Inferencing tab shown with
   * the "Text to Speech" preset active. The trigger's label reflects the choice once
   * it lands.
   */
  async selectTtsEngine(label: string): Promise<void> {
    await this.selectFromPicker(this.ttsEngineTrigger(), label)
  }

  /** Open a dropdown trigger, pick the entry matching `label`, and wait for the
   *  trigger's own label to reflect the choice. */
  private async selectFromPicker(trigger: Locator, label: string | RegExp): Promise<void> {
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
  async deleteTtsVoiceIfPresent(name: string): Promise<void> {
    const row = this.savedVoiceRow(name)
    if ((await row.count()) === 0) return
    await row
      .first()
      .getByRole('button', { name: `Delete ${name}` })
      .click()
    await expect(row, `saved voice "${name}" should be gone after Delete`).toHaveCount(0)
  }

  /**
   * Set the active preset's context size. The preset ships the size its preferred
   * model is tuned for, which a smaller model on a smaller GPU cannot allocate a KV
   * cache for — llama.cpp then refuses to load with "not enough memory to run … with
   * a context size of N", and the turn dies before it starts. Must be called with
   * the Inferencing tab shown.
   *
   * Returns false — nothing set — when the panel offers no context size at all.
   * That is not a fault: the control is gated on `contextSizeSettingSupported`, and
   * OpenVINO on a GPU sizes its KV cache dynamically from free VRAM rather than from
   * a fixed setting, so there is no input to fill and no oversized allocation to
   * guard against either. Only llama.cpp (and OpenVINO on the NPU) render one.
   */
  async setContextSize(tokens: number): Promise<boolean> {
    const input = this.panel().getByLabel('Context Size')
    // Wait briefly rather than probing with a bare isVisible(): the row renders a
    // beat after a backend switch, so an immediate check would race the re-render
    // and report "unsupported" for a backend that does support it.
    try {
      await input.waitFor({ state: 'visible', timeout: 5_000 })
    } catch {
      return false
    }
    await input.fill(String(tokens))
    // v-model writes on input, but the store clamps to the model's ceiling, so read
    // back rather than assuming the typed value stuck.
    await expect(input).not.toHaveValue('')
    return true
  }

  /**
   * The reset control every settings panel carries, "Reset <preset> to default" — the
   * Session's reset, or the fallback when the Session does not hold the preset. Audio
   * adds a "Reset <preset> speech settings to default" below it, hence the first match.
   */
  private resetButton(): Locator {
    return this.panel()
      .getByRole('button', { name: /^Reset .+ to default$/ })
      .first()
  }

  /**
   * Drop everything saved for the active preset and reload its shipped defaults —
   * backend, model (its `preferredModels` for whichever backend the reload lands
   * on, when that model is installed), context size, max tokens, tool selection.
   *
   * Must be called with the Inferencing tab shown. Returns false when the panel offers no
   * reset (the Audio panel only renders one for the TTS/STT presets), so a caller
   * driving another preset there isn't failed for it.
   */
  async resetPresetDefaults(): Promise<boolean> {
    const button = this.resetButton()
    if (!(await button.isVisible().catch(() => false))) return false
    await button.click()
    return true
  }

  /** Back to the Viewport tab, leaving the prompt area in view. */
  async close(): Promise<void> {
    await showSessionTab(this.page, 'Viewport')
  }
}
