import type { HomeAgentInvokeChannelName, InvokeHandlerMap } from '../ipcRegistries'
import type { HomeAgentBackendService } from '../../adapters/backends/homeAgentBackendService'

// The channel methods the homeAgent-owned rows close over. The service keeps
// the gating (registerIpcHandlers runs only when the service exists); this
// builder is pure wiring, so a missing handler or an unhandled new row is a
// compile error exactly like the main-owned registries.
export type HomeAgentDeps = Pick<
  HomeAgentBackendService,
  | 'saveChannelConfig'
  | 'loadChannelConfig'
  | 'clearChannelConfig'
  | 'saveChannelPrefs'
  | 'loadChannelPrefs'
  | 'getLocalWebUrls'
  | 'channelTest'
  | 'channelSetConfig'
  | 'channelDetectIdentity'
  | 'channelDetectIdentityFromSaved'
  | 'channelPoll'
  | 'channelFlushPending'
  | 'channelSend'
>

export function buildHomeAgentRegistry(deps: HomeAgentDeps) {
  return {
    // Persistence — channel-keyed by first arg.
    'channel:saveConfig': (_event, kind, config) => deps.saveChannelConfig(kind, config),
    'channel:loadConfig': (_event, kind) => deps.loadChannelConfig(kind),
    'channel:clearConfig': (_event, kind) => deps.clearChannelConfig(kind),
    'channel:savePrefs': (_event, kind, prefs) => deps.saveChannelPrefs(kind, prefs),
    'channel:loadPrefs': (_event, kind) => deps.loadChannelPrefs(kind),

    // Local web chat: expose the URLs the served page is reachable at.
    // Pure OS-info lookup — the chat server itself lives in the Python backend.
    'homeAgent:localWeb:getUrls': (_event, port, allowLan) =>
      deps.getLocalWebUrls(port, !!allowLan),

    // Backend dispatch — channel-keyed by first arg.
    'channel:test': (_event, kind) => deps.channelTest(kind),
    'channel:inject': (_event, kind, config) => deps.channelSetConfig(kind, config),
    'channel:detectIdentity': (_event, kind, config) => deps.channelDetectIdentity(kind, config),
    'channel:detectIdentityFromSaved': (_event, kind) => deps.channelDetectIdentityFromSaved(kind),
    'channel:poll': (_event, kind) => deps.channelPoll(kind),
    'channel:flushPending': (_event, kind) => deps.channelFlushPending(kind),
    'channel:send': (_event, kind, action, payload) => deps.channelSend(kind, action, payload),
  } satisfies InvokeHandlerMap<HomeAgentInvokeChannelName>
}
