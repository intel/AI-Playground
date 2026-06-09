import { BrowserWindow } from 'electron'
import { appLoggerInstance } from '../logging/logger'

const appLogger = appLoggerInstance

// A single, reusable browser window the chat LLM drives via the `webBrowser:*`
// IPC channels. It is hidden by default (the model browses in the background)
// and can be revealed on demand from the renderer. The window uses an isolated,
// sandboxed session so its cookies/storage never mix with the AI Playground app.

export type WebPageLink = {
  index: number
  text: string
  href: string
}

export type WebPageSnapshot = {
  title: string
  url: string
  text: string
  links: WebPageLink[]
}

export type WebBrowserState = {
  isOpen: boolean
  isVisible: boolean
  currentUrl: string
  title: string
}

export type WebBrowserInteraction =
  | { action: 'click'; linkIndex?: number; selector?: string }
  | { action: 'scroll'; selector?: string }
  | { action: 'back' }

export type WebSearchResult = {
  title: string
  url: string
  snippet: string
}

export type WebSearchResults = {
  query: string
  results: WebSearchResult[]
}

const PARTITION = 'persist:webbrowser'
// A plain Chrome UA so sites don't serve degraded markup to "Electron".
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const NAV_TIMEOUT_MS = 30_000
const CLICK_NAV_TIMEOUT_MS = 6_000
const MAX_TEXT_LENGTH = 8_000
const MAX_LINKS = 50
const DEFAULT_MAX_SEARCH_RESULTS = 8
const MAX_SEARCH_RESULT_TITLE = 300
const MAX_SEARCH_RESULT_SNIPPET = 500

// Collects the page's visible text and salient links. Kept in sync with the
// click handler so a `linkIndex` returned by `readPage` resolves to the same
// anchor when interacting.
const READ_SCRIPT = `(() => {
  const text = document.body && document.body.innerText ? document.body.innerText : ''
  const anchors = Array.from(document.querySelectorAll('a[href]'))
  const links = []
  for (const a of anchors) {
    const href = a.href
    if (!href || !/^https?:/i.test(href)) continue
    const t = (a.innerText || a.textContent || '').trim().replace(/\\s+/g, ' ')
    if (!t) continue
    links.push({ text: t.slice(0, 200), href })
    if (links.length >= ${MAX_LINKS}) break
  }
  return { title: document.title, url: location.href, text, links }
})()`

let browserWin: BrowserWindow | null = null
let mainWin: BrowserWindow | null = null
let currentUrl = ''
let currentTitle = ''
// Set during app shutdown / main-window close so the window actually closes
// instead of merely hiding (see the `close` handler below).
let forceClose = false

export function setWebBrowserMainWindow(win: BrowserWindow): void {
  mainWin = win
}

export function getState(): WebBrowserState {
  const open = !!(browserWin && !browserWin.isDestroyed())
  return {
    isOpen: open,
    isVisible: open ? browserWin!.isVisible() : false,
    currentUrl,
    title: currentTitle,
  }
}

function emitState(): void {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('webBrowser:stateChanged', getState())
  }
}

function normalizeUrl(url: string): string {
  const trimmed = (url ?? '').trim()
  if (!trimmed) throw new Error('No URL provided')
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const parsed = new URL(withScheme)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`)
  }
  return parsed.toString()
}

function ensureWindow(): BrowserWindow {
  if (browserWin && !browserWin.isDestroyed()) return browserWin

  browserWin = new BrowserWindow({
    title: 'AI Playground — Web Browser',
    show: false,
    width: 1280,
    height: 900,
    autoHideMenuBar: true,
    parent: mainWin ?? undefined,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Keep rendering/JS running while hidden so background browsing works.
      backgroundThrottling: false,
      devTools: false,
    },
  })

  const wc = browserWin.webContents
  browserWin.setMenu(null)
  wc.setUserAgent(USER_AGENT)

  // Never spawn extra windows; keep everything in this single tab.
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))

  // Restrict navigation to http(s).
  wc.on('will-navigate', (event, url) => {
    if (!/^https?:\/\//i.test(url)) {
      event.preventDefault()
      appLogger.warn(`Blocked navigation to non-http(s) URL: ${url}`, 'web-browser')
    }
  })

  wc.on('page-title-updated', (_event, title) => {
    currentTitle = title
    emitState()
  })

  browserWin.on('show', emitState)
  browserWin.on('hide', emitState)

  // The user closing the window only hides it — background browsing continues.
  // During app shutdown `forceClose` is set so it can actually close.
  browserWin.on('close', (event) => {
    if (forceClose) return
    event.preventDefault()
    browserWin?.hide()
    emitState()
  })

  browserWin.on('closed', () => {
    browserWin = null
    currentUrl = ''
    currentTitle = ''
    emitState()
  })

  return browserWin
}

function loadUrl(win: BrowserWindow, url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const wc = win.webContents

    const cleanup = () => {
      clearTimeout(timer)
      wc.off('did-finish-load', onFinish)
      wc.off('did-fail-load', onFail)
    }
    const onFinish = () => {
      cleanup()
      resolve()
    }
    const onFail = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      _validatedURL: string,
      isMainFrame: boolean,
    ) => {
      // ERR_ABORTED (-3) fires on redirects / superseded loads; ignore it.
      if (!isMainFrame || errorCode === -3) return
      cleanup()
      reject(new Error(`Failed to load ${url}: ${errorDescription} (${errorCode})`))
    }
    // Resolve on timeout rather than reject so the model can still read whatever
    // content managed to load within the window.
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, NAV_TIMEOUT_MS)

    wc.once('did-finish-load', onFinish)
    wc.on('did-fail-load', onFail)
    wc.loadURL(url).catch((err) => {
      cleanup()
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })
}

// Waits for a navigation triggered by an interaction (e.g. a click), but
// resolves after a short timeout for SPA / in-page updates that never fire a
// full load.
function waitForPossibleNavigation(win: BrowserWindow, ms = CLICK_NAV_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    const wc = win.webContents
    const finish = () => {
      clearTimeout(timer)
      wc.off('did-finish-load', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    wc.once('did-finish-load', finish)
  })
}

export async function readPage(): Promise<WebPageSnapshot> {
  const win = ensureWindow()
  const raw = (await win.webContents.executeJavaScript(READ_SCRIPT, true)) as {
    title?: string
    url?: string
    text?: string
    links?: { text: string; href: string }[]
  }
  currentUrl = raw.url ?? currentUrl
  currentTitle = raw.title ?? currentTitle
  const links: WebPageLink[] = (raw.links ?? []).map((l, index) => ({
    index,
    text: l.text,
    href: l.href,
  }))
  const text = String(raw.text ?? '').slice(0, MAX_TEXT_LENGTH)
  emitState()
  return { title: currentTitle, url: currentUrl, text, links }
}

export async function navigate(url: string): Promise<WebPageSnapshot> {
  const normalized = normalizeUrl(url)
  const win = ensureWindow()
  appLogger.info(`Navigating web browser to ${normalized}`, 'web-browser')
  await loadUrl(win, normalized)
  currentUrl = win.webContents.getURL()
  currentTitle = win.webContents.getTitle()
  emitState()
  return await readPage()
}

// Parses DuckDuckGo's HTML results page into clean {title, url, snippet}. The
// result links are redirect URLs (`//duckduckgo.com/l/?uddg=<real url>`), so we
// decode the `uddg` param back to the real target. Ad rows are skipped.
function buildSearchScript(maxResults: number): string {
  return `(() => {
    const out = []
    const nodes = document.querySelectorAll('.result, .web-result, .results_links')
    for (const node of nodes) {
      if (node.classList && node.classList.contains('result--ad')) continue
      const a = node.querySelector('a.result__a') || node.querySelector('h2 a') || node.querySelector('a.result__url')
      if (!a) continue
      let href = a.href
      try {
        const u = new URL(href, location.href)
        const uddg = u.searchParams.get('uddg')
        if (uddg) href = uddg
      } catch (e) {}
      if (!/^https?:/i.test(href)) continue
      const title = (a.innerText || a.textContent || '').trim().replace(/\\s+/g, ' ')
      if (!title) continue
      const snippetEl = node.querySelector('.result__snippet, .result-snippet')
      const snippet = snippetEl ? (snippetEl.innerText || snippetEl.textContent || '').trim().replace(/\\s+/g, ' ') : ''
      out.push({
        title: title.slice(0, ${MAX_SEARCH_RESULT_TITLE}),
        url: href,
        snippet: snippet.slice(0, ${MAX_SEARCH_RESULT_SNIPPET}),
      })
      if (out.length >= ${maxResults}) break
    }
    return out
  })()`
}

export async function search(
  query: string,
  maxResults: number = DEFAULT_MAX_SEARCH_RESULTS,
): Promise<WebSearchResults> {
  const trimmed = (query ?? '').trim()
  if (!trimmed) throw new Error('No search query provided')
  const limit = Math.max(1, Math.min(maxResults || DEFAULT_MAX_SEARCH_RESULTS, MAX_LINKS))
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`
  const win = ensureWindow()
  appLogger.info(`Searching web for: ${trimmed}`, 'web-browser')
  await loadUrl(win, url)
  currentUrl = win.webContents.getURL()
  currentTitle = win.webContents.getTitle()
  const results = (await win.webContents.executeJavaScript(
    buildSearchScript(limit),
    true,
  )) as WebSearchResult[]
  emitState()
  return { query: trimmed, results: results ?? [] }
}

export async function interact(interaction: WebBrowserInteraction): Promise<WebPageSnapshot> {
  const win = ensureWindow()
  const wc = win.webContents

  switch (interaction.action) {
    case 'back': {
      if (wc.navigationHistory.canGoBack()) {
        wc.navigationHistory.goBack()
        await waitForPossibleNavigation(win)
      }
      break
    }
    case 'scroll': {
      const selector = interaction.selector
      const script = selector
        ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.scrollIntoView({ block: 'center' }); return true })()`
        : `(() => { window.scrollBy(0, window.innerHeight); return true })()`
      await wc.executeJavaScript(script, true)
      break
    }
    case 'click': {
      if (interaction.selector) {
        const clicked = (await wc.executeJavaScript(
          `(() => { const el = document.querySelector(${JSON.stringify(interaction.selector)}); if (!el) return false; el.click(); return true })()`,
          true,
        )) as boolean
        if (!clicked) {
          throw new Error(`No element matched selector: ${interaction.selector}`)
        }
        await waitForPossibleNavigation(win)
      } else if (typeof interaction.linkIndex === 'number') {
        // Resolve the same filtered anchor list `readPage` exposes, then
        // navigate to its href (robust across SPA / handler-based links).
        const href = (await wc.executeJavaScript(
          `(() => {
            const anchors = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
              const t = (a.innerText || a.textContent || '').trim()
              return t && /^https?:/i.test(a.href)
            })
            const el = anchors[${interaction.linkIndex}]
            return el ? el.href : null
          })()`,
          true,
        )) as string | null
        if (!href) {
          throw new Error(`No link at index ${interaction.linkIndex}`)
        }
        return await navigate(href)
      } else {
        throw new Error('click requires either a linkIndex or a selector')
      }
      break
    }
  }

  return await readPage()
}

export async function screenshot(): Promise<string> {
  const win = ensureWindow()
  const image = await win.webContents.capturePage()
  return image.toPNG().toString('base64')
}

export function show(): WebBrowserState {
  const win = ensureWindow()
  win.show()
  win.focus()
  emitState()
  return getState()
}

export function hide(): WebBrowserState {
  if (browserWin && !browserWin.isDestroyed()) {
    browserWin.hide()
    emitState()
  }
  return getState()
}

export function close(): WebBrowserState {
  destroyWebBrowser()
  return getState()
}

// Actually destroys the window (bypassing the hide-on-close behavior). Called
// on app shutdown and main-window close so the app can quit cleanly.
export function destroyWebBrowser(): void {
  if (browserWin && !browserWin.isDestroyed()) {
    forceClose = true
    browserWin.destroy()
  }
  browserWin = null
  currentUrl = ''
  currentTitle = ''
}
