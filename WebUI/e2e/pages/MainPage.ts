import { type Locator, type Page, expect } from '@playwright/test'
import { reportingAppErrors } from '../appErrors'

/**
 * Prompt-area mode labels (accessible names of the mode buttons), which are also
 * what the mode's settings sidebar is named after ("<Mode> Settings").
 *
 * 'Agent' is settings-only: Agent Mode has no mode button of its own — it is
 * entered by picking an agent preset from the Chat button's quick picker (see
 * `presetModes.ts`), and only its sidebar carries the name.
 */
export type ChatMode = 'Chat' | 'Agent' | 'Audio' | 'Image Gen' | 'Image Edit' | 'Video'

/**
 * Page object for the running main view: the prompt area (mode switch, prompt
 * input, send) and the chat/agentic result panel (text replies, generated
 * images/videos).
 */
export class MainPage {
  constructor(private readonly page: Page) {}

  // Generous per-turn budgets: the default chat model (Qwen3.5-9B) is a reasoning
  // model whose thinking alone can run for minutes, and image/video generation on
  // local hardware runs longer still. These bound a single turn *after* any model
  // download has been handled separately (see DownloadDialogPage).
  static readonly TEXT_TIMEOUT = 8 * 60_000
  static readonly IMAGE_TIMEOUT = 8 * 60_000
  static readonly VIDEO_TIMEOUT = 15 * 60_000

  get promptInput(): Locator {
    return this.page.getByRole('textbox', { name: 'Prompt' })
  }

  /** Visible only when idle; replaced by a Stop button while a turn is running. */
  get sendButton(): Locator {
    return this.page.getByRole('button', { name: 'Send' })
  }

  /**
   * The busy control shown in place of Send while a turn runs. It stays up for
   * the WHOLE turn — backend/model load, "Processing prompt…", reasoning, tool
   * calls and generation — and is the app's single source of truth for "busy",
   * so tests gate on it rather than guessing from partial signals (reasoning
   * done, first text token, etc.). Matches both the active "Stop generating"
   * button and the transient disabled "Stopping" button.
   */
  get busyButton(): Locator {
    return this.page
      .getByRole('button', { name: 'Stop generating' })
      .or(this.page.getByRole('button', { name: 'Stopping' }))
  }

  /**
   * Completed image results. Covers both surfaces: the agentic chat tool card and
   * the direct Image Gen / Image Edit panel — both tag their output image
   * `alt="Generated result"`.
   */
  get generatedImages(): Locator {
    return this.page.getByRole('img', { name: 'Generated result' })
  }

  /** Generated video result(s), in either the chat panel or the direct Video panel. */
  get generatedVideos(): Locator {
    return this.page.locator('video')
  }

  /** Generated 3D model result (the Image To 3D Model preset), tagged via aria-label. */
  get generatedModels(): Locator {
    return this.page.getByLabel('Generated 3D model')
  }

  /**
   * The <audio> player rendered by ChatTtsToolResult in the last assistant turn. It
   * appears only once synthesis succeeds AND the saved WAV has been loaded into a
   * playback source (before that the bubble shows "Loading audio…"), so its presence
   * is a strong success signal for a Text-to-Speech turn.
   */
  get ttsAudioPlayer(): Locator {
    return this.assistantResponses.last().locator('audio')
  }

  /**
   * Every rendered TTS `<audio>` player across the whole conversation — one per
   * successful synthesis. Used to prove a *second* Text-to-Speech turn produced a
   * new audio bubble rather than the first one lingering.
   */
  get ttsAudioPlayers(): Locator {
    return this.assistantResponses.locator('audio')
  }

  /**
   * The "Regenerate" control on the last assistant turn (Chat.vue renders it only
   * for the final message). Re-runs that turn: another LLM answer for a chat
   * thread, another synthesis for a Text-to-Speech thread.
   */
  get regenerateButton(): Locator {
    return this.page.getByRole('button', { name: 'Regenerate' }).last()
  }

  /** Re-run the last assistant turn and wait for it to start. */
  async regenerateLastTurn(): Promise<void> {
    await expect(this.regenerateButton).toBeVisible({ timeout: 15_000 })
    await this.regenerateButton.click()
    await this.expectTurnStarted()
  }

  /**
   * Fingerprint of a rendered TTS result's audio — the player's `src` is a data URI
   * holding the whole WAV, so equal fingerprints mean byte-identical audio.
   * `index` counts from the end when negative (-1 = the most recent result).
   *
   * Used to prove a saved voice is reproducible: the same text spoken by the same
   * saved voice must come back identical, because the voice's seed is pinned
   * (`ttsVoiceSeed.ts` → `/api/synthesize` `seed` → `torch.manual_seed`). Hashed
   * in-page (djb2 over the data URI, prefixed with its length) so multi-MB WAVs
   * aren't shipped across the CDP bridge.
   */
  async ttsAudioFingerprint(index: number = -1): Promise<string> {
    const players = this.ttsAudioPlayers
    const count = await players.count()
    const target = players.nth(index < 0 ? count + index : index)
    await expect(target, 'expected a rendered TTS audio player to fingerprint').toBeVisible({
      timeout: 15_000,
    })
    return target.evaluate((el) => {
      const src = (el as HTMLAudioElement).getAttribute('src') ?? ''
      let hash = 5381
      for (let i = 0; i < src.length; i++) {
        hash = ((hash * 33) ^ src.charCodeAt(i)) >>> 0
      }
      return `${src.length}:${hash.toString(16)}`
    })
  }

  /**
   * The prompt-area attachment file input (the "+" control). Present only when the
   * active preset allows an attachment: a vision chat model (image) or a RAG preset
   * (document). Used for chat-mode attachments; ComfyUI reference images are set in
   * the settings sidebar instead (see {@link SpecificSettingsPage.attachReferenceImages}).
   */
  get chatAttachmentInput(): Locator {
    return this.page.getByLabel('Attach image or document')
  }

  /** Attach a file (image or document) to the next chat turn via the "+" control. */
  async attachChatFile(filePath: string): Promise<void> {
    await this.chatAttachmentInput.waitFor({ state: 'attached', timeout: 60_000 })
    await this.chatAttachmentInput.setInputFiles(filePath)
  }

  get assistantResponses(): Locator {
    return this.page.getByRole('article', { name: 'Assistant response' })
  }

  /**
   * The rendered final text answer(s) of the last assistant turn. Scoped to the
   * "Assistant reply" region(s) so it excludes the collapsible reasoning trace —
   * whose "Reasoning for …" / "Done Reasoning …" status line otherwise leaks into
   * the article's text and makes a bare non-empty check pass on reasoning alone,
   * before the model has actually replied.
   */
  get assistantAnswer(): Locator {
    return this.assistantResponses.last().getByRole('region', { name: 'Assistant reply' })
  }

  /**
   * Error surfaced by the app when a generation/tool turn fails.
   *
   * Three shapes, because they come from different places. "Generation failed" / "An
   * error occurred" are the app's own copy for a failed media step or an opaque
   * fault. `HTTP <status>:` is what `describeInferenceError` builds when the local
   * inference backend refuses the request outright and the app toasts the status
   * plus the response body — e.g. an OVMS 400 whose body says the prompt plus
   * max_tokens exceeds the model's max length. Matching only the first shape let a
   * hard backend refusal read as the model simply having declined to answer.
   *
   * "Text To Speech failed" is the third: a synthesis that dies in the sidecar is
   * recorded in the transcript as a failed tool result rather than as either of the
   * above, and unlike a toast it stays on screen for the whole run.
   */
  get generationError(): Locator {
    return this.page.getByText(
      /Generation failed|An error occurred|Text To Speech failed|HTTP \d{3}:/i,
    )
  }

  /** Throw with the app's error text if a generation error is on screen. */
  async assertNoGenerationError(): Promise<void> {
    if (
      await this.generationError
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      const message = (
        await this.generationError
          .first()
          .innerText()
          .catch(() => '')
      ).trim()
      throw new Error(`App reported a generation error: "${message || 'unknown error'}"`)
    }
  }

  /** The collapsible "reasoning" trace toggle(s) in the last assistant turn. */
  get reasoningBlocks(): Locator {
    return this.assistantResponses.last().getByRole('button', { name: /Reasoning/i })
  }

  /**
   * Assert the last assistant turn rendered cleanly, not in the malformed shapes
   * we've hit: the reasoning trace duplicated into several "Reasoning…" pills,
   * or a tool card that never resolved its preset and shows the "unknown"
   * fallback. A malformed turn can still "pass" the image/video count checks, so
   * these are asserted explicitly.
   */
  async assertWellFormedResponse(): Promise<void> {
    const reasoningCount = await this.reasoningBlocks.count()
    expect(
      reasoningCount,
      'the reasoning trace should render as a single aggregated block, not be duplicated',
    ).toBeLessThanOrEqual(1)

    const text = await this.assistantResponses.last().innerText()
    expect(
      text,
      'a tool card should resolve to a real preset, never the "unknown" fallback',
    ).not.toMatch(/using the preset\s+unknown/i)
  }

  modeButton(label: ChatMode): Locator {
    return this.page.getByRole('button', { name: label, exact: true })
  }

  /**
   * A preset thumbnail inside the prompt-area quick-preset picker popover, keyed
   * by the preset's canonical name.
   *
   * Deliberately NOT the accessible name: that is `oemBranding.presetLabel()`,
   * which prefixes the co-branded presets on Acer systems ("Acer Game Agent"), so
   * a test looking one up by name would find nothing on exactly the hardware the
   * preset ships on. `data-aipg-preset-name` is the unbranded name. Only the open
   * picker is mounted, so this stays unambiguous across modes.
   */
  private presetCard(name: string): Locator {
    return this.page.locator(`[data-aipg-preset-name="${name}"]`)
  }

  /** The active-preset indicator at the top-left of the input. Its accessible
   *  name is `Active preset: <name>` (a live `status` region), so it's the
   *  stable signal that an async preset switch has landed. */
  activePresetIndicator(name: string): Locator {
    return this.page.getByRole('status', { name: `Active preset: ${name}` })
  }

  /**
   * Switch to `mode` and pick `preset` from the quick preset picker. The picker
   * opens on hover of the mode button (no mode switch yet); picking a card then
   * performs the mode + preset switch (see PromptArea.vue). Returns false —
   * leaving nothing open — when the preset isn't offered for this mode, so
   * callers can skip. On success the picker has closed and the switch completed.
   */
  async selectPreset(mode: ChatMode, preset: string): Promise<boolean> {
    // Hovering the button opens the picker; it stays open while the pointer
    // rests there, and moving onto a preset card keeps it open too.
    await this.modeButton(mode).hover()
    const card = this.presetCard(preset)
    const present = await card
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    if (!present) {
      // Not available in this mode — close the picker (Escape) and bail.
      await this.page.keyboard.press('Escape')
      return false
    }
    // Move onto the card before clicking. The picker closes shortly after the
    // pointer leaves the mode button (`schedulePickerClose`), and the card strip
    // animates its thumbnails in (`transition-all duration-150`) — clicking straight
    // from the button races both, which surfaced as "element is not stable" and then
    // "element was detached from the DOM". Hovering the card cancels the scheduled
    // close and lets the transition settle first.
    await card.hover()
    // The indicator shows the preset's DISPLAY label, which is OEM-branded while the
    // card's data attribute is not — so assert on what this very card is labelled.
    // Read it BEFORE clicking: the click closes the popover and unmounts the card, so
    // reading afterwards races the unmount and throws once it wins.
    const label = (await card.getAttribute('aria-label')) ?? preset
    await card.click()
    // Selecting closes the popover and kicks off an async preset switch (a
    // backend reload can take a while); the indicator flips once it lands.
    await expect(this.activePresetIndicator(label)).toBeVisible({ timeout: 30_000 })
    return true
  }

  async sendPrompt(text: string): Promise<void> {
    await expect(this.sendButton).toBeVisible()
    await this.promptInput.fill(text)
    await this.sendButton.click()
  }

  /**
   * Submit a generation in a direct ComfyUI mode (Image Gen / Image Edit / Video).
   * Unlike {@link sendPrompt}, the prompt box may be read-only for some presets
   * (e.g. Upscale, Colorize, 3D) — those still generate from their fixed workflow,
   * so we only type when the box is editable, then hit Send.
   */
  async submitGeneration(text?: string): Promise<void> {
    await expect(this.sendButton).toBeVisible()
    if (text && (await this.promptInput.isEditable().catch(() => false))) {
      await this.promptInput.fill(text)
    }
    await this.sendButton.click()
  }

  /**
   * Wait for the current turn (backend/model load, "Processing prompt…",
   * reasoning, tool calls and generation) to fully finish. The busy (Stop)
   * control is up for the entire turn and only gives way to Send once everything
   * is done, so we first confirm the turn actually started (busy control shown),
   * then wait for it to clear. Gating on the busy control — not on partial
   * signals like reasoning finishing or the first token — is what keeps this from
   * returning early.
   */
  async waitUntilIdle(timeout: number = MainPage.TEXT_TIMEOUT): Promise<void> {
    try {
      await expect(this.busyButton).toBeVisible({ timeout: 20_000 })
    } catch {
      // A very fast turn may finish before the busy state is observed.
    }
    await expect(this.busyButton).toBeHidden({ timeout })
    await expect(this.sendButton).toBeVisible({ timeout: 20_000 })
  }

  /**
   * Confirm the turn actually started (busy control shown). Tolerates a very fast
   * turn that finishes before the busy state is observed. Used by callers that then
   * poll {@link isBusy} themselves (e.g. resolving a mid-turn download dialog).
   */
  async expectTurnStarted(): Promise<void> {
    try {
      await expect(this.busyButton).toBeVisible({ timeout: 20_000 })
    } catch {
      // A very fast turn may finish before the busy state is observed.
    }
  }

  /** True while a turn is running (the busy/Stop control is present). */
  async isBusy(): Promise<boolean> {
    return this.busyButton.isVisible().catch(() => false)
  }

  /** Short pause between poll iterations. */
  async pause(ms = 1_000): Promise<void> {
    await this.page.waitForTimeout(ms)
  }

  /**
   * Wait until the last assistant turn has rendered a non-empty text answer, i.e.
   * the model has moved past reasoning/tool steps and actually replied. Prefer
   * this over relying on {@link waitUntilIdle} alone for text turns: the idle
   * (Send button) signal fires when the turn ends, but the assertion of interest
   * is that a *reply* — not just a reasoning trace — is on screen.
   */
  async waitForAssistantAnswer(timeout: number = MainPage.TEXT_TIMEOUT): Promise<void> {
    // Wait for the whole turn to finish first (model load, reasoning, tool calls,
    // generation), then assert a reply is on screen. Once idle, a well-formed turn
    // must have rendered an "Assistant reply" region — if only a reasoning trace is
    // present the model closed the turn with an empty final answer. Failing fast
    // here surfaces that as a clear diagnostic instead of blocking on the full
    // per-turn budget waiting for a region that will never appear.
    await reportingAppErrors(this.page, async () => {
      await this.waitUntilIdle(timeout)
      // A turn the backend rejected also ends with no reply region, so check for the
      // app's own error bubble first and report THAT. Otherwise a hard backend refusal
      // (an OVMS "prompt tokens + max tokens exceeds model max length" 400, say) is
      // misreported below as the model having chosen to answer with reasoning alone,
      // which sends anyone reading the failure after the wrong bug entirely.
      await this.assertNoGenerationError()
      await expect(
        this.assistantAnswer.filter({ hasText: /\S/ }).first(),
        // Hedged deliberately: the error toast above is transient, so a turn the
        // backend rejected can reach here with nothing left on screen to prove it —
        // which is why `reportingAppErrors` quotes the console log as well.
        'model finished the turn but produced no non-empty text reply (a reasoning-only ' +
          'response, or a failure whose error notice had already faded — check the app log)',
      ).toBeVisible({ timeout: 5_000 })
    })
  }

  /**
   * Wait for a Text-to-Speech turn to finish and render a playable audio result.
   * The synthesizeTextToSpeech tool emits a ChatTtsToolResult bubble with an
   * `<audio controls>` element once the WAV is produced and loaded.
   */
  async waitForTtsAudio(timeout: number = MainPage.TEXT_TIMEOUT): Promise<void> {
    await reportingAppErrors(this.page, async () => {
      await this.waitUntilIdle(timeout)
      await this.assertNoGenerationError()
      await expect(
        this.ttsAudioPlayer.first(),
        'the Text-to-Speech turn finished but produced no playable audio result',
      ).toBeVisible({ timeout: 15_000 })
    })
  }

  /**
   * Wait for a Text-to-Speech turn to finish and assert exactly `expectedCount`
   * playable audio results are present across the conversation. Counting (rather
   * than just "the last turn has audio") is what proves a follow-up synthesis added
   * a *new* audio bubble — e.g. a second turn spoken by a freshly created voice.
   */
  async waitForTtsAudioCount(
    expectedCount: number,
    timeout: number = MainPage.TEXT_TIMEOUT,
  ): Promise<void> {
    await reportingAppErrors(this.page, async () => {
      await this.waitUntilIdle(timeout)
      await this.assertNoGenerationError()
      await expect(
        this.ttsAudioPlayers,
        `the Text-to-Speech conversation should hold ${expectedCount} playable audio result(s)`,
      ).toHaveCount(expectedCount, { timeout: 15_000 })
    })
  }

  /**
   * MCP tool-call cards (ChatMcpToolDisplay) in the last assistant turn. Each card's
   * header reads "MCP tool call - <serverId> MCP - <toolName>", so a card scoped to a
   * server id is proof the agent actually invoked one of that server's tools rather
   * than answering from memory.
   */
  mcpToolCallCards(serverId: string): Locator {
    return this.assistantResponses
      .last()
      .getByText(new RegExp(`MCP tool call - ${serverId} MCP`, 'i'))
  }

  /**
   * A completed MCP tool-call card for `serverId`: the card's clickable header holds
   * both the "MCP tool call - <serverId> MCP - …" title and the "Completed" state pill,
   * so filtering the header div on both proves the tool call resolved successfully.
   */
  mcpToolCallCompleted(serverId: string): Locator {
    return this.assistantResponses
      .last()
      .locator('div.cursor-pointer')
      .filter({ hasText: new RegExp(`MCP tool call - ${serverId} MCP`, 'i') })
      .filter({ hasText: 'Completed' })
  }

  /** Wait until the last turn shows at least one MCP tool call for `serverId`. */
  async waitForMcpToolCall(
    serverId: string,
    timeout: number = MainPage.TEXT_TIMEOUT,
  ): Promise<void> {
    await expect(
      this.mcpToolCallCards(serverId).first(),
      `expected the agent to invoke an MCP tool from the "${serverId}" server`,
    ).toBeVisible({ timeout })
  }

  /** The hidden audio-upload input rendered by the Speech-to-Text preset surface. */
  get sttUploadInput(): Locator {
    return this.page.locator('#stt-file-upload')
  }

  /**
   * Upload an audio file into the Speech-to-Text preset's record/upload surface,
   * which kicks off transcription and appends a transcript chat turn.
   */
  async uploadSttAudio(filePath: string): Promise<void> {
    await this.sttUploadInput.waitFor({ state: 'attached', timeout: 15_000 })
    await this.sttUploadInput.setInputFiles(filePath)
  }

  /**
   * Wait for the Speech-to-Text preset to render a non-empty transcript as an
   * assistant reply. The STT preset has no Send/Stop control (it submits via the
   * record/upload surface), so this waits directly on the transcript text rather
   * than on the idle signal used by {@link waitForAssistantAnswer}.
   */
  async waitForTranscript(timeout: number = MainPage.TEXT_TIMEOUT): Promise<void> {
    await expect(
      this.assistantAnswer.filter({ hasText: /\S/ }).first(),
      'the Speech-to-Text turn produced no non-empty transcript',
    ).toBeVisible({ timeout })
  }

  async lastAssistantText(): Promise<string> {
    const answers = this.assistantAnswer
    const count = await answers.count()
    const texts: string[] = []
    for (let i = 0; i < count; i++) {
      texts.push((await answers.nth(i).innerText()).trim())
    }
    return texts.filter((t) => t.length > 0).join('\n\n')
  }
}
