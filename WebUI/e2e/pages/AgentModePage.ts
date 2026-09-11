import { type Locator, type Page, expect } from '@playwright/test'

/**
 * The parts of a game library entry this suite asserts on. Read through the app's
 * own `games:list` IPC rather than off disk, so what the test sees is exactly what
 * the library (and the arcade page) would show.
 */
export type GameSummary = {
  dir: string
  name: string
  description: string
  entryPath: string
  iconPath?: string
  initialPrompt?: string
}

/**
 * Page object for Agent Mode — the view the agent presets (Game Agent, Quick
 * Coder) render instead of the chat panel.
 *
 * The prompt area is shared with Chat (same Prompt / Send / Stop controls, so
 * {@link MainPage} drives the turn); what is specific here is the transcript
 * shape and, for the game presets, the managed game folder the turn produces.
 */
export class AgentModePage {
  constructor(private readonly page: Page) {}

  /**
   * The Game Agent / Quick Coder game bar pinned above the transcript. Its
   * presence is the signal that the active preset works on a managed game folder
   * rather than a folder the user picked.
   */
  get gameBar(): Locator {
    return this.page.getByRole('group', { name: 'Current game' })
  }

  /**
   * The folder picker in the Agent settings sidebar, for presets that work in a
   * folder the user chooses (`agentWorkspace: 'pick'` — the "Agent" preset).
   * AgentMode.vue offers the same action in its empty state, but only while no
   * workspace is set; this one is there either way, so a re-run that inherited a
   * folder from a previous run can still be pointed somewhere else.
   */
  get selectFolderButton(): Locator {
    return this.page
      .getByRole('region', { name: 'Agent Settings' })
      .getByRole('button', { name: 'Select folder…' })
  }

  /**
   * Give the agent its workspace, with the Agent settings sidebar open. The click
   * opens a native directory dialog, so the caller must have pointed that dialog
   * at `dir` first (`stubDirectoryPicker` in helpers.ts); this then waits for the
   * app to echo the folder back, which is what says it was actually adopted.
   */
  async selectWorkspaceFolder(dir: string): Promise<void> {
    await this.selectFolderButton.click()
    await expect(
      this.page.getByText(dir, { exact: false }).first(),
      'the agent should show the workspace folder it adopted',
    ).toBeVisible({ timeout: 15_000 })
  }

  /** The "New game" control in the Agent settings sidebar (managed workspaces only). */
  get newGameButton(): Locator {
    return this.page.getByRole('region', { name: 'Agent Settings' }).getByRole('button', {
      name: 'New game',
      exact: true,
    })
  }

  /**
   * The error banner AgentMode.vue renders when the turn itself failed (a dead
   * backend, a session that could not start) — distinct from the agent reporting
   * in prose that something went wrong.
   */
  get turnError(): Locator {
    return this.page.locator('div.text-destructive').filter({ hasText: /\S/ })
  }

  /** Throw with the banner's text if the turn ended in an error. */
  async assertNoTurnError(): Promise<void> {
    const banner = this.turnError.first()
    if (await banner.isVisible().catch(() => false)) {
      throw new Error(`Agent turn failed: "${(await banner.innerText()).trim()}"`)
    }
  }

  /**
   * Everything the agent put on screen this session: the folded activity
   * summaries, the tool cards and the final answer. Used for diagnostics on
   * failure rather than for assertions — what the agent *did* is asserted
   * against the game folder it produced.
   */
  async transcriptText(): Promise<string> {
    return (await this.page.locator('main, body').first().innerText()).trim()
  }

  /**
   * The managed game library, straight from the app's `games:list` IPC (the same
   * call the library and the game bar read).
   */
  async listGames(): Promise<GameSummary[]> {
    return this.page.evaluate(() => window.electronAPI.games.list()) as Promise<GameSummary[]>
  }

  /** The folder of every game that exists right now — the baseline for {@link gameCreatedSince}. */
  async gameDirs(): Promise<string[]> {
    return (await this.listGames()).map((game) => game.dir)
  }

  /**
   * The game folder this turn minted, i.e. the one library entry that was not
   * there before. Fails when the turn produced none (the agent never got as far
   * as starting a game) or more than one (which would make later assertions
   * ambiguous about which game they describe).
   */
  async gameCreatedSince(before: string[]): Promise<GameSummary> {
    const known = new Set(before)
    const fresh = (await this.listGames()).filter((game) => !known.has(game.dir))
    expect(
      fresh,
      'the turn should have minted exactly one new game folder in the library',
    ).toHaveLength(1)
    return fresh[0]
  }

  /** Wait for the game bar to show a game (it renders "New game" until one exists). */
  async expectGameBarNamed(name: string): Promise<void> {
    await expect(this.gameBar, 'the game bar should name the game the agent built').toContainText(
      name,
      { timeout: 15_000 },
    )
  }
}
