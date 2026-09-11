import { app } from 'electron'

export const LOG_SOURCE = 'piAgentManager'

const ENV_TRUTHY = new Set(['1', 'true', 'yes', 'on'])

// What Settings → Developer last asked for; null until the renderer says.
let uiPreference: boolean | null = null

/** Push the Settings → Developer choice. `null` restores the default. */
export function setVerboseLogging(value: boolean | null): void {
  uiPreference = value
}

/**
 * Verbose Pi turn logging: the turn lifecycle and tool traffic flow into the app
 * logger. `AGENT_DEBUG` stays a one-shot override for a launch that has no UI
 * yet; otherwise the Settings → Developer checkbox decides, defaulting to on in
 * dev (`npm run dev`) and off in packaged builds.
 */
export function verboseLogging(): boolean {
  const envFlag = (process.env.AGENT_DEBUG ?? '').toLowerCase()
  if (envFlag) return ENV_TRUTHY.has(envFlag)
  return uiPreference ?? !app.isPackaged
}

/** Compact one value to a single log-friendly line, truncated. */
export function briefly(value: unknown, max = 300): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (!text) return ''
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}… (${oneLine.length} chars)` : oneLine
}
