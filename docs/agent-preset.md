# The Agent preset

> **Status: draft for review.** The definition below is a proposal. The wording marked
> _shipped copy_ is what currently sits in `modes/base/presets/agent.json`; change it there
> once we agree on the positioning. The preset is experimental and hidden by default — see
> [Turning it on](#turning-it-on).

## What it is

**Agent is the bare harness: you point it at a folder on your disk and give it a job, and it
works in that folder until the job is done.** It is not an agent _creator_ — nothing you do in
it produces a reusable agent. It is one agent, unspecialized, whose subject is whatever folder
you hand it.

Everything the app's agent runtime can do is on the table in one session: read, write and edit
files, run commands in an emulated shell, search the folder, open pages in a real browser and
read their console, and generate images, video or 3D models. Where Game Agent aims all of that
at one outcome, Agent leaves the aim to you.

_Shipped copy:_ "Give the model a task and a folder to work in. It writes and runs files,
browses its own pages, and can generate images and video along the way."

## When you would reach for it

Four tasks it is actually good at, in rough order of how well they land on a local model:

1. **Make a small web page or tool and see it run.** "Build a single-page unit converter in
   this folder, then open it and fix anything the console complains about." The browser
   capability closes the loop, so the agent checks its own work instead of handing you a file
   that may or may not load — its `probe` action reports errors, animation and input handling
   as text, without spending a turn on a screenshot.
2. **Bulk work over files you already have.** "Rename every screenshot in this folder to
   `YYYY-MM-DD-<subject>.png` and write an index.md listing them." Deterministic, verifiable,
   and the shell keeps the token cost low.
3. **Read a folder and report on it.** "Read these meeting notes and write a summary.md with
   the decisions and open questions." A whole folder is context without a RAG index, because
   the agent reads what it needs when it needs it.
4. **Assemble something out of generated media.** "Generate four cover variants for this
   article and lay them out in a contact-sheet HTML page." The `media` capability writes into
   the workspace, so the page can just reference the files.

What it is **not** for: open-ended questions, anything you would rather have as a conversation,
and code you would not let a local model run unattended. It has no undo — it edits your folder
directly.

## How it differs from the neighbouring presets

| | Basic Chat / Assistant | **Agent** | Game Agent |
| --- | --- | --- | --- |
| Works on | the conversation | a folder you pick | a game folder the app scaffolds |
| Files | attachments, RAG | reads and writes them directly | same, plus the game card |
| Tools | optional, per turn | file, shell, browser, media | the same, aimed at one outcome |
| Ends with | an answer | a changed folder | a playable game in your library |
| Best model size | any | the largest that fits | the largest that fits |

The practical difference from Basic Chat is that Agent spends a large part of the context
window before your task even starts — harness instructions, tool schemas, skill announcements.
On a small model that is attention taken away from your problem, which is why a plain chat can
out-write it on a self-contained task. Reach for Agent when the work
_is_ the folder, not when you just want code in a reply.

The difference from Game Agent is aim, not power. Game Agent is this same harness with a
system prompt, a skill, a workspace policy and a starting point — a new game folder already
holds an `index.html` + `game.js` that run, which the agent grows section by section — all
pointing at "produce a playable game". It is the preset to use for games; Agent is the one to
use when nobody has written that specialization yet, and it starts you at an empty folder.

The Game Agent procedure lives in the `html-game-studio` skill (`GAME_STUDIO_SKILL` in
`WebUI/electron/agentMode/capabilities/gameStudio.ts`). The preset `systemPrompt` only orients
the session (scaffold, plan on disk, one section per edit) and tells the model to read that
skill at the path announced in `<available_skills>`.

**Quick Coder** is the other end of that trade: an empty game folder, a short prompt in
place of the harness's own, and `write` as the only file tool. It runs as two steps of one turn
— the agent answers with a plan and stops, the app approves it for you, and the game is then
written whole into a single `index.html` without further thinking. No generated art and no play-testing,
so it finishes in minutes rather than tens of them and asks far less of a small model's context
— and produces a simpler game. Iterative Game Agent is unchanged and is still the one to use
when the game should be illustrated and tested.

That leaves Quick Coder unable to follow up on its own game: it cannot read the file it wrote,
try it, or draw for it, so "the ship keeps moving after you let go" can only be answered by
writing the whole thing again from memory. So it does not try — it hands the game to Game Agent,
which takes the same folder and arrives with `read`, `edit`, `browser` and `media`. Its
`offer_game_agent` tool puts the switch up as a card in the transcript and asks the model for
both the request in the user's words and a summary of the game for whoever takes it on.

Accepting does not switch anything on the spot: it records the hand-over, the offering turn ends
with a line to the user, and the store's `watch(processing)` then switches preset, starts a
session and sends `gameAgentHandoffPrompt` as its first message — so Game Agent picks the request
up by itself rather than leaving the user at a prompt box. The session is new rather than the old
one re-tagged, because a Quick Coder transcript is written under instructions that are wrong for
the agent inheriting it ("there is no browser", "you cannot read the file back") and models
followed them. The folder is the artifact and it does not move; the hand-over message carries
what was built, what is wanted, and that `index.html` is the whole game with no `game.js`. The
one-shot session stays in the panel as the record of how the game was made.

The tool is also the only way a game crosses from one preset to the other. Picking a different
agent preset from the list always starts a blank session — the last game stays in the panel and is
reopened from there — because a session's capabilities are frozen on its record while its
instructions come from the live preset, so continuing one under the other preset means one
preset's prompt driving the other's toolbox. Quick Coder's own prompt, for instance, tells the
model there is no browser and nothing to read back, which is exactly wrong for Game Agent.

## Turning it on

Hidden by default because it is experimental: it can overrun a small model, and it writes to a
folder of your choosing with no undo. Tick **Agent preset** under **Settings → Developer**. The
checkbox writes `isAgentPresetEnabled` into the app's settings
(`{userData}/ai-playground-local-settings.json` in dev, the per-user `settings.json` in a packaged
install) and re-reads the preset list, so the preset appears without a restart. Dev builds have it
on already through `WebUI/external/settings-dev.json`.

The preset is dropped while presets are read (`disabledFeaturePresets` in
`WebUI/electron/main.ts`), so with the setting off nothing downstream can select it, and a
persisted selection of it falls back to another chat preset at boot.

## Open questions for review

- Is "one agent aimed at a folder" the positioning we want, or should Agent be presented as
  the place to _try out_ capability combinations before they become their own preset?
- Should the workspace picker default somewhere (Documents/AI Playground) instead of starting
  empty?
- Do we want a "Lite" variant with only the file tools, for small-context runs?
