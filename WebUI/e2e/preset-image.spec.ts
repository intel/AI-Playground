import { test } from './fixtures'
import { MainPage } from './pages/MainPage'
import type { ChatMode } from './pages/MainPage'
import type { ComfyOutput } from './appDriver'

// One smoke test per image preset (create-images → Image Gen, edit-images → Image
// Edit). Install backends, select the preset, load the fixture image into any
// reference-image slot the preset requires, generate, and assert the expected
// output media with no generation error. A preset not offered in the running
// product mode skips itself (see AppDriver.runComfyPreset).

type ImageCase = {
  preset: string
  mode: ChatMode
  needsImage?: boolean
  output?: ComfyOutput // defaults to 'image'
}

const CREATE_PROMPT =
  'A muscular, friendly, goofy surfer-dude lizard character for an animated film'
const EDIT_PROMPT = 'Give this character sunglasses and classic surfer hair'

const IMAGE_PRESETS: ImageCase[] = [
  // create-images (text-to-image, no input)
  { preset: 'Draft Image', mode: 'Image Gen' },
  { preset: 'HD Image', mode: 'Image Gen' },
  { preset: 'Pro Image', mode: 'Image Gen' },
  { preset: 'Pro 2 Image', mode: 'Image Gen' },
  { preset: 'Pro 3 Image', mode: 'Image Gen' },
  // 'Acer VisionArt' is intentionally excluded: it requires the AcerPartner/VisionArt
  // ComfyUI node, which talks to an external Acer "AICO" socket service only present on
  // Acer hardware. Without it the node hangs on socket recv (WinError 10057) and the
  // generation never completes, timing out this smoke test. Re-enable only on a machine
  // running the Acer AICO service.
  { preset: 'Manual', mode: 'Image Gen' },
  // create-images that need a reference image
  { preset: 'Control Face', mode: 'Image Gen', needsImage: true },
  // edit-images (all need an input image)
  { preset: 'Colorize', mode: 'Image Edit', needsImage: true },
  { preset: 'Change Face', mode: 'Image Edit', needsImage: true },
  { preset: 'Sketch to Photo', mode: 'Image Edit', needsImage: true },
  { preset: 'Edit By Prompt', mode: 'Image Edit', needsImage: true },
  { preset: 'Edit by Prompt 2', mode: 'Image Edit', needsImage: true },
  { preset: 'Inpaint', mode: 'Image Edit', needsImage: true },
  { preset: 'Outpaint', mode: 'Image Edit', needsImage: true },
  { preset: 'Upscale', mode: 'Image Edit', needsImage: true },
  { preset: 'Image To 3D Model', mode: 'Image Edit', needsImage: true, output: 'model3d' },
]

test.describe('Image presets', () => {
  for (const { preset, mode, needsImage, output } of IMAGE_PRESETS) {
    test(`"${preset}" preset generates ${output ?? 'an image'}`, async ({ app }) => {
      test.setTimeout(40 * 60_000)
      await app.installAllBackends()
      await app.runComfyPreset({
        mode,
        preset,
        output: output ?? 'image',
        prompt: mode === 'Image Edit' ? EDIT_PROMPT : CREATE_PROMPT,
        needsImage,
        timeout: MainPage.IMAGE_TIMEOUT,
      })
    })
  }
})
