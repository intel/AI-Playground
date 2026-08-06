import { test, expect } from './fixtures'

// Exercises the DateTime MCP server end-to-end: connect it from the Chat settings
// sidebar, then have the agentic assistant answer a question that requires calling
// one of its tools (get_current_time / convert_time). Asserts the tool was actually
// invoked AND completed — not just that the model replied from memory.
//
// Skips (rather than fails) when the server can't connect in this environment — e.g.
// `uvx` or network access is unavailable — mirroring the suite's model-gated skips.

// mcp-dev.json: displayName is the row label; the server key ("datetime") is the
// prefix of the tool card header ("MCP tool call - datetime MCP - <tool>").
const DATETIME_SERVER = 'DateTime MCP'
const DATETIME_SERVER_ID = 'datetime'

const PROMPT =
  'Use your MCP tools to tell me the current date and time in the UTC timezone. ' +
  'Call the tool to get it — do not guess.'

test.describe('MCP tools: DateTime', () => {
  test('connects the DateTime MCP server and answers using its tool', async ({ app }) => {
    // Install + connect the MCP server + a full agentic chat turn exceed the default timeout.
    test.setTimeout(30 * 60_000)

    await app.installAllBackends()

    const connected = await app.connectMcpServerOrSkip(DATETIME_SERVER)
    test.skip(
      !connected,
      `${DATETIME_SERVER} could not connect in this environment (uvx / network unavailable)`,
    )

    await test.step('Ask for the time → expect a completed DateTime MCP tool call', async () => {
      await app.main.sendPrompt(PROMPT)
      // First use of the agentic chat model pulls it via the same download dialog.
      await app.resolveModelDownloadOrSkip('the agentic chat model')

      // The agent must invoke a datetime tool mid-turn…
      await app.main.waitForMcpToolCall(DATETIME_SERVER_ID)
      await app.main.waitUntilIdle()
      await app.main.assertNoGenerationError()
      // …and the call must have resolved successfully (the "Completed" pill on the card).
      await expect(
        app.main.mcpToolCallCompleted(DATETIME_SERVER_ID).first(),
        'the DateTime MCP tool call should complete successfully',
      ).toBeVisible({ timeout: 15_000 })
      await app.main.assertWellFormedResponse()
      expect(await app.main.lastAssistantText()).not.toEqual('')
    })
  })
})
