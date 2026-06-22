import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'
import * as toast from '../toast'
import { CANCELLED_CODE, toAppError, type CreateAppErrorInput } from '../errors/appError'
import type { AppError, ErrorSeverity } from '../errors/types'

const RECENT_ERROR_LIMIT = 50

// Central error sink. Every layer routes failures here via report(); this store
// owns the single surfacing policy (toast/inline/modal/silent) so the same class
// of failure always looks the same to the user, and keeps a ring buffer of recent
// errors for the debug panel and for global-capture diagnostics.
export const useErrors = defineStore('errors', () => {
  const recentErrors = ref<AppError[]>([])
  const lastError = ref<AppError | null>(null)
  // Tracks AppError objects already handled, so an error that is reported and then
  // rethrown (and caught/reported again higher up, or resurfacing as an unhandled
  // rejection) is not logged or toasted twice. Identity is preserved because
  // toAppError() returns the same branded object when handed an AppError.
  const handled = new WeakSet<AppError>()

  function toastFor(error: AppError) {
    const showAs: ErrorSeverity = error.severity
    if (showAs === 'fatal' || showAs === 'error') {
      toast.error(error.userMessage)
    } else if (showAs === 'warning') {
      toast.warning(error.userMessage)
    } else {
      toast.show(error.userMessage)
    }
  }

  // Normalize → log → console → surface. Returns the normalized AppError so callers
  // can also drive local inline state from the same object if they wish.
  function report(value: unknown, defaults?: Partial<CreateAppErrorInput>): AppError {
    const error = toAppError(value, defaults)

    // Already handled (reported deeper down then rethrown) — don't double-surface.
    if (handled.has(error)) return error
    handled.add(error)

    lastError.value = error
    recentErrors.value = [error, ...recentErrors.value].slice(0, RECENT_ERROR_LIMIT)

    // Technical detail always goes to the console (mirrors prior console.error
    // behavior), except a deliberate user cancellation is benign: log it at debug
    // level so it doesn't read as a failure (and it never toasts, see surface).
    const log = error.code === CANCELLED_CODE ? console.debug : console.error
    log(`[${error.category}] ${error.code}: ${error.technicalMessage}`, error.cause ?? '')

    switch (error.surface) {
      case 'toast':
      case 'modal': // modal infra not yet built; fall back to toast so nothing is lost
        toastFor(error)
        break
      case 'inline':
      case 'silent':
        // Caller is responsible for rendering (e.g. inline in the prompt bar).
        break
    }

    return error
  }

  function clear() {
    recentErrors.value = []
    lastError.value = null
  }

  return {
    recentErrors,
    lastError,
    report,
    clear,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useErrors, import.meta.hot))
}
