import { test, expect } from './fixtures'
import { MainPage } from './pages/MainPage'

// Quick agentic smoke — the reference flow for `npm run e2e:fast`. Installs backends,
// switches to the agentic chat preset, then runs two turns: a text turn ("write a
// haiku") and an image turn ("turn it into an image"). This is the cheap gate; the
// full agentic flow (image → edit → video) lives in
// assistant-media-flow.spec.ts and runs in `npm run e2e:full`.
//
// The chat backend is pinned explicitly and the smoke runs once per backend: the
// "Assistant" preset otherwise uses whichever backend happens to be running, which has
// masked backend-specific breakage (e.g. llama.cpp Vulkan device-loss vs. OVMS URL/graph
// issues). llama.cpp is the universal default; OpenVINO is only offered in Intel/
// OpenVINO product modes, so its variant skips when the picker doesn't list it.

// The chat preset that puts the assistant in agentic mode (built-in tools on).
const AGENTIC_PRESET = 'Assistant'

// Backend picker labels (see SettingsChat.vue / SpecificSettingsPage.availableBackends).
const CHAT_BACKENDS = [
  { label: 'llamaCPP - GGUF', name: 'llama.cpp', optional: false },
  { label: 'OpenVINO', name: 'OpenVINO', optional: true },
] as const

const PROMPTS = {
  haiku: 'Write a haiku about a friendly, goofy surfer-dude lizard.',
  // Pin the "Draft Image" preset (fast SD1.5, 512x512) so this cheap gate uses the
  // quickest image path rather than whatever preset the agent would otherwise pick.
  toImage: 'Now turn that haiku into an image using the "Draft Image" preset.',
}

test.describe('Agentic smoke', () => {
  for (const backend of CHAT_BACKENDS) {
    test(`writes a haiku and turns it into an image on ${backend.name}`, async ({ app }) => {
      // Install + a text turn + one real image generation exceed the default timeout.
      test.setTimeout(30 * 60_000)

      await app.installAllBackends()

      await test.step('Switch to agentic mode (Chat + "Assistant" preset)', async () => {
        await app.main.selectPreset('Chat', AGENTIC_PRESET)
      })

      // Pin the chat backend for this variant; skip OpenVINO where it isn't offered.
      const pinned = await app.selectChatBackendOrSkip(backend.label, backend.optional)
      test.skip(!pinned, `${backend.name} chat backend is not available in this product mode`)

      // Trim the tool set to the bare minimum this smoke needs (only "Generate media"
      // with the "Draft Image" workflow; MCP + all other tools off). With every tool and
      // workflow advertised, the tool schemas alone fill most of the 8192-token context
      // before the first turn — see the ~6.5k/8.2k usage observed after just the haiku.
      await app.configureAgenticTools('minimal-image')

      await test.step('Prompt 1: write a haiku → expect a text reply', async () => {
        await app.main.sendPrompt(PROMPTS.haiku)
        // Waits for the turn to go idle, then asserts the actual reply text is on
        // screen — not just the end of the reasoning trace.
        await app.main.waitForAssistantAnswer()
        expect(await app.main.lastAssistantText()).not.toEqual('')
        await app.main.assertWellFormedResponse()
        // A plain text reply — no media generated yet.
        expect(await app.main.generatedImages.count()).toBe(0)
      })

      await test.step('Prompt 2: turn the haiku into an image → expect an image', async () => {
        await app.main.sendPrompt(PROMPTS.toImage)
        // The agent pulls the Draft Image model mid-turn; confirm the download dialog
        // when it appears, then wait for the generation to finish.
        await app.waitForAgenticMediaTurn(MainPage.IMAGE_TIMEOUT)
        await app.main.assertNoGenerationError()
        await app.main.assertWellFormedResponse()
        expect(await app.main.generatedImages.count()).toBeGreaterThanOrEqual(1)
      })
    })
  }
})
