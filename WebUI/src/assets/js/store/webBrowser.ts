import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'

// Thin renderer-side wrapper over the `webBrowser:*` Electron IPC channels.
// The actual browser window lives in the main process
// (electron/subprocesses/webBrowserManager.ts); this store mirrors its state so
// the UI can show a "Show window" affordance while the chat LLM browses in the
// background. Deliberately has no store dependencies.
export const useWebBrowser = defineStore('webBrowser', () => {
  const isOpen = ref(false)
  const isVisible = ref(false)
  const currentUrl = ref('')
  const title = ref('')
  // True while a navigate/read/interact call is in flight.
  const isBusy = ref(false)

  function applyState(state: WebBrowserState): void {
    isOpen.value = state.isOpen
    isVisible.value = state.isVisible
    currentUrl.value = state.currentUrl
    title.value = state.title
  }

  // Keep state in sync with main-process pushes (show/hide/navigation/title).
  window.electronAPI.webBrowser.onStateChanged(applyState)

  async function refreshState(): Promise<void> {
    applyState(await window.electronAPI.webBrowser.getState())
  }

  async function navigate(url: string): Promise<WebPageSnapshot> {
    isBusy.value = true
    try {
      return await window.electronAPI.webBrowser.navigate(url)
    } finally {
      isBusy.value = false
    }
  }

  async function readPage(): Promise<WebPageSnapshot> {
    isBusy.value = true
    try {
      return await window.electronAPI.webBrowser.readPage()
    } finally {
      isBusy.value = false
    }
  }

  async function search(query: string, maxResults?: number): Promise<WebSearchResults> {
    isBusy.value = true
    try {
      return await window.electronAPI.webBrowser.search(query, maxResults)
    } finally {
      isBusy.value = false
    }
  }

  // Returns the current page as a base64-encoded PNG (no data: prefix).
  async function screenshot(): Promise<string> {
    isBusy.value = true
    try {
      return await window.electronAPI.webBrowser.screenshot()
    } finally {
      isBusy.value = false
    }
  }

  async function interact(interaction: WebBrowserInteraction): Promise<WebPageSnapshot> {
    isBusy.value = true
    try {
      return await window.electronAPI.webBrowser.interact(interaction)
    } finally {
      isBusy.value = false
    }
  }

  async function show(): Promise<void> {
    applyState(await window.electronAPI.webBrowser.show())
  }

  async function hide(): Promise<void> {
    applyState(await window.electronAPI.webBrowser.hide())
  }

  async function close(): Promise<void> {
    applyState(await window.electronAPI.webBrowser.close())
  }

  return {
    isOpen,
    isVisible,
    currentUrl,
    title,
    isBusy,
    refreshState,
    navigate,
    readPage,
    search,
    screenshot,
    interact,
    show,
    hide,
    close,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWebBrowser, import.meta.hot))
}
