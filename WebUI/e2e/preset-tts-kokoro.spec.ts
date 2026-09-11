import { test, expect } from './fixtures'

// Text-to-Speech preset on the Kokoro (OpenVINO) engine: install backends, confirm
// OpenVINO is offered in this product mode (Kokoro runs on OVMS), switch the TTS
// preset's engine to Kokoro, synthesize once, and assert a playable audio result.
//
// Kokoro is OpenVINO-only, so this SKIPS where OpenVINO isn't installable (e.g. the
// NVIDIA product mode, where the app filters OpenVINO out) — mirroring how the
// agentic-smoke OpenVINO variant skips when the backend picker doesn't offer it.

const TTS_PRESET = 'Text to Speech'
const KOKORO_ENGINE = 'Kokoro (OpenVINO)'
const PROMPT = 'Hello from the AI Playground end-to-end test suite.'

test.describe('Text to Speech (Kokoro)', () => {
  test('synthesizes audio with the Kokoro OpenVINO engine', async ({ app }) => {
    // Install + OVMS speech-model download + a synthesis turn exceed the default timeout.
    test.setTimeout(40 * 60_000)

    await app.installAllBackends()

    // Kokoro needs OpenVINO. Probe it via the agentic preset's backend picker: it
    // lists OpenVINO only in Intel/OpenVINO product modes (filtered out in NVIDIA
    // mode), so an absent OpenVINO backend is our skip signal.
    await app.main.selectPreset('Chat', 'Assistant')
    await app.settings.open('Chat')
    const backends = await app.settings.availableBackends('Chat')
    await app.settings.close('Chat')
    test.skip(
      !backends.includes('OpenVINO'),
      'OpenVINO is not installable in this product mode — Kokoro TTS is unavailable',
    )

    await test.step('Select the Text to Speech preset and switch to the Kokoro engine', async () => {
      const available = await app.main.selectPreset('Audio', TTS_PRESET)
      expect(available, `Preset "${TTS_PRESET}" must be available`).toBe(true)
      await app.settings.open('Audio')
      await app.settings.selectTtsEngine(KOKORO_ENGINE, 'Audio')
      await app.settings.close('Audio')
    })

    await test.step('Synthesize speech with Kokoro and expect a playable audio result', async () => {
      await app.main.sendPrompt(PROMPT)
      // First synthesis downloads the Kokoro OVMS speech model via the same dialog.
      await app.resolveModelDownloadOrSkip('the Kokoro speech model')
      await app.main.waitForTtsAudioCount(1)
    })
  })
})
