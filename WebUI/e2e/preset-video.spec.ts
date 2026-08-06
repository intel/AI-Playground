import { test } from './fixtures'
import { MainPage } from './pages/MainPage'

// One smoke test per video preset (create-videos → Video mode). Install backends,
// select the preset, load the fixture image for image-to-video presets, generate,
// and assert a video is produced with no generation error. A preset not offered in
// the running product mode skips itself (see AppDriver.runComfyPreset).

const ANIMATE_PROMPT =
  'Bring this scene to life: a friendly, goofy surfer-dude character waving hi with gentle motion'

const VIDEO_PRESETS: { preset: string; needsImage?: boolean }[] = [
  { preset: 'LTX-2.3' }, // text-to-video
  { preset: 'LTX-2.3-i2v', needsImage: true }, // image-to-video
  // LTX-Video defaults to its Text2Video variant (text-to-video), which drops the
  // reference-image input — so it takes no input image, like LTX-2.3.
  { preset: 'LTX-Video' },
  { preset: 'Wan2.2-14B-i2v', needsImage: true },
]

test.describe('Video presets', () => {
  for (const { preset, needsImage } of VIDEO_PRESETS) {
    test(`"${preset}" preset generates a video`, async ({ app }) => {
      test.setTimeout(50 * 60_000)
      await app.installAllBackends()
      await app.runComfyPreset({
        mode: 'Video',
        preset,
        output: 'video',
        prompt: ANIMATE_PROMPT,
        needsImage,
        timeout: MainPage.VIDEO_TIMEOUT,
      })
    })
  }
})
