## Opencode, Electron, MCP DevTools Integration

For 'agentic debugging' in OpenCode, Chrome DevTools MCP can be used to inspect the running Vue Electron app.

**Usage:**

1. `npm run dev` (adjust `AIPG_DEBUGGING_PORT` in `package.json` if required)
2. Run `opencode`, press "Ctrl-P" and check "Toggle MCPs" shows "chrome-devtools connected" (config has it disabled per default)
3. In Opencode ask to:
   - `list pages`
   - `take snapshot`
   - `click button`
   - `list console messages`
   - `list network requests`

**Relevant files:**

- `.opencode/opencode.json` - MCP config for chrome-devtools-mcp connecting to port 29222
- `electron/main.ts` - Adds `app.commandLine.appendSwitch("remote-debugging-port", "29222")` during dev mode

**Sources:**

- [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) - MCP server for Chrome DevTools
