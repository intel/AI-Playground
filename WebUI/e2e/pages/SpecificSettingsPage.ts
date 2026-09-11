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
   * The chat model picker's trigger (ModelSelector.vue), reached through the stable
   * `role="group"` the Model row carries (SettingsChat.vue). The trigger itself is
   * named after the current selection, and the row holds a second button — the
   * "Manage Models" gear — so it's pinned on the menu trigger's `aria-haspopup`
   * rather than on being the only button in the group.
   */
  private modelTrigger(mode: ChatMode): Locator {
    return this.panel(mode)
      .getByRole('group', { name: 'Model' })
      .locator('button[aria-haspopup="menu"]')
  }

  /**
   * Model names offered by the chat model picker (its visible labels, i.e. the file
   * name / last path segment).
   *
   * Opens and closes the dropdown without changing the selection.
   */
  async availableModels(mode: ChatMode = 'Chat'): Promise<string[]> {
    const trigger = this.modelTrigger(mode)
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
   * with the settings sidebar open.
   */
  async selectModel(label: string, mode: ChatMode = 'Chat'): Promise<void> {
    const trigger = this.modelTrigger(mode)
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
  async selectFirstOfferedModel(
    labels: readonly string[],
    mode: ChatMode = 'Chat',
  ): Promise<string> {
    const offered = await this.availableModels(mode)
    const wanted = labels.find((label) => offered.some((item) => item.includes(label)))
    expect(
      wanted,
      `none of [${labels.join(', ')}] is offered by the ${mode} model picker — it lists: ` +
        `[${offered.join(', ')}]`,
    ).toBeDefined()
    await this.selectModel(wanted!, mode)
    return wanted!
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
   * Switch to any inference device other than the one in use, which restarts the
   * serving backend (the device is a launch argument for both llama.cpp and OVMS).
   * That restart is the only way a test can get a model *unloaded*: nothing in the UI
   * stops a backend, and weights a running backend still holds open cannot be deleted
   * from disk on Windows. Must be called with the settings sidebar open. Returns false
   * — selection unchanged — when there is no device picker or no second device to move
   * to.
   */
  async selectOtherDevice(mode: ChatMode = 'Chat'): Promise<boolean> {
    const trigger = this.deviceTrigger(mode)
    if (!(await trigger.isVisible().catch(() => false))) return false
    const current = (await trigger.innerText()).trim()
    const other = (await this.availableDevices(mode)).find((device) => device !== current)
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
   * Create a custom ("designed") TTS voice from the Text-to-Speech preset's settings
   * (SettingsTts.vue "Create a custom voice" form): fill the name + description, then
   * "Save & preview" — which synthesizes the voice's own introduction, plays it, and
   * only then saves the voice with that WAV as its preview.
   * Confirms it lands in the "Your voices" list. Saving makes the new voice the
   * active one (see `saveCurrentVoice` → `applySavedVoice`), so the next synthesis uses
   * it. Requires the settings sidebar open with the "Text to Speech" preset active in the Audio mode.
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
  async createTtsVoice(
    opts: {
      name: string
      description: string
      expectOverwrite?: boolean
      resolveDownloads?: () => Promise<unknown>
    },
    mode: ChatMode = 'Audio',
  ): Promise<void> {
    const panel = this.panel(mode)
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

  /** The seed input on the create/edit-voice form (the shared RandomNumber row). */
  private ttsSeedInput(mode: ChatMode): Locator {
    return this.panel(mode).locator('.v-random .v-random-input')
  }

  /** Read the seed currently on the create/edit-voice form. */
  async ttsSeed(mode: ChatMode = 'Audio'): Promise<string> {
    return (await this.ttsSeedInput(mode).inputValue()).trim()
  }

  /** Set the seed on the create/edit-voice form, pinning which speaker is drawn. */
  async setTtsSeed(seed: number, mode: ChatMode = 'Audio'): Promise<void> {
    await this.ttsSeedInput(mode).fill(String(seed))
    await expect(this.ttsSeedInput(mode)).toHaveValue(String(seed))
  }

  /** Roll a different speaker for the same description (the seed row's dice). */
  async rollTtsSeed(mode: ChatMode = 'Audio'): Promise<string> {
    const before = await this.ttsSeed(mode)
    await this.panel(mode).locator('.v-random .v-random-btns button').first().click()
    await expect.poll(() => this.ttsSeed(mode), { timeout: 10_000 }).not.toEqual(before)
    return this.ttsSeed(mode)
  }

  /** A saved voice's row in the "Your voices" list. */
  private savedVoiceRow(name: string, mode: ChatMode): Locator {
    return this.panel(mode).locator('li').filter({ hasText: name })
  }

  /** Play a saved voice's stored preview (no synthesis). */
  async playSavedTtsVoice(name: string, mode: ChatMode = 'Audio'): Promise<void> {
    await this.savedVoiceRow(name, mode)
      .getByRole('button', { name: `Play ${name}` })
      .click()
  }

  /** Whether a saved voice offers playback — i.e. it has a stored preview WAV. */
  async savedTtsVoiceHasPreview(name: string, mode: ChatMode = 'Audio'): Promise<boolean> {
    return this.savedVoiceRow(name, mode)
      .getByRole('button', { name: `Play ${name}` })
      .isEnabled()
  }

  /** Load a saved voice back into the create/edit form. */
  async editSavedTtsVoice(name: string, mode: ChatMode = 'Audio'): Promise<void> {
    await this.savedVoiceRow(name, mode)
      .getByRole('button', { name: `Edit ${name}` })
      .click()
    await expect(this.panel(mode).getByPlaceholder('e.g. Tammy')).toHaveValue(name)
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
   * prefix. Requires the settings sidebar open with the "Text to Speech" preset active in the Audio mode.
   */
  async selectTtsVoice(label: string | RegExp, mode: ChatMode = 'Audio'): Promise<void> {
    await this.selectFromPicker(this.ttsVoiceTrigger(mode), label)
  }

  /**
   * The Text-to-Speech engine ("Model") picker trigger in SettingsTts. It's the only
   * dropdown whose label shows the current engine, so we locate it by that text
   * ("Qwen TTS" or "Kokoro …") rather than by the ambiguous "Model" row label (the
   * fallback-endpoint form also has a "Model" field).
   */
  private ttsEngineTrigger(mode: ChatMode): Locator {
    return this.panel(mode)
      .getByRole('button')
      .filter({ hasText: /Qwen TTS|Kokoro/ })
      .first()
  }

  /**
   * Select the Text-to-Speech engine ("Qwen TTS" or "Kokoro (OpenVINO)") from the
   * Text-to-Speech preset's Model dropdown. Requires the settings sidebar open with
   * the "Text to Speech" preset active. The trigger's label reflects the choice once
   * it lands.
   */
  async selectTtsEngine(label: string, mode: ChatMode = 'Audio'): Promise<void> {
    await this.selectFromPicker(this.ttsEngineTrigger(mode), label)
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
  async deleteTtsVoiceIfPresent(name: string, mode: ChatMode = 'Audio'): Promise<void> {
    const row = this.savedVoiceRow(name, mode)
    if ((await row.count()) === 0) return
    await row
      .first()
      .getByRole('button', { name: `Delete ${name}` })
      .click()
    await expect(row, `saved voice "${name}" should be gone after Delete`).toHaveCount(0)
  }

  /** Close the sidebar via its (responsive) Close button, scoped to the sidebar
   *  region so it can't match the header's window-close (X) button. */
  /**
   * Set the active preset's context size. The preset ships the size its preferred
   * model is tuned for, which a smaller model on a smaller GPU cannot allocate a KV
   * cache for — llama.cpp then refuses to load with "not enough memory to run … with
   * a context size of N", and the turn dies before it starts. Must be called with
   * the settings sidebar open.
   *
   * Returns false — nothing set — when the panel offers no context size at all.
   * That is not a fault: the control is gated on `contextSizeSettingSupported`, and
   * OpenVINO on a GPU sizes its KV cache dynamically from free VRAM rather than from
   * a fixed setting, so there is no input to fill and no oversized allocation to
   * guard against either. Only llama.cpp (and OpenVINO on the NPU) render one.
   */
  async setContextSize(tokens: number, mode: ChatMode = 'Chat'): Promise<boolean> {
    const input = this.panel(mode).getByLabel('Context Size')
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
   * The "Reset Preset Settings" control every settings panel carries (Chat, Agent,
   * Audio, workflow). Its accessible name starts with the icon's own "Reset" text,
   * hence the substring match rather than an exact one.
   */
  private resetButton(mode: ChatMode): Locator {
    return this.panel(mode).getByRole('button', { name: /Reset Preset Settings/ })
  }

  /**
   * Drop everything saved for the active preset and reload its shipped defaults —
   * backend, model (its `preferredModels` for whichever backend the reload lands
   * on, when that model is installed), context size, max tokens, tool selection.
   *
   * Must be called with the sidebar open. Returns false when the panel offers no
   * reset (the Audio panel only renders one for the TTS/STT presets), so a caller
   * driving another preset there isn't failed for it.
   */
  async resetPresetDefaults(mode: ChatMode = 'Chat'): Promise<boolean> {
    const button = this.resetButton(mode)
    if (!(await button.isVisible().catch(() => false))) return false
    await button.click()
    return true
  }

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
