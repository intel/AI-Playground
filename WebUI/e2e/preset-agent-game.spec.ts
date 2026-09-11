import fs from 'fs'
import path from 'path'
import { test, expect } from './fixtures'
import { AppDriver } from './appDriver'
import { type GameSummary } from './pages/AgentModePage'

// The two game-building agent presets, one test each. Both run on the Pi agent
// harness (not the chat harness the "Assistant" specs cover) and both own a
// managed game folder. Both presets are pinned to Qwen3.5-4B
// (AppDriver.AGENT_GAME_MODEL) rather than the big models they prefer, so the run
// stays cheap; a 4B model writes a rough game, and that is fine here. Nothing
// below inspects gameplay.
//
// The two tests deliberately assert to different depths, because the presets cost
// very different amounts to run:
//
//  - Quick Coder is one shot: it gets an EMPTY folder (`scaffold: false` in
//    agentMode.generate) and `write` as its only file tool, and it is done in
//    minutes. So this one waits out the whole turn and asserts against the folder
//    it produced: `index.html` existing at all is the proof, and there is no
//    `game.js`.
//  - Game Agent plans, edits section by section and play-tests in a browser — dozens
//    of model steps, well over half an hour on a 4B model. Too long for the suite,
//    so this one only proves the turn STARTS and is still going a minute later
//    (AppDriver.AGENT_GAME_PROGRESS_WINDOW). That covers what actually regresses —
//    preset wiring, model/backend load, the agent loop getting underway — and
//    deliberately stops short of proving a finished game.
//
// Each runs on llama.cpp or OpenVINO at random (AppDriver.pickRandomBackend);
// OpenVINO isn't offered in NVIDIA product mode, where the run falls back to
// llama.cpp. A preset not offered at all in the running product mode skips itself.

/** The one-line request both presets get — small enough for a 4B model to finish. */
const GAME_REQUEST = 'Make a one-button endless runner where I dodge asteroids.'

/** Read a file inside the produced game folder; '' when the agent never wrote it. */
function readGameFile(game: GameSummary, name: string): string {
  try {
    return fs.readFileSync(path.join(game.dir, name), 'utf-8')
  } catch {
    return ''
  }
}

test.describe('Game agent presets', () => {
  test('"Quick Coder" writes a game into one HTML file', async ({ app }) => {
    // Backend install plus one multi-step agent turn.
    test.setTimeout(AppDriver.AGENT_GAME_TIMEOUT + 20 * 60_000)

    await app.installAllBackends()

    const built = await app.runAgentGamePreset({ preset: 'Quick Coder', prompt: GAME_REQUEST })
    test.skip(built === null, 'Preset "Quick Coder" is not available in this product mode')
    const game = built as GameSummary

    const index = readGameFile(game, 'index.html')

    expect(
      index,
      'Quick Coder starts from an empty folder, so index.html exists only if it wrote one',
    ).not.toEqual('')
    expect(index, 'the written page should be an HTML document').toMatch(/<html[\s>]/i)
    expect(
      readGameFile(game, 'game.js'),
      'Quick Coder writes a single file — a game.js would mean it got the scaffold flow',
    ).toEqual('')

    await app.agent.expectGameBarNamed(game.name)
  })

  test('"Game Agent" starts building and keeps working', async ({ app }) => {
    // Backend install plus one minute of watching the turn — not a whole build.
    test.setTimeout(AppDriver.AGENT_GAME_PROGRESS_WINDOW + 25 * 60_000)

    await app.installAllBackends()

    const ran = await app.runAgentGamePresetBriefly({ preset: 'Game Agent', prompt: GAME_REQUEST })
    test.skip(!ran, 'Preset "Game Agent" is not available in this product mode')
  })
})
