import { test } from './fixtures'

// Exercises the Blender MCP server: connect it from the Chat settings sidebar and have
// the agentic assistant invoke one of its tools. Blender itself need not be running in
// CI — the blender-mcp server still connects and advertises its tools over stdio, and
// the assertion of interest is that the agent wires the server up and *calls* a Blender
// tool (the tool card appears), not that a live Blender scene answers. The call may
// therefore Complete or Fail depending on whether Blender is reachable, so we only
// assert the card appears, never a successful result.
//
// Skips (rather than fails) when the server can't connect in this environment — e.g.
// `uvx` or network access is unavailable.

const BLENDER_SERVER = 'Blender MCP'
const BLENDER_SERVER_ID = 'blender'

const PROMPT =
  'Use your Blender MCP tools to fetch the current Blender scene information. ' +
  'Call the tool to do it.'

test.describe('MCP tools: Blender', () => {
  test('connects the Blender MCP server and invokes one of its tools', async ({ app }) => {
    // Install + connect the MCP server + a full agentic chat turn exceed the default timeout.
    test.setTimeout(30 * 60_000)

    await app.installAllBackends()

    const connected = await app.connectMcpServerOrSkip(BLENDER_SERVER)
    test.skip(
      !connected,
      `${BLENDER_SERVER} could not connect in this environment (uvx / network unavailable)`,
    )

    await test.step('Ask to use Blender → expect a Blender MCP tool call', async () => {
      await app.main.sendPrompt(PROMPT)
      // First use of the agentic chat model pulls it via the same download dialog.
      await app.resolveModelDownloadOrSkip('the agentic chat model')

      // Blender may not be running, so the tool call can complete OR fail — either way the
      // card proves the agent invoked a Blender tool. Don't assert a successful result.
      await app.main.waitForMcpToolCall(BLENDER_SERVER_ID)
      await app.main.waitUntilIdle()
    })
  })
})
