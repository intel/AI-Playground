import path from 'path'
import { test, expect } from './fixtures'

// Speech-to-Text preset: install backends, select the "Speech to Text" preset from
// the Audio mode, upload a fixture WAV, and assert a non-empty transcript is rendered
// as a chat turn (transcribed by the OpenVINO Whisper server).
//
// STT is OpenVINO-only, so the preset is filtered out of the picker in the NVIDIA
// product mode — an unavailable preset is the skip signal (mirrors how other specs
// skip when a preset/backend isn't offered in the running product mode).

const STT_PRESET = 'Speech to Text'
// A real spoken-word WAV (generated offline via Windows SAPI) so Whisper has actual
// speech to transcribe rather than silence.
const FIXTURE_AUDIO = path.join(__dirname, 'fixtures', 'speech.wav')

test.describe('Speech to Text', () => {
  test('transcribes an uploaded audio file into text', async ({ app }) => {
    // Install + Whisper model download + a transcription turn exceed the default timeout.
    test.setTimeout(40 * 60_000)

    await app.installAllBackends()

    const available = await app.main.selectPreset('Audio', STT_PRESET)
    test.skip(
      !available,
      'OpenVINO is not installable in this product mode — the Speech to Text preset is hidden',
    )

    await test.step('Upload an audio file and expect a non-empty transcript', async () => {
      await app.main.uploadSttAudio(FIXTURE_AUDIO)
      // First transcription downloads the Whisper model via the same dialog.
      await app.resolveModelDownloadOrSkip('the Whisper transcription model')
      await app.main.waitForTranscript()
      expect(await app.main.lastAssistantText()).not.toEqual('')
    })
  })
})
