import { type Page, test, expect } from '@playwright/test'
import path from 'path'
import { SetupWizardPage } from './pages/SetupWizardPage'
import { AppShellPage } from './pages/AppShellPage'
import { MainPage, type ChatMode } from './pages/MainPage'
import { AgentModePage, type GameSummary } from './pages/AgentModePage'
import { SpecificSettingsPage } from './pages/SpecificSettingsPage'
import { DownloadDialogPage } from './pages/DownloadDialogPage'
import { McpSettingsPage } from './pages/McpSettingsPage'
import { ModelManagerPage } from './pages/ModelManagerPage'
import { ToolSettingsPage } from './pages/ToolSettingsPage'
import { setRekaToggle, settingsRegion } from './pages/uiControls'
import { BACKENDS, BACKEND_DISPLAY_NAMES } from './backends'

/** The chat preset that puts the assistant in agentic mode (built-in + MCP tools on). */
const AGENTIC_PRESET = 'Assistant'

/** The general-purpose agent preset: agent harness, a folder the user picks
 *  (see modes/base/presets/agent.json). "Game Agent" is the same agent, aimed. */
const AGENT_PRESET = 'Agent'

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
  /**
   * Budget for one game-building agent turn. Well above the chat budgets: a single
   * turn here is dozens of model steps (plan, write, edit, play-test), each a full
   * generation of its own — even on the small model these tests pin.
   */
  static readonly AGENT_GAME_TIMEOUT = 30 * 60_000

  /**
   * How long {@link runAgentGamePresetBriefly} watches a turn before calling it a
   * pass. Long enough to be past model load and into the agent's own tool loop,
   * short enough that the suite doesn't stall on a full build.
   */
  static readonly AGENT_GAME_PROGRESS_WINDOW = 60_000

  /**
   * The model the game presets are pinned to, per backend, by its picker label
   * (the last path segment of the model id).
   *
   * The presets' own `preferredModels` are big — a 35B MoE on llama.cpp — because
   * they are tuned for game quality. These tests only care that a game gets built
   * at all, so they pin the smallest model that still clears both preset gates
   * (`requiresToolCalling` and `requiresCoding`): Qwen3.5-4B. That cuts the
   * download to a few GB and the turn to a fraction of the time.
   */
  private static readonly AGENT_GAME_MODEL: Record<string, string> = {
    'llamaCPP - GGUF': 'Qwen3.5-4B-Q4_K_M.gguf',
    OpenVINO: 'Qwen3.5-4B-int4-ov',
  }

  /** Context size the pinned small model is run at — see the call site for why. */
  private static readonly AGENT_GAME_CONTEXT = 32768

  /**
   * Context size the "Agent" preset is run at. Its own default is 128k, the size
   * its preferred 9B is tuned for, and that is simply more KV cache than a laptop
   * GPU has: llama.cpp refuses the load outright ("not enough memory to run … with
   * a context size of 131072"), so the turn dies in ensureReadyForInference before
   * the agent starts. 8k matches what the agentic smoke runs the Assistant preset
   * at, and is enough for the two short turns this drives.
   */
  private static readonly AGENT_CONTEXT = 8192

  readonly wizard: SetupWizardPage
  readonly shell: AppShellPage
  readonly main: MainPage
  readonly agent: AgentModePage
  readonly settings: SpecificSettingsPage
  readonly downloads: DownloadDialogPage
  readonly mcp: McpSettingsPage
  readonly models: ModelManagerPage
  readonly tools: ToolSettingsPage

  constructor(private readonly window: Page) {
    this.wizard = new SetupWizardPage(window)
    this.shell = new AppShellPage(window)
    this.main = new MainPage(window)
    this.agent = new AgentModePage(window)
    this.settings = new SpecificSettingsPage(window)
    this.downloads = new DownloadDialogPage(window)
    this.mcp = new McpSettingsPage(window)
    this.models = new ModelManagerPage(window)
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
          // Home Agent is off by default on a fresh machine, but this also runs on
          // one where a previous run installed it (which re-selects it on open).
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
    // inputs (e.g. reference images) before closing it. Reset first, so those
    // inputs are applied on top of the preset's defaults rather than on top of
    // whatever a previous run left saved for it.
    await this.resetPresetDefaults(mode)
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

    await this.pickRandomBackend('Chat')

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
   * Put the active preset back to its shipped defaults, before the test changes
   * anything of its own. Opens the mode's settings sidebar and leaves it open.
   *
   * Why every preset flow starts here: preset settings persist to disk per preset,
   * so a run inherits whatever the last one (or a hand-driven session) left behind.
   * That is how the Intel-box agentic smoke failed on llama.cpp — the Assistant
   * preset had a saved model of smollm2-1.7b, which cannot tool-call, so the tool
   * checkboxes the test wanted were hidden behind "The selected model does not
   * support tool calling" and never became visible. Resetting first makes each test
   * start from the preset as shipped rather than from the machine's history.
   *
   * One limit worth knowing: the reload applies `preferredModels` for the backend
   * it lands on — the preset's first *running* backend (textInference's
   * selectBestBackend), i.e. llama.cpp in practice. A test that then pins the other
   * backend still gets whatever model was last selected for that one. Resetting
   * after the pin would not help either: the reset re-picks the backend and would
   * undo the pin. Pin a model explicitly where the choice has to be exact.
   */
  async resetPresetDefaults(mode: ChatMode = 'Chat'): Promise<void> {
    await test.step(`Reset the ${mode} preset to its defaults`, async () => {
      await this.settings.open(mode)
      const reset = await this.settings.resetPresetDefaults(mode)
      test.info().annotations.push({
        type: 'preset-reset',
        description: reset ? `${mode}: reset to preset defaults` : `${mode}: no reset control`,
      })
    })
  }

  /**
   * Randomly run the active preset on llama.cpp or OpenVINO when it offers both,
   * so neither backend silently stops being exercised. OpenVINO is only offered in
   * Intel/OpenVINO product modes — in NVIDIA mode the app filters it out
   * (SettingsChat.vue / SettingsAgent.vue), so this is a clean no-op there and the
   * default backend (llama.cpp) is used. Must be called with `mode`'s settings
   * sidebar open; leaves it open. Returns the label it settled on, which is also
   * recorded as a test annotation so a failed run says which backend it ran on.
   */
  private async pickRandomBackend(mode: ChatMode): Promise<string> {
    let chosen = 'default'
    const offered = await test.step(`Read ${mode} backends`, () =>
      this.settings.availableBackends(mode))
    if (offered.includes('OpenVINO')) {
      chosen = Math.random() < 0.5 ? 'OpenVINO' : 'llamaCPP - GGUF'
      await test.step(`Switch ${mode} backend to ${chosen}`, () =>
        this.settings.selectBackend(chosen, mode))
    }
    test.info().annotations.push({ type: 'backend', description: `${mode}: ${chosen}` })
    return chosen
  }

  /**
   * Drive one of the game agent presets (Game Agent, Quick Coder) through its main
   * flow: select it, start a fresh game, run a single build turn on a randomly
   * chosen backend, and hand back the game folder it produced for the caller to
   * assert on.
   *
   * Both presets are co-branded on Acer systems ("Acer Game Agent"); `selectPreset`
   * keys off the unbranded `data-aipg-preset-name`, so the canonical name works
   * everywhere. Returns null when the preset isn't offered in this product mode so
   * the caller can skip.
   */
  async runAgentGamePreset(opts: { preset: string; prompt: string }): Promise<GameSummary | null> {
    const ready = await this.prepareAgentGamePreset(opts.preset)
    if (!ready) return null

    // Everything already in the library is the baseline; the turn's game is whatever
    // is there afterwards that isn't.
    const before = await this.agent.gameDirs()

    return test.step(`Build a game with "${opts.preset}"`, async () => {
      await this.startAgentTurn(opts.prompt)
      // One turn, many possible downloads: the chat model up front, and for Game
      // Agent an image model mid-turn when it draws the thumbnail. waitForAgenticMediaTurn
      // clears each dialog as it appears and returns once the turn goes idle.
      await this.waitForAgenticMediaTurn(AppDriver.AGENT_GAME_TIMEOUT)
      await this.agent.assertNoTurnError()
      return this.agent.gameCreatedSince(before)
    })
  }

  /**
   * The shorter proof for a game preset: select it, send one build request, and
   * watch the agent stay at work for {@link AGENT_GAME_PROGRESS_WINDOW}, then stop
   * the turn and hand back. Returns false when the preset isn't offered in this
   * product mode so the caller can skip.
   *
   * Why this exists next to {@link runAgentGamePreset}: a full Game Agent build is
   * dozens of model steps and runs well past half an hour on the pinned 4B model,
   * which is too long to sit in the suite. What actually regresses — preset wiring,
   * model/backend load, the agent harness starting and driving its tool loop — all
   * shows up in the first minute, so this asserts that much and no more. It does
   * NOT prove a finished game; {@link runAgentGamePreset} still does that for the
   * one-shot Quick Coder preset.
   */
  async runAgentGamePresetBriefly(opts: { preset: string; prompt: string }): Promise<boolean> {
    const ready = await this.prepareAgentGamePreset(opts.preset)
    if (!ready) return false

    await test.step(`Watch "${opts.preset}" work for ${AppDriver.AGENT_GAME_PROGRESS_WINDOW}ms`, async () => {
      await this.startAgentTurn(opts.prompt)
      const outcome = await this.watchAgenticTurn(AppDriver.AGENT_GAME_PROGRESS_WINDOW)
      // An early finish is a pass, not a failure — the turn got where it was going
      // sooner than expected. Either way the error banner decides.
      await this.agent.assertNoTurnError()
      test.info().annotations.push({
        type: 'turn',
        description:
          outcome === 'working'
            ? `still working after ${AppDriver.AGENT_GAME_PROGRESS_WINDOW}ms`
            : 'turn finished inside the observation window',
      })
      if (outcome === 'working') await this.stopTurn()
    })
    return true
  }

  /**
   * Shared first half of the game-preset flow: select the preset, pin the small
   * model on a randomly chosen backend, and start a fresh game. False when the
   * preset isn't offered in this product mode.
   */
  private async prepareAgentGamePreset(preset: string): Promise<boolean> {
    const selected = await test.step(`Select agent preset "${preset}"`, () =>
      this.main.selectPreset('Chat', preset))
    if (!selected) return false

    // Agent Mode has no mode button of its own — its sidebar is opened from the
    // prompt area like any other mode's, under the name "Agent Settings". Reset
    // before the pins below, never after: a reset would undo them.
    await this.resetPresetDefaults('Agent')

    await test.step('Start a fresh game on a randomly chosen backend', async () => {
      const backend = await this.pickRandomBackend('Agent')
      // After the backend, never before: the model list is per-backend, so a model
      // picked first would be replaced when the backend changes under it. 'default'
      // means the picker wasn't offered, which only happens on the lone llama.cpp.
      const model =
        AppDriver.AGENT_GAME_MODEL[backend] ?? AppDriver.AGENT_GAME_MODEL['llamaCPP - GGUF']
      await test.step(`Pin the small agent model: ${model}`, () =>
        this.settings.selectModel(model, 'Agent'))
      // The preset asks for 128k, the size its big preferred model is tuned for. A 4B
      // model on a laptop GPU cannot allocate a KV cache that size, and llama.cpp then
      // refuses to load the model at all — the turn dies inside ensureReadyForInference
      // before it ever starts. Still well above the 32k the panel says agentic sessions
      // want. A no-op on OpenVINO GPU, which has no such setting to get wrong.
      await test.step(`Lower the context size to ${AppDriver.AGENT_GAME_CONTEXT}`, () =>
        this.settings.setContextSize(AppDriver.AGENT_GAME_CONTEXT, 'Agent'))
      // Switching preset by hand already clears the workspace (agentMode.ts), but a
      // re-run that lands on the preset already active doesn't — so ask explicitly.
      // The folder itself is minted by the first turn.
      await expect(
        this.agent.newGameButton,
        'a game preset should manage its own folder and offer "New game"',
      ).toBeVisible({ timeout: 15_000 })
      await this.agent.newGameButton.click()
      await this.settings.close('Agent')
    })
    return true
  }

  /**
   * Send the build request and insist the turn actually starts. `generate()` can
   * throw before it ever sets `processing` — a backend that won't load the model
   * dies in ensureReadyForInference — and the busy control then never appears. The
   * turn pollers read that as "already finished" and the run sails on to assert
   * against a folder nothing was ever written to, reporting an empty index.html
   * instead of the load failure that caused it. No real build turn starts this
   * fast, so a missing busy control here is the failure itself.
   */
  private async startAgentTurn(prompt: string): Promise<void> {
    await this.main.sendPrompt(prompt)
    await expect(
      this.main.busyButton,
      'the agent turn never started — the model or backend most likely failed to load (check the app log)',
    ).toBeVisible({ timeout: 60_000 })
  }

  /**
   * Poll a running agent turn for at most `window` ms, clearing model-download
   * dialogs as they appear (the chat model up front, an image model mid-turn).
   * Returns 'working' if the turn was still running when the window ran out, or
   * 'finished' if it went idle first.
   */
  private async watchAgenticTurn(window: number): Promise<'working' | 'finished'> {
    const deadline = Date.now() + window
    while (Date.now() < deadline) {
      if (await this.downloads.isOpen()) {
        const outcome = await this.downloads.resolve(deadline - Date.now())
        test.skip(
          outcome === 'blocked',
          'Skipping: a model needed for this generation is gated / unavailable without Hugging Face access',
        )
        continue
      }
      if (!(await this.main.isBusy())) return 'finished'
      await this.main.pause()
    }
    return 'working'
  }

  /**
   * Cut a running turn short: press the busy (Stop) control and wait for the app to
   * settle. Best-effort — a turn that ends on its own between the check and the
   * click leaves nothing to press — but worth doing, so the app isn't mid-inference
   * when the fixture closes it.
   */
  private async stopTurn(timeout = 60_000): Promise<void> {
    await test.step('Stop the turn', async () => {
      await this.main.busyButton.click({ timeout: 10_000 }).catch(() => {})
      await expect(this.main.busyButton).toBeHidden({ timeout })
    })
  }

  /**
   * Drive the general-purpose "Agent" preset through the same two turns the fast
   * agentic smoke runs on the Assistant preset: write a haiku, then turn it into an
   * image. The preset keeps its own defaults — its model per backend, its default
   * capabilities (media + web-debug) — so this covers it close to how it ships. Two
   * things are chosen for it: the backend, at random like the other preset specs,
   * and the context size, cut to {@link AGENT_CONTEXT} because the shipped 128k
   * cannot be allocated on a laptop GPU and the model then refuses to load at all
   * (where the backend exposes a context size at all — OpenVINO on GPU does not).
   *
   * Unlike the game presets, this one works in a folder the *user* picks, so the
   * caller passes a scratch directory (and stubs the native picker at it — see
   * `stubDirectoryPicker`). The agent writes into that folder; nothing here asserts
   * on its contents, the transcript and the generated image are the subject.
   *
   * Returns false when the preset isn't offered in this product mode so the caller
   * can skip.
   */
  async runAgentPreset(opts: {
    workspaceDir: string
    prompt: string
    imagePrompt: string
  }): Promise<boolean> {
    const selected = await test.step(`Select agent preset "${AGENT_PRESET}"`, () =>
      this.main.selectPreset('Chat', AGENT_PRESET))
    if (!selected) return false

    // Reset before the context size below, never after — a reset would undo it.
    await this.resetPresetDefaults('Agent')

    await test.step('Point the agent at a scratch workspace on a random backend', async () => {
      await this.pickRandomBackend('Agent')
      // A no-op on OpenVINO GPU, which has no such setting to get wrong.
      await test.step(`Lower the context size to ${AppDriver.AGENT_CONTEXT}`, () =>
        this.settings.setContextSize(AppDriver.AGENT_CONTEXT, 'Agent'))
      await this.agent.selectWorkspaceFolder(opts.workspaceDir)
      await this.settings.close('Agent')
    })

    let imagesBefore = 0

    await test.step('Prompt 1: write a haiku → expect a reply', async () => {
      // startAgentTurn insists the turn actually starts: a model that won't load
      // dies in ensureReadyForInference and never raises the busy control, which
      // would otherwise surface much later as "the agent produced no image".
      await this.startAgentTurn(opts.prompt)
      // The preset's default model is pulled on first use, via the same download
      // dialog the turn poller clears. Agent Mode renders its own transcript (no
      // "Assistant reply" region for MainPage to read), so the reply is asserted as
      // transcript text rather than through waitForAssistantAnswer.
      await this.waitForAgenticMediaTurn(MainPage.TEXT_TIMEOUT)
      await this.agent.assertNoTurnError()
      expect(
        await this.agent.transcriptText(),
        'the agent turn finished but put nothing on screen',
      ).not.toEqual('')
      // The agent may generate media unprompted on the text turn, so the image turn
      // asserts it ADDED an image rather than that this was zero.
      imagesBefore = await this.main.generatedImages.count()
    })

    await test.step('Prompt 2: turn the haiku into an image → expect an image', async () => {
      await this.startAgentTurn(opts.imagePrompt)
      await this.waitForAgenticMediaTurn(MainPage.IMAGE_TIMEOUT)
      await this.agent.assertNoTurnError()
      await this.main.assertNoGenerationError()
      expect(await this.main.generatedImages.count()).toBeGreaterThan(imagesBefore)
    })

    return true
  }

  /**
   * Ensure the audio-only Qwen3-TTS backend is installed. Kept out of
   * {@link installAllBackends} on purpose: it pulls a heavy TTS model that only the
   * Text-to-Speech test needs, so the other specs shouldn't pay for it. Opens the
   * wizard, expands Core Services (which owns the speech rows), enables the
   * backend if it's offered in this product mode, and installs it. Returns false
   * (leaving the app running) when TTS isn't available so the caller can skip.
   */
  async ensureTtsBackendInstalled(): Promise<boolean> {
    return test.step('Ensure the Text-to-Speech backend is installed', async () => {
      await this.shell.openSetupWizard()
      await this.wizard.expectVisible()
      // Re-opening the wizard re-enables installed backends; keep Home Agent off so
      // it doesn't divert to its setup page after install.
      await this.wizard.disableBackend('Home Agent')
      // The speech sidecars are nested under Core Services and collapsed on open.
      await this.wizard.expandCoreServices()

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
   *    until the user deliberately changes its seed. Identity is held by cloning the
   *    voice's preview recording, not by the seed, which only fixes the draw at save
   *    time (see QWEN3_TTS_MODEL_REPOS.voiceClone).
   */
  async runTtsPreset(opts: {
    text: string
    newVoice: { name: string; description: string; text: string }
  }): Promise<void> {
    const available = await test.step('Select Audio preset "Text to Speech"', () =>
      this.selectModeAndPreset('Audio', 'Text to Speech'))
    expect(available, 'Preset "Text to Speech" must be available in this product mode').toBe(true)

    await this.resetPresetDefaults('Audio')

    await test.step('Start from a known voice selection', async () => {
      // The app's TTS settings persist across runs (saved voices and the active
      // voice selection live in the store's persisted state), so a second run would
      // otherwise open with the custom voice a previous run created still selected —
      // making "the default voice" a designed voice, skipping the preset-speaker path
      // entirely, and turning "create a voice" into "re-save the same voice". Pin a
      // built-in speaker and drop the leftover voice so both paths are exercised.
      await this.settings.open('Audio')
      await this.settings.deleteTtsVoiceIfPresent(opts.newVoice.name)
      await this.settings.selectTtsVoice(/^Ryan\b/)
      await this.settings.close('Audio')
    })

    await test.step('Synthesize speech with the default voice', async () => {
      await this.main.sendPrompt(opts.text)
      // First synthesis may download the TTS model via the same dialog.
      await this.resolveDownloadsOrFail('the Text-to-Speech model')
      await this.main.waitForTtsAudioCount(1)
    })

    await test.step('Create a custom voice and synthesize a second audio with it', async () => {
      await this.settings.open('Audio')
      // A created voice needs two checkpoints that the preset speakers don't: voice
      // design invents it, and the Base model clones it for everything it says later.
      // Saving is what offers both downloads, so those dialogs belong to THIS step —
      // and they have to be cleared *while* the save is in flight, since the save is
      // what is blocked on them.
      await this.settings.createTtsVoice({
        name: opts.newVoice.name,
        description: opts.newVoice.description,
        resolveDownloads: () =>
          this.resolveDownloadSequenceOrFail('the custom-voice Text-to-Speech models'),
      })

      // "Save & preview" generated an introduction and kept it, so the card can be
      // played back without another synthesis.
      expect(
        await this.settings.savedTtsVoiceHasPreview(opts.newVoice.name),
        'a voice saved via "Save & preview" should offer playback of its stored preview',
      ).toBe(true)
      await this.settings.playSavedTtsVoice(opts.newVoice.name)
      expect(
        await this.downloads.resolve(),
        'playing a stored preview must not synthesize (and so never prompt for a model)',
      ).toBe('none')
      await this.settings.close('Audio')

      await this.main.sendPrompt(opts.newVoice.text)
      // …and therefore the first synthesis with the new voice must not need one:
      // `resolve()` returns 'none' when no dialog shows within its window.
      expect(
        await this.downloads.resolve(),
        'the custom-voice model should already be installed by "Save & preview" — synthesis must not prompt for a download',
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

    await test.step('Editing a voice loads it back into the form', async () => {
      await this.settings.open('Audio')
      await this.settings.editSavedTtsVoice(opts.newVoice.name)
      // Edit restores the whole voice, seed included — that is what makes the saved
      // speaker adjustable instead of only replaceable.
      expect(
        await this.settings.ttsSeed(),
        'editing a saved voice should load its pinned seed, not a fresh one',
      ).toMatch(/^\d+$/)
      await this.settings.close('Audio')
    })

    await test.step('Re-saving with a new seed draws a different speaker', async () => {
      await this.settings.open('Audio')
      await this.settings.editSavedTtsVoice(opts.newVoice.name)
      await this.settings.rollTtsSeed()
      // Same name → the save must ask before replacing the existing voice.
      await this.settings.createTtsVoice({
        name: opts.newVoice.name,
        description: opts.newVoice.description,
        expectOverwrite: true,
      })
      await this.settings.close('Audio')

      await this.main.sendPrompt(opts.newVoice.text)
      expect(await this.downloads.resolve()).toBe('none')
      await this.main.waitForTtsAudioCount(4)
      expect(
        await this.main.ttsAudioFingerprint(),
        'a re-seeded voice should sound different (otherwise the seed never reaches synthesis)',
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
   * agentic turn (the 'defaults' tool set fills a large part of the window) can otherwise
   * spend its whole output budget inside <think> and finish with an empty reply, which
   * reads as "no assistant response". Expects the Chat "Assistant" preset active; each
   * control is a best-effort no-op when the model/preset doesn't expose it.
   */
  async relaxChatGenerationBudget(): Promise<void> {
    await test.step('Raise max tokens and disable thinking for a reliable final answer', async () => {
      await this.settings.open('Chat')
      const region = settingsRegion(this.window)
      const maxTokens = region.getByLabel('Max Tokens')
      if (await maxTokens.isVisible().catch(() => false)) {
        await maxTokens.fill('32768')
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
   * Resolve every download dialog that appears back-to-back. Creating a custom voice
   * pulls two checkpoints — voice design to invent the voice, the Base model to clone
   * it afterwards — so it raises one dialog after another and a single resolve would
   * leave the second one hanging.
   */
  private async resolveDownloadSequenceOrFail(what: string): Promise<number> {
    let resolved = 0
    // Bounded rather than `while (true)`: a dialog that keeps reappearing is a bug we
    // want to surface as a failure, not spin on.
    for (let i = 0; i < 4; i++) {
      const outcome = await this.downloads.resolve()
      expect(
        outcome,
        `${what} is gated / unavailable — it must be downloadable for the Text-to-Speech test`,
      ).not.toBe('blocked')
      if (outcome === 'none') return resolved
      resolved++
    }
    return resolved
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
