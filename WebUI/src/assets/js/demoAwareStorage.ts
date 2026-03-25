/**
 * Storage adapter for pinia-plugin-persistedstate. When demo mode is enabled,
 * uses sessionStorage so persisted state is session-scoped and never touches
 * localStorage. Otherwise uses localStorage.
 */
function getStorage(): Storage {
  return (window.__AIPG_DEMO_MODE__ ?? false) ? sessionStorage : localStorage
}

export const demoAwareStorage = {
  getItem(key: string): string | null {
    return getStorage().getItem(key)
  },
  setItem(key: string, value: string): void {
    getStorage().setItem(key, value)
  },
}
