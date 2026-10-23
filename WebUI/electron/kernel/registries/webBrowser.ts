import type { WebBrowserInvokeName, InvokeHandlerMap } from '../ipcRegistries'
import type {
  close as closeWebBrowser,
  getState as getWebBrowserState,
  hide as hideWebBrowser,
  interact as interactWebBrowser,
  navigate as navigateWebBrowser,
  readPage as readWebBrowserPage,
  screenshot as screenshotWebBrowser,
  search as searchWebBrowser,
  show as showWebBrowser,
  WebBrowserInteraction,
} from '../../adapters/webBrowserManager'

/** The hidden-window browser operations the nine webBrowser handlers close over. */
export type WebBrowserDeps = {
  navigateWebBrowser: typeof navigateWebBrowser
  readWebBrowserPage: typeof readWebBrowserPage
  searchWebBrowser: typeof searchWebBrowser
  interactWebBrowser: typeof interactWebBrowser
  screenshotWebBrowser: typeof screenshotWebBrowser
  showWebBrowser: typeof showWebBrowser
  hideWebBrowser: typeof hideWebBrowser
  closeWebBrowser: typeof closeWebBrowser
  getWebBrowserState: typeof getWebBrowserState
}

export function buildWebBrowserRegistry(deps: WebBrowserDeps) {
  // Drives the headless BrowserWindow that the chat LLM uses to browse the
  // web (see adapters/webBrowserManager.ts).
  return {
    'webBrowser:navigate': async (_event, url: string) => {
      return await deps.navigateWebBrowser(url)
    },
    'webBrowser:readPage': async () => {
      return await deps.readWebBrowserPage()
    },
    'webBrowser:search': async (_event, query: string, maxResults?: number) => {
      return await deps.searchWebBrowser(query, maxResults)
    },
    'webBrowser:interact': async (_event, interaction: WebBrowserInteraction) => {
      return await deps.interactWebBrowser(interaction)
    },
    'webBrowser:screenshot': async () => {
      return await deps.screenshotWebBrowser()
    },
    'webBrowser:show': () => {
      return deps.showWebBrowser()
    },
    'webBrowser:hide': () => {
      return deps.hideWebBrowser()
    },
    'webBrowser:close': () => {
      return deps.closeWebBrowser()
    },
    'webBrowser:getState': () => {
      return deps.getWebBrowserState()
    },
  } satisfies InvokeHandlerMap<WebBrowserInvokeName>
}
