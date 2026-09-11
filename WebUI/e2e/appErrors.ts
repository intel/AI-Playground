import { type Page } from '@playwright/test'

/**
 * Everything the app reported through `errors.report()`, recorded from the
 * renderer console.
 *
 * A failure that the app itself already diagnosed should say so, and until this
 * existed it usually did not. The app's own notice for a failed turn is a toast
 * — it fades in seconds — so an assertion that reads the screen a moment too
 * late finds an empty transcript and reports the *shape* of the damage ("the
 * conversation should hold 2 audio results") instead of the cause. That is what
 * turned an Intel XPU `UR_RESULT_ERROR_DEVICE_LOST` in the TTS sidecar, which
 * the app had caught, toasted and logged in full, into a bare count mismatch.
 *
 * `errors.report()` also writes every error to `console.error` as
 * `[<category>] <code>: <message>`, and that line is permanent. Recording those
 * as they arrive gives every wait in the suite a cause to quote, whatever the
 * screen looks like by the time it gives up.
 */

/** `[inference] inference/tts-failed: level_zero backend failed with error: 20` */
const APP_ERROR_LINE = /^\[[a-z]+\] [a-z]+\/[a-z0-9-]+: /i

const logs = new WeakMap<Page, string[]>()

/**
 * Start recording the app's reported errors for `page`. Called once per window,
 * from the fixture, before any test step runs.
 */
export function watchAppErrors(page: Page): void {
  const log: string[] = []
  logs.set(page, log)
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text().trim()
    if (APP_ERROR_LINE.test(text)) log.push(text)
  })
}

/** Errors reported so far. Empty for a page nobody is watching. */
export function appErrors(page: Page): readonly string[] {
  return logs.get(page) ?? []
}

/**
 * Run `step`, and if it fails, re-throw with whatever the app reported *while it
 * ran* appended. Errors from earlier steps are deliberately left out: a suite
 * that provokes failures on purpose (an unreachable MCP server, a cancelled
 * download) would otherwise blame every later timeout on them.
 */
export async function reportingAppErrors<T>(page: Page, step: () => Promise<T>): Promise<T> {
  const mark = appErrors(page).length
  try {
    return await step()
  } catch (failure) {
    const reported = appErrors(page).slice(mark)
    if (reported.length === 0) throw failure
    const cause = failure instanceof Error ? failure.message : String(failure)
    throw new Error(
      `${cause}\n\nThe app reported ${reported.length} error(s) while this step ran — ` +
        'one of them is likely the real cause:\n' +
        reported.map((line) => `  - ${line}`).join('\n'),
    )
  }
}
