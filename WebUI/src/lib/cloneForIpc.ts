/** Electron IPC structured-clone rejects Vue proxies; Pinia persist went through JSON. */
export function cloneForIpc<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
