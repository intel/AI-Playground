import fs from 'fs'
import os from 'os'
import path from 'path'
import { test } from './fixtures'
import { stubDirectoryPicker } from './helpers'

// The general-purpose "Agent" preset, run through the same two turns as the fast
// agentic smoke does on "Assistant": write a haiku, then turn it into an image.
// Same flow, different harness — this preset runs on the Pi agent (Agent Mode's own
// transcript, its own tool loop) rather than the chat harness.
//
// The preset keeps its defaults: its own model per backend (the 9B, not the small
// model the game specs pin) and its default capabilities (media + web-debug). Two
// things are chosen for it. The backend — llama.cpp or OpenVINO at random when both
// are offered (AppDriver.pickRandomBackend), as in the other preset specs; OpenVINO
// isn't offered in NVIDIA product mode. And the context size, cut to 8k
// (AppDriver.AGENT_CONTEXT): the preset ships asking for 128k, which is more KV
// cache than a laptop GPU has, and llama.cpp then refuses to load the model at all
// ("not enough memory to run … with a context size of 131072") — so at the shipped
// default this flow cannot start on such a machine.
//
// The preset works in a folder the user picks (`agentWorkspace: 'pick'`), so the
// test hands it a fresh temp folder — the agent writes into it, and it is removed
// afterwards. Nothing here asserts on the folder's contents: the subject is the
// transcript and the image, exactly as in agentic-smoke.spec.ts.

const PROMPTS = {
  haiku: 'Write a haiku about a friendly, goofy surfer-dude lizard.',
  // Pin the "Draft Image" preset (fast SD1.5, 512x512) so this uses the quickest
  // image path rather than whatever preset the agent would otherwise pick.
  toImage: 'Now turn that haiku into an image using the "Draft Image" preset.',
}

test.describe('Agent preset', () => {
  test('writes a haiku and turns it into an image', async ({ app, electronApp }) => {
    // Install + the preset's own (large) model + a text turn + a real image
    // generation all far exceed the default timeout.
    test.setTimeout(45 * 60_000)

    await app.installAllBackends()

    // A scratch folder the agent is free to write into, and a stubbed native picker
    // pointed at it — the real directory dialog is modal and nothing could click it.
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-agent-'))
    await stubDirectoryPicker(electronApp, workspaceDir)

    try {
      const ran = await app.runAgentPreset({
        workspaceDir,
        prompt: PROMPTS.haiku,
        imagePrompt: PROMPTS.toImage,
      })
      test.skip(!ran, 'Preset "Agent" is not available in this product mode')
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true })
    }
  })
})
