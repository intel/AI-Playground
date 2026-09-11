import { test, expect } from './fixtures'

// Text-to-Speech preset (Audio mode) on its default Qwen3-TTS engine: install
// backends, select the preset, and assert a series of playable audio results — the
// default voice, then a custom voice created mid-test — plus its regressions: the
// voice model is fetched when the voice is saved, Regenerate re-synthesizes instead
// of loading a chat model, and a saved voice reproduces the same audio until it is
// re-rolled. The Kokoro (OpenVINO) engine has its own spec.

const PROMPT = 'Hello from the AI Playground end-to-end test suite.'

test.describe('Text to Speech', () => {
  test('"Text to Speech" preset synthesizes audio from text', async ({ app }) => {
    // Five synthesis turns (default voice, custom voice, regenerate, repeat, re-roll)
    // on top of two model downloads need more room than a single-turn chat case.
    test.setTimeout(55 * 60_000)
    await app.installAllBackends()

    // The Text-to-Speech backend pulls a heavy model, so it's installed on demand here
    // rather than in installAllBackends. It must be available — TTS is a required
    // capability in this suite, so an unavailable backend fails the test rather than
    // skipping.
    const ttsAvailable = await app.ensureTtsBackendInstalled()
    expect(ttsAvailable, 'Text-to-Speech must be available (mode supported)').toBe(true)

    await app.runTtsPreset({
      text: PROMPT,
      newVoice: {
        name: 'E2E Custom Voice',
        description: 'A calm, warm middle-aged British man, reassuring and clear.',
        text: 'This line is spoken by a custom voice created during the end-to-end test.',
      },
    })
  })
})
