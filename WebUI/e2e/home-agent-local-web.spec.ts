import { test, expect } from './fixtures'
import type { AppDriver } from './appDriver'
import type { Page } from '@playwright/test'
import { MainPage } from './pages/MainPage'
import { HomeAgentPage } from './pages/HomeAgentPage'
import {
  openLocalWebChat,
  sendAndAwaitMedia,
  sendAndAwaitReply,
  sendAndAwaitText,
  sendMessage,
  lanImages,
  lanVideos,
  userMessages,
} from './localWebBrowser'

// End-to-end coverage for the Home Agent "LAN chat" channel — the browser-served,
// loopback/LAN-reachable third option alongside Telegram and Slack, served by the
// Python backend (no cloud relay, no extra Electron server). Every test installs
// the backends, brings the Home Agent up on this channel, then drives the *real
// served page* in an actual browser (raw HTTP + SSE against the served chat page).
// Inference and media generation flow through the Home Agent's own bundled preset
// + model; if a model isn't present yet the agent asks to download it in-channel,
// and the served page's auto-confirm handler (see localWebBrowser.ts) taps
// "Confirm" so a first run still completes — it just takes as long as the download.

// A local port unlikely to collide with a real user's default (8765), and a throwaway
// password. Bound to 127.0.0.1 (allowLan off) — the test connects on loopback.
const LOCAL_WEB_PORT = 8770
const LOCAL_WEB_PASSWORD = 'lizard-e2e-pw'
const BASE_URL = `http://127.0.0.1:${LOCAL_WEB_PORT}`

// An agentic prompt — the assistant decides how to answer. Deliberately a plain
// creative ask (no slash command) so it exercises a real inference turn.
const HAIKU_PROMPT = 'Write a haiku about a friendly, goofy surfer-dude lizard.'

// Per-thread markers for the repaint test. Neutral small-talk that just happens to
// carry a unique token — phrased so the agent reads it as chit-chat, not as a
// settings/action request (which would route through a tool + confirmation and
// perturb the live page). The token lives in the *user* message, which is what
// `/load` repaints verbatim from the transcript.
const MARKER_MARCO = 'Quick question for fun — what is a nice thing about the ocean? Tag: MARCO'
const MARKER_POLO = 'Quick question for fun — what is a nice thing about the sun? Tag: POLO'

// The lizard image → edit → video flow, mirroring the desktop full-flow prompts.
const MEDIA_PROMPTS = {
  generateImage:
    'Generate an image of a lizard character, he is muscular fun and friendly and designed for an animated film. He is a surfer dude, and with a goofy but friendly vibe. Generate in 1:1 aspect ratio',
  editImage: 'Edit this image giving this character sunglasses and classic surfer hair',
  animateToVideo:
    'Lets bring this image to life. Animate this using LTX.2.3 i2v image to video. Have him waving hi and saying Hey Dudes, then jumping back into a cool pose that is consistent with his surfer, goofy character',
}

/**
 * Install backends, ensure the Home Agent backend is present (skipping when it isn't
 * offered in this product mode), optionally enable the Home Agent's media-generation
 * tools, then set up + start the LAN chat channel and turn the agent on. Each test
 * launches a fresh app (the electronApp fixture is per-test), so this runs once per
 * test — install is idempotent and the channel config persists across runs.
 */
async function bringUpLanChat(
  app: AppDriver,
  window: Page,
  opts: { enableMedia?: boolean } = {},
): Promise<void> {
  await app.installAllBackends()

  const homeAgentAvailable = await app.ensureHomeAgentBackendInstalled()
  test.skip(!homeAgentAvailable, 'Home Agent backend is not available in this product mode')

  if (opts.enableMedia) {
    // Media turns fill the context with tool schemas, so also give the reasoning
    // model room to actually reach the generation tool instead of a reasoning-only turn.
    await app.enableHomeAgentMediaTools()
    await app.relaxChatGenerationBudget()
  }

  const homeAgent = new HomeAgentPage(window)
  await test.step('Set up the local web chat channel and turn the agent on', async () => {
    await homeAgent.open()
    await homeAgent.configureLocalWeb({ port: LOCAL_WEB_PORT, password: LOCAL_WEB_PASSWORD })
    await homeAgent.finishSetup()
    await homeAgent.ensureMasterOn()
  })
}

/**
 * Put a distinct, persisted marker into the current thread with an ordinary agentic
 * turn (`text` carries a unique token in the user message) and wait for the turn to
 * fully finish. Completion is read from the *desktop* busy control, not the served
 * page's reply bubbles: `/new` repaints (clears + rebuilds) the served log via a
 * separate async event, so a page bubble count isn't monotonic and can't reliably
 * mark a turn done. The desktop busy control shows for the whole channel turn and
 * clears only after the transcript is persisted, so waiting for it to appear (turn
 * started) then clear (turn done) is repaint-proof — and guarantees the marker is
 * saved before the caller switches away with `/new`.
 */
async function markerTurn(app: AppDriver, page: Page, text: string): Promise<void> {
  await sendMessage(page, text)
  await expect(app.main.busyButton).toBeVisible({ timeout: 60_000 })
  await expect(app.main.busyButton).toBeHidden({ timeout: MainPage.TEXT_TIMEOUT })
}

test.describe('Home Agent — local web chat', () => {
  test('drives the served chat page end to end', async ({ app, window, electronApp }) => {
    // Install + Home-Agent bring-up + a real (possibly first-time) model turn all
    // exceed the default timeout — match the agentic smoke's budget.
    test.setTimeout(30 * 60_000)
    await bringUpLanChat(app, window)

    // The raw transport plus the served page's own JS (login form, EventSource
    // wiring, send handler, reply rendering) — the "I typed something and nothing
    // happened" surface. Drive the real page in an actual browser and assert a real
    // reply streams back.
    const page = await openLocalWebChat(electronApp, BASE_URL, LOCAL_WEB_PASSWORD)
    try {
      const reply = await sendAndAwaitReply(page, HAIKU_PROMPT, MainPage.IMAGE_TIMEOUT)
      expect(reply.trim()).not.toEqual('')
    } finally {
      await page.close()
    }
  })

  test('/new and /load switch and repaint chat threads', async ({ app, window, electronApp }) => {
    test.setTimeout(30 * 60_000)
    await bringUpLanChat(app, window)

    // The LAN page keeps no history of its own, so both /new and /load have to
    // repaint it: /new with a clean slate, /load with the chosen thread's
    // transcript. Put a distinct token in each of two threads (via ordinary agentic
    // turns), then switch between them and assert only the active thread's token is
    // on screen.
    const page = await openLocalWebChat(electronApp, BASE_URL, LOCAL_WEB_PASSWORD)
    try {
      // The desktop mirrors the active Home Agent thread; keep the App Settings
      // sidebar closed so the idle (Send-button) check below isn't occluded.
      await app.shell.ensureSettingsClosed()

      // Baseline /new burns any pre-existing empty thread so the /new below is
      // guaranteed to create the newest thread (index 1 for /load).
      await sendAndAwaitText(page, '/new', 'new chat thread', 60_000)
      await markerTurn(app, page, MARKER_MARCO)

      await sendAndAwaitText(page, '/new', 'new chat thread', 60_000)
      await markerTurn(app, page, MARKER_POLO)

      const marco = userMessages(page, 'MARCO')
      const polo = userMessages(page, 'POLO')

      // Verify the repaint via /load, which rebuilds the page from the chosen thread's
      // *persisted* transcript (user turns included) — the durable source of truth,
      // independent of whatever the live view happens to show mid-session. Loading the
      // older thread shows MARCO and hides POLO; loading the newer one swaps them,
      // proving /load repaints to whichever thread is active rather than only ever
      // appending. (`/load 2` is the older MARCO thread, `/load 1` the newer POLO one.)
      await sendMessage(page, '/load 2')
      await expect(marco).toHaveCount(1, { timeout: 60_000 })
      await expect(polo).toHaveCount(0)

      await sendMessage(page, '/load 1')
      await expect(polo).toHaveCount(1, { timeout: 60_000 })
      await expect(marco).toHaveCount(0)
    } finally {
      await page.close()
    }
  })

  test('generates, edits, then animates a lizard over the LAN page', async ({
    app,
    window,
    electronApp,
  }) => {
    // Install + 3 real generations (incl. a video, each possibly pulling a model
    // in-channel) far exceed the default timeout — match the desktop full-flow budget.
    test.setTimeout(45 * 60_000)
    await bringUpLanChat(app, window, { enableMedia: true })

    // The LAN version of the assistant's image → edit → video flow: ask the Home
    // Agent, over the served page, to create a lizard, edit it, then animate it, and
    // assert each generation renders inline (bot photo/video events → <img>/<video>).
    const page = await openLocalWebChat(electronApp, BASE_URL, LOCAL_WEB_PASSWORD)
    try {
      await test.step('Generate the lizard image → expect an inline image', async () => {
        await sendAndAwaitMedia(page, MEDIA_PROMPTS.generateImage, 'image', MainPage.IMAGE_TIMEOUT)
        expect(await lanImages(page).count()).toBeGreaterThanOrEqual(1)
      })

      await test.step('Edit the image (sunglasses + hair) → expect a second inline image', async () => {
        await sendAndAwaitMedia(page, MEDIA_PROMPTS.editImage, 'image', MainPage.IMAGE_TIMEOUT)
        expect(await lanImages(page).count()).toBeGreaterThanOrEqual(2)
      })

      await test.step('Animate the image with LTX → expect an inline video', async () => {
        await sendAndAwaitMedia(page, MEDIA_PROMPTS.animateToVideo, 'video', MainPage.VIDEO_TIMEOUT)
        expect(await lanVideos(page).count()).toBeGreaterThanOrEqual(1)
      })
    } finally {
      await page.close()
    }
  })
})
