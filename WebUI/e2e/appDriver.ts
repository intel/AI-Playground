import { type Page, test, expect } from '@playwright/test'
import path from 'path'
import { SetupWizardPage } from './pages/SetupWizardPage'
import { AppShellPage } from './pages/AppShellPage'
import { MainPage, type ChatMode } from './pages/MainPage'
import { SpecificSettingsPage } from './pages/SpecificSettingsPage'
import { DownloadDialogPage } from './pages/DownloadDialogPage'
import { McpSettingsPage } from './pages/McpSettingsPage'
import { ToolSettingsPage } from './pages/ToolSettingsPage'
import { setRekaToggle, settingsRegion } from './pages/uiControls'
import { BACKENDS, BACKEND_DISPLAY_NAMES } from './backends'

/** The chat preset that puts the assistant in agentic mode (built-in + MCP tools on). */
const AGENTIC_PRESET = 'Assistant'

/** The preset the Home Agent runs its channel turns on (its own agentic preset,
 *  distinct from "Assistant"; see modes/base/presets/home-agent-chat.json). */
const HOME_AGENT_PRESET = 'Home Agent'

const FIXTURES_DIR = path.join(__dirname, 'fixtures')
/** A real 768x512 PNG used as the input for edit / image-to-video / reference presets. */
export const FIXTURE_IMAGE = path.join(FIXTURES_DIR, 'input.png')
/** A small text document used as the RAG source for the "Assistant" preset's RAG flow. */
export const FIXTURE_DOC = path.join(FIXTURES_DIR, 'sample.txt')
/** Same fact as {@link FIXTURE_DOC} but as a PDF, to cover the PDF ingestion path. */
export const FIXTURE_DOC_PDF = path.join(FIXTURES_DIR, 'sample.pdf')

/** What kind of media a ComfyUI preset is expected to produce. */
export type ComfyOutput = 'image' | 'video' | 'model3d'

/**
 * High-level entry point for the e2e suite. Every test starts with
 * `await app.installAllBackends()`, which brings the app to a running state with
 * all backends installed and up to date, whether starting fresh (Setup Wizard
 * shown) or from a previous run (app already running).
 */
export class AppDriver {
  readonly wizard: SetupWizardPage
  readonly shell: AppShellPage
  readonly main: MainPage
  readonly settings: SpecificSettingsPage
  readonly downloads: DownloadDialogPage
  readonly mcp: McpSettingsPage
  readonly tools: ToolSettingsPage

  constructor(private readonly window: Page) {
    this.wizard = new SetupWizardPage(window)
    this.shell = new AppShellPage(window)
    this.main = new MainPage(window)
    this.settings = new SpecificSettingsPage(window)
    this.downloads = new DownloadDialogPage(window)
    this.mcp = new McpSettingsPage(window)
    this.tools = new ToolSettingsPage(window)
  }

  /**
   * Install every backend (no Home Agent), then verify via the settings menu that
   * each is at its pinned version — updating any that are not. Idempotent: on a
   * machine where backends are already installed the wizard is skipped and only
   * the verification runs.
   */
  async installAllBackends(): Promise<void> {
    await test.step('Install all backends and reach the running app', async () => {
      const startedOnWizard = await this.waitForWizardOrRunning()

      if (startedOnWizard) {
        await test.step('Enable all backends in the Setup Wizard (no Home Agent)', async () => {
          await this.wizard.expectVisible()
          await this.wizard.disableBackend('Home Agent')
          await this.wizard.enableAll(BACKENDS.map((b) => b.displayName))
        })

        await test.step('Install and continue to the running app', async () => {
          await this.wizard.installAndContinue()
        })
      }

      await this.shell.expectRunning()

      await test.step('Verify each backend is up to date, updating to the pinned version if not', async () => {
        await this.shell.openSetupWizard()
        await this.wizard.expectVisible()
        // Re-opening the wizard reseeds install selection and re-enables any
        // installed backend, so deactivate Home Agent again before continuing.
        await this.wizard.disableBackend('Home Agent')

        for (const backend of BACKENDS.filter((b) => b.hasVersionAction)) {
          await test.step(`Check ${backend.displayName} version`, async () => {
            // Skip backends unavailable in the current product mode (e.g. OpenVINO
            // is disabled in NVIDIA mode) — they are neither installed nor updated.
            if (!(await this.wizard.isAvailable(backend.displayName))) return
            if (await this.wizard.hasUpdateAvailable(backend.displayName)) {
              await this.wizard.updateToLatest(backend.displayName)
            }
            expect(await this.wizard.hasUpdateAvailable(backend.displayName)).toBe(false)
          })
        }

        // Re-point every preset at the default GPU so tests run on a consistent
        // device regardless of any device selections persisted from earlier runs.
        // overrideDeviceSelections() toggles the switch AND asserts it engaged (fails
        // here if the toggle silently doesn't flip); the effect is applied on commit
        // (continueOut) below. No-op where no GPU section is shown.
        await test.step('Override all preset device selections to the default GPU', async () => {
          const engaged = await this.wizard.overrideDeviceSelections()
          test.info().annotations.push({
            type: 'device-override',
            description: engaged
              ? 'toggle engaged; presets re-pointed to default GPU on commit'
              : 'no Default GPU section (no selectable GPU) — override skipped',
          })
        })

        await this.wizard.continueOut()
        await this.shell.expectRunning()
        // Leave a clean main view (the settings sidebar re-opens on return and
        // would otherwise occlude the prompt area for follow-up steps).
        await this.shell.ensureSettingsClosed()
      })
    })
  }

  /**
   * Switch to `mode` and select `preset`. Returns false (leaving the settings
   * sidebar closed) when the preset isn't offered in the current product mode —
   * either the whole mode has no presets (its prompt-area button is absent) or the
   * preset card isn't in the grid. On success the sidebar is left open so callers
   * can set preset-specific inputs (e.g. reference images) before closing it.
   */
  private async selectModeAndPreset(mode: ChatMode, preset: string): Promise<boolean> {
    if (
      !(await this.main
        .modeButton(mode)
        .isVisible()
        .catch(() => false))
    ) {
      return false
    }
    // Preset selection lives in the prompt-area quick picker (the mode button is
    // its popover trigger), not the settings sidebar. Returns false when the
    // preset isn't offered for this mode so the caller can skip.
    if (!(await this.main.selectPreset(mode, preset))) {
      return false
    }
    // Leave the mode-settings sidebar open so callers can set preset-specific
    // inputs (e.g. reference images) before closing it.
    await this.settings.open(mode)
    return true
  }

  /**
   * Drive one chat preset: select it, optionally attach a fixture (image for a
   * vision preset, document for a RAG preset), send a prompt and assert a non-empty,
   * well-formed text reply. Skips the test if the preset isn't available in the
   * current product mode.
   */
  async runChatPreset(opts: {
    preset: string
    prompt: string
    attach?: 'image' | 'document'
    /** Which RAG document format to attach when `attach === 'document'`. Defaults to txt. */
    doc?: 'txt' | 'pdf'
  }): Promise<void> {
    const available = await test.step(`Select Chat preset "${opts.preset}"`, () =>
      this.selectModeAndPreset('Chat', opts.preset))
    test.skip(!available, `Preset "${opts.preset}" is not available in this product mode`)

    // Randomly run on llama.cpp or OpenVINO when the preset offers both. OpenVINO is
    // only offered on Intel/OpenVINO product modes — in NVIDIA mode the app filters it
    // out (SettingsChat.vue), so this is a clean no-op there and the default backend
    // (llama.cpp) is used. Done while the settings sidebar is still open.
    let chosenBackend = 'default'
    const offered = await test.step('Read chat backends', () =>
      this.settings.availableBackends('Chat'))
    if (offered.includes('OpenVINO')) {
      chosenBackend = Math.random() < 0.5 ? 'OpenVINO' : 'llamaCPP - GGUF'
      await test.step(`Switch chat backend to ${chosenBackend}`, () =>
        this.settings.selectBackend(chosenBackend, 'Chat'))
    }
    test.info().annotations.push({ type: 'chat-backend', description: chosenBackend })

    await this.settings.close('Chat')

    if (opts.attach === 'image') await this.main.attachChatFile(FIXTURE_IMAGE)
    if (opts.attach === 'document') {
      await this.main.attachChatFile(opts.doc === 'pdf' ? FIXTURE_DOC_PDF : FIXTURE_DOC)
      // A RAG doc is indexed with an embedding model that may need downloading first.
      await this.resolveDownloadsOrSkip('the embedding model')
    }

    await test.step('Send prompt and expect a text reply', async () => {
      await this.main.sendPrompt(opts.prompt)
      // First use of a chat model downloads it via the same dialog.
      await this.resolveDownloadsOrSkip(`the "${opts.preset}" model`)
      // waitForAssistantAnswer waits for the turn to go idle, then asserts a reply.
      await this.main.waitForAssistantAnswer()
      expect(await this.main.lastAssistantText()).not.toEqual('')
      await this.main.assertWellFormedResponse()
    })
  }

  /**
   * Ensure the (feature-flagged, audio-only) Qwen3-TTS backend is installed. Kept
   * out of {@link installAllBackends} on purpose: it pulls a heavy TTS model that
   * only the Text-to-Speech test needs, so the other specs shouldn't pay for it.
   * Opens the wizard, enables the backend if it's offered in this product mode, and
   * installs it. Returns false (leaving the app running) when TTS isn't available —
   * the feature flag is off or the mode doesn't offer it — so the caller can skip.
   */
  async ensureTtsBackendInstalled(): Promise<boolean> {
    return test.step('Ensure the Text-to-Speech backend is installed', async () => {
      await this.shell.openSetupWizard()
      await this.wizard.expectVisible()
      // Re-opening the wizard re-enables installed backends; keep Home Agent off so
      // it doesn't divert to its setup page after install.
      await this.wizard.disableBackend('Home Agent')

      const ttsRow = BACKEND_DISPLAY_NAMES['qwen3-tts-backend']
      const available = await this.wizard.isAvailable(ttsRow)
      if (available) await this.wizard.enable(ttsRow)

      // "Install & Continue" when TTS is pending, otherwise a no-op "Continue".
      await this.wizard.installAndContinue()
      await this.shell.expectRunning()
      await this.shell.ensureSettingsClosed()
      return available
    })
  }

  /**
   * Ensure the Home Agent backend is installed and the app is running. Mirrors
   * {@link ensureTtsBackendInstalled}: {@link installAllBackends} deliberately
   * turns Home Agent OFF (it diverts to its own setup page after install), so the
   * Home-Agent specs re-enable and install it explicitly. Returns false (app left
   * running) when Home Agent isn't offered in this product mode so the caller can
   * skip.
   */
  async ensureHomeAgentBackendInstalled(): Promise<boolean> {
    return test.step('Ensure the Home Agent backend is installed', async () => {
      await this.shell.openSetupWizard()
      await this.wizard.expectVisible()
      const available = await this.wizard.isAvailable('Home Agent')
      if (available) await this.wizard.enable('Home Agent')
      // "Install & Continue" when Home Agent is pending; else a no-op "Continue".
      // Enabling Home Agent routes to its own setup page after install, so we do
      // NOT assert the running shell here — the caller (HomeAgentPage) drives the
      // setup screen next, whether we landed on it directly or on the shell.
      await this.wizard.installAndContinue()
      return available
    })
  }

  /**
   * Drive the "Text to Speech" preset end to end: select it, synthesize once with the
   * default voice, then create a custom ("designed") voice and synthesize again with
   * it — asserting a *second*, distinct audio result appears (TTS answers with an audio
   * bubble, never a text reply). The Text-to-Speech flow must always run to completion:
   * an unavailable preset or a gated model is a failure, never a skip.
   *
   * Also covers the regressions reported against this flow:
   *  - creating a voice pulls the voice-design weights at save time, so no download
   *    dialog ambushes the first synthesis with it;
   *  - Regenerate re-synthesizes instead of loading a chat model into a TTS thread;
   *  - a saved voice is reproducible — the same text comes back as the same audio,
   *    until the user deliberately re-rolls the voice.
   */
  async runTtsPreset(opts: {
    text: string
    newVoice: { name: string; description: string; text: string }
  }): Promise<void> {
    const available = await test.step('Select Chat preset "Text to Speech"', () =>
      this.selectModeAndPreset('Chat', 'Text to Speech'))
    expect(available, 'Preset "Text to Speech" must be available in this product mode').toBe(true)

    await test.step('Start from a known voice selection', async () => {
      // The app's TTS settings persist across runs (saved voices and the active
      // voice selection live in the store's persisted state), so a second run would
      // otherwise open with the custom voice a previous run created still selected —
      // making "the default voice" a designed voice, skipping the preset-speaker path
      // entirely, and turning "create a voice" into "re-save the same voice". Pin a
      // built-in speaker and drop the leftover voice so both paths are exercised.
      await this.settings.open('Chat')
      await this.settings.deleteTtsVoiceIfPresent(opts.newVoice.name)
      await this.settings.selectTtsVoice(/^Ryan\b/)
      await this.settings.close('Chat')
    })

    await test.step('Synthesize speech with the default voice', async () => {
      await this.main.sendPrompt(opts.text)
      // First synthesis may download the TTS model via the same dialog.
      await this.resolveDownloadsOrFail('the Text-to-Speech model')
      await this.main.waitForTtsAudioCount(1)
    })

    await test.step('Create a custom voice and synthesize a second audio with it', async () => {
      await this.settings.open('Chat')
      await this.settings.createTtsVoice({
        name: opts.newVoice.name,
        description: opts.newVoice.description,
      })
      // Created voices need the voice-design weights, which are different from the
      // preset speakers'. Saving the voice is what offers that download, so the
      // dialog (when the model isn't on disk yet) belongs to THIS step.
      await this.resolveDownloadsOrFail('the custom-voice Text-to-Speech model')
      await this.settings.close('Chat')

      await this.main.sendPrompt(opts.newVoice.text)
      // …and therefore the first synthesis with the new voice must not need one:
      // `resolve()` returns 'none' when no dialog shows within its window.
      expect(
        await this.downloads.resolve(),
        'the custom-voice model should already be installed by "Save voice" — synthesis must not prompt for a download',
      ).toBe('none')
      await this.main.waitForTtsAudioCount(2)
      await expect(
        this.main.assistantResponses.last(),
        'the custom-voice result should name the saved voice, not a leftover preset speaker',
      ).toContainText(opts.newVoice.name)
    })

    const beforeRegenerate = await this.main.ttsAudioFingerprint()

    await test.step('Regenerate re-synthesizes instead of loading a chat model', async () => {
      await this.main.regenerateLastTurn()
      // A TTS thread has no chat model; regenerating must never reach for one.
      expect(
        await this.downloads.resolve(),
        'regenerating a Text-to-Speech turn must not pull a chat model',
      ).toBe('none')
      // The audio turn is replaced, not appended to — still two results, the last
      // of which is audio (a text reply here would mean the LLM path ran).
      await this.main.waitForTtsAudioCount(2)
      await expect(
        this.main.ttsAudioPlayer,
        'the regenerated turn should be an audio result, not a text reply',
      ).toBeVisible({ timeout: 15_000 })
      await expect(this.main.assistantResponses.last()).toContainText(opts.newVoice.name)
      // Same voice, same text, pinned seed → the same audio back.
      expect(
        await this.main.ttsAudioFingerprint(),
        'regenerating the same text with the same saved voice should reproduce the same audio',
      ).toBe(beforeRegenerate)
    })

    await test.step('The saved voice still sounds the same on a later turn', async () => {
      await this.main.sendPrompt(opts.newVoice.text)
      expect(await this.downloads.resolve()).toBe('none')
      await this.main.waitForTtsAudioCount(3)
      expect(
        await this.main.ttsAudioFingerprint(),
        'coming back to a saved voice and synthesizing the same text again should give the same voice',
      ).toBe(beforeRegenerate)
    })

    await test.step('Re-rolling the voice draws a different speaker', async () => {
      await this.settings.open('Chat')
      await this.settings.rerollTtsVoice(opts.newVoice.name)
      await this.settings.close('Chat')

      await this.main.sendPrompt(opts.newVoice.text)
      expect(await this.downloads.resolve()).toBe('none')
      await this.main.waitForTtsAudioCount(4)
      expect(
        await this.main.ttsAudioFingerprint(),
        're-rolling a saved voice should change how it sounds (otherwise the seed never reaches synthesis)',
      ).not.toBe(beforeRegenerate)
    })
  }

  /**
   * Pin the active chat preset's backend to `label` (e.g. 'llamaCPP - GGUF', 'OpenVINO'),
   * so an agentic test runs on a known backend instead of "whichever happens to be
   * running". Returns false when that backend isn't available for the active preset in
   * the current product mode, so an optional-backend variant can skip.
   *
   * Availability: when the preset exposes a backend picker we honor its list (and select
   * `label` from it). When it doesn't (a single-backend preset, no picker), we can't
   * switch — that lone backend is llama.cpp (the universal default), so a mandatory
   * (`optional === false`) request counts as satisfied and any other as unavailable.
   */
  async selectChatBackendOrSkip(label: string, optional: boolean): Promise<boolean> {
    return test.step(`Pin chat backend: ${label}`, async () => {
      await this.settings.open('Chat')
      const offered = await this.settings.availableBackends('Chat')
      let available: boolean
      if (offered.length === 0) {
        // No picker → the preset is locked to its single (llama.cpp) backend.
        available = !optional
      } else {
        available = offered.includes(label)
        if (available) await this.settings.selectBackend(label, 'Chat')
      }
      await this.settings.close('Chat')
      return available
    })
  }

  /**
   * Open the Chat settings and select the first inference device whose label contains
   * `substring` (e.g. 'NPU'). Returns false when the active backend exposes no matching
   * device (or no device picker at all). Selecting a device restarts the backend, so
   * callers should resolve any model-download dialog before asserting the next turn.
   */
  async selectChatDeviceOrSkip(substring: string): Promise<boolean> {
    return test.step(`Select chat inference device: ${substring}`, async () => {
      await this.settings.open('Chat')
      const selected = await this.settings.selectDeviceContaining(substring, 'Chat')
      await this.settings.close('Chat')
      return selected
    })
  }

  /**
   * Assistant-on-NPU smoke: pin the OpenVINO chat backend, switch its inference device
   * to the NPU, then run a single text turn (compose a haiku) and assert a non-empty,
   * well-formed reply. Skips when OpenVINO isn't offered in this product mode or the
   * machine exposes no NPU device — NPU hardware is environment-specific. Expects the
   * agentic "Assistant" preset to already be active. (The default-GPU override applied
   * by {@link installAllBackends} is irrelevant here — the NPU device is picked after.)
   */
  async runNpuHaiku(prompt: string): Promise<void> {
    // OpenVINO (OVMS) is the only backend that exposes the NPU as an inference device.
    const pinned = await this.selectChatBackendOrSkip('OpenVINO', true)
    test.skip(!pinned, 'OpenVINO chat backend is not available in this product mode')

    const onNpu = await this.selectChatDeviceOrSkip('NPU')
    test.skip(!onNpu, 'No NPU inference device is available on this machine')

    await test.step('Compose a haiku on the NPU and expect a text reply', async () => {
      await this.main.sendPrompt(prompt)
      // Switching to the NPU restarts OpenVINO; first use may pull the model via the dialog.
      await this.resolveDownloadsOrSkip('the OpenVINO model on the NPU')
      await this.main.waitForAssistantAnswer()
      expect(await this.main.lastAssistantText()).not.toEqual('')
      await this.main.assertWellFormedResponse()
    })
  }

  /**
   * Enforce a deterministic tool selection for an agentic turn, so the model's context
   * isn't bloated by tool schemas it doesn't need. Expects the agentic "Assistant"
   * preset to already be active. `'minimal-image'` (fast smoke) enables only "Generate
   * media" with only the "Draft Image" workflow and turns MCP + all other tools off;
   * `'defaults'` (full flow) restores app defaults (all built-in tools except Capture
   * screenshot, MCP on, all workflows enabled). No-op if the tools section isn't shown.
   */
  async configureAgenticTools(profile: 'minimal-image' | 'defaults'): Promise<void> {
    await test.step(`Enforce agentic tool selection: ${profile}`, async () => {
      await this.settings.open('Chat')
      const applied =
        profile === 'minimal-image'
          ? await this.tools.applyMinimalImageTools()
          : await this.tools.applyDefaultTools()
      if (!applied) {
        test.info().annotations.push({
          type: 'tools',
          description: 'tools section not shown (model without tool calling?) — skipped',
        })
      }
      await this.settings.close('Chat')
    })
  }

  /**
   * Enforce the Home Agent's built-in tool selection so its channel turns can generate
   * media (image, edit, image-to-video). Tool/workflow enablement is stored per-preset,
   * so the "Home Agent" preset has to be active while we apply it — activate it, then
   * reuse the same "all built-in tools + every workflow" defaults the full agentic flow
   * uses. Best-effort: returns false (relying on the preset's own tool defaults, which
   * enable tools + all workflows) when the "Home Agent" preset isn't offered in this
   * product mode or the tools section isn't shown. Leaves the settings sidebar closed.
   */
  async enableHomeAgentMediaTools(): Promise<boolean> {
    return test.step('Enable media generation for the Home Agent preset', async () => {
      // Returning from the Setup Wizard (ensureHomeAgentBackendInstalled) can leave the
      // App Settings sidebar open; it overlays the main view and would intercept the
      // hover on the Chat mode button below. Close it first so selectPreset can reach it.
      await this.shell.ensureSettingsClosed()
      const active = await this.main.selectPreset('Chat', HOME_AGENT_PRESET)
      if (!active) {
        test.info().annotations.push({
          type: 'home-agent-tools',
          description: `"${HOME_AGENT_PRESET}" preset not offered here — relying on its built-in tool defaults`,
        })
        return false
      }
      await this.settings.open('Chat')
      const applied = await this.tools.applyDefaultTools()
      await this.settings.close('Chat')
      if (!applied) {
        test.info().annotations.push({
          type: 'home-agent-tools',
          description: 'tools section not shown for the Home Agent preset — relying on defaults',
        })
      }
      return applied
    })
  }

  /**
   * Give a reasoning model room to emit a real final answer instead of a reasoning-only
   * turn: raise max-new-tokens to its ceiling and turn thinking off. A heavy-context
   * agentic turn (the 'defaults' tool set fills most of the 8192 window) can otherwise
   * spend its whole output budget inside <think> and finish with an empty reply, which
   * reads as "no assistant response". Expects the Chat "Assistant" preset active; each
   * control is a best-effort no-op when the model/preset doesn't expose it.
   */
  async relaxChatGenerationBudget(): Promise<void> {
    await test.step('Raise max tokens and disable thinking for a reliable final answer', async () => {
      await this.settings.open('Chat')
      const region = settingsRegion(this.window)
      const maxTokens = region.locator('input[type="number"][max="4096"]')
      if (await maxTokens.isVisible().catch(() => false)) {
        await maxTokens.fill('4096')
      }
      const thinking = region.locator('#thinking')
      if (await thinking.isVisible().catch(() => false)) {
        await setRekaToggle(thinking, false)
      }
      await this.settings.close('Chat')
    })
  }

  /**
   * Switch to agentic mode (Chat + "Assistant" preset), enable MCP tools and connect
   * one MCP server by its mcp.json displayName (e.g. "DateTime MCP", "Blender MCP"),
   * leaving the sidebar closed and the preset active. Returns false when the preset,
   * the MCP section, or the server itself is unavailable in this environment (e.g.
   * `uvx`/network access missing) so the caller can skip rather than fail.
   */
  async connectMcpServerOrSkip(displayName: string): Promise<boolean> {
    return test.step(`Enable MCP tools and connect "${displayName}"`, async () => {
      if (!(await this.main.selectPreset('Chat', AGENTIC_PRESET))) return false
      await this.settings.open('Chat')
      const connected = await this.mcp.connectServer(displayName)
      await this.settings.close('Chat')
      return connected
    })
  }

  /**
   * Public wrapper around the model-download dialog resolver for specs that drive a
   * turn directly (e.g. the MCP specs) rather than through runChatPreset. Skips the
   * test when the model is gated/unavailable in this environment.
   */
  async resolveModelDownloadOrSkip(what: string): Promise<void> {
    await this.resolveDownloadsOrSkip(what)
  }

  /**
   * Clear the model-download dialog if it popped up for the current turn, skipping
   * the test when the required models are gated/unavailable in this environment
   * (nothing to download without Hugging Face access). No-op when no dialog shows.
   */
  private async resolveDownloadsOrSkip(what: string): Promise<void> {
    const outcome = await this.downloads.resolve()
    test.skip(
      outcome === 'blocked',
      `Skipping: ${what} is gated / unavailable without Hugging Face access in this environment`,
    )
  }

  /**
   * Like {@link resolveDownloadsOrSkip}, but FAILS the test instead of skipping when
   * the model is gated/unavailable. Used by the Text-to-Speech flow, which must always
   * run to completion in this environment — a blocked download there is a real failure,
   * not an environment gap to skip past.
   */
  private async resolveDownloadsOrFail(what: string): Promise<void> {
    const outcome = await this.downloads.resolve()
    expect(
      outcome,
      `${what} is gated / unavailable — it must be downloadable for the Text-to-Speech test`,
    ).not.toBe('blocked')
  }

  /**
   * Wait for an agentic media turn (image/video) to finish, confirming the model-
   * download dialog each time the agent opens it mid-turn. Up-front resolution can't
   * work here: unlike the direct ComfyUI flows (submit → resolve → wait), the agent
   * only opens the dialog *after* it finishes reasoning and decides to generate —
   * which can outlast the dialog's appearance window — and may open it more than
   * once in a turn (e.g. a video step pulls several models). Skips the test when a
   * required model is gated/unavailable rather than hanging on an unconfirmable
   * dialog. Throws if the turn hasn't gone idle within `timeout`.
   */
  async waitForAgenticMediaTurn(timeout: number): Promise<void> {
    const deadline = Date.now() + timeout
    // Make sure the turn started before we start polling for idle, so we don't
    // return before the agent has even begun working.
    await this.main.expectTurnStarted()
    while (Date.now() < deadline) {
      if (await this.downloads.isOpen()) {
        const outcome = await this.downloads.resolve(deadline - Date.now())
        test.skip(
          outcome === 'blocked',
          'Skipping: a model needed for this generation is gated / unavailable without Hugging Face access',
        )
        continue
      }
      if (!(await this.main.isBusy())) return
      await this.main.pause()
    }
    throw new Error(`Agentic media turn did not finish within ${timeout}ms`)
  }

  /**
   * Drive one ComfyUI preset (Image Gen / Image Edit / Video): select it, load the
   * fixture image into every reference-image slot when the preset needs one, submit,
   * and assert the expected media (image / video / 3D model) is produced without a
   * generation error. Skips the test if the preset isn't available in the current
   * product mode.
   *
   * Note: for Image Edit presets the loaded input image is itself surfaced as a
   * "Generated result", so the image-count assertion there is a liveness check (the
   * workflow ran to completion without error) rather than a strict new-output count.
   */
  async runComfyPreset(opts: {
    mode: ChatMode
    preset: string
    output: ComfyOutput
    prompt?: string
    needsImage?: boolean
    timeout: number
  }): Promise<void> {
    const available = await test.step(`Select ${opts.mode} preset "${opts.preset}"`, () =>
      this.selectModeAndPreset(opts.mode, opts.preset))
    test.skip(!available, `Preset "${opts.preset}" is not available in this product mode`)

    if (opts.needsImage) {
      await test.step('Load the fixture image into the reference-image slot(s)', async () => {
        const filled = await this.settings.attachReferenceImages(opts.mode, FIXTURE_IMAGE)
        expect(
          filled,
          'preset should expose at least one reference-image input',
        ).toBeGreaterThanOrEqual(1)
      })
    }

    await this.settings.close(opts.mode)

    await test.step(`Generate and expect ${opts.output} output`, async () => {
      await this.main.submitGeneration(opts.prompt)
      // First use of a preset downloads its models via the download dialog.
      await this.resolveDownloadsOrSkip(`the models for "${opts.preset}"`)
      await this.main.waitUntilIdle(opts.timeout)
      await this.main.assertNoGenerationError()

      const result =
        opts.output === 'image'
          ? this.main.generatedImages
          : opts.output === 'video'
            ? this.main.generatedVideos
            : this.main.generatedModels
      await expect(result.first()).toBeVisible({ timeout: 30_000 })
      expect(await result.count()).toBeGreaterThanOrEqual(1)
    })
  }

  /** Resolve once either the wizard or the running shell is on screen. */
  private async waitForWizardOrRunning(): Promise<boolean> {
    await expect(this.wizard.heading.or(this.shell.appSettingsButton)).toBeVisible({
      timeout: 120_000,
    })
    return this.wizard.isVisible()
  }
}
