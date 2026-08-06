import { test } from './fixtures'

// Assistant-on-NPU smoke: in the agentic "Assistant" preset, pin the OpenVINO backend
// and switch its inference device to the NPU, then confirm the model composes a haiku
// (a plain text reply). Skips where OpenVINO isn't offered in this product mode or the
// machine has no NPU inference device — NPU hardware is environment-specific. The
// default-GPU override from installAllBackends is irrelevant here: this test selects
// the NPU device explicitly afterwards.

const AGENTIC_PRESET = 'Assistant'
const HAIKU_PROMPT = 'Write a haiku about a friendly, goofy surfer-dude lizard.'

test.describe('NPU', () => {
  test('Assistant composes a haiku on the NPU (OpenVINO)', async ({ app }) => {
    // Install + backend restart on device switch + a text turn exceed the default timeout.
    test.setTimeout(30 * 60_000)

    await app.installAllBackends()

    await test.step('Switch to agentic mode (Chat + "Assistant" preset)', async () => {
      await app.main.selectPreset('Chat', AGENTIC_PRESET)
    })

    await app.runNpuHaiku(HAIKU_PROMPT)
  })
})
