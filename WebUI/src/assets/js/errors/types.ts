// Unified error model. See plan: a single typed AppError that every layer of the
// app produces, so the error sink (store/errors.ts) can apply one consistent
// surfacing policy instead of each call site inventing its own.

export type ErrorCategory =
  | 'backend' // service lifecycle (start/stop/setup/crash)
  | 'inference' // LLM chat / streaming / tool calling
  | 'generation' // ComfyUI image/video generation
  | 'setup' // first-run wizard / installation
  | 'channel' // Home Agent / Telegram / Slack (reserved for deferred phase 4)
  | 'validation' // user input / preconditions
  | 'unknown'

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'fatal'

// How the sink should present the error to the user. Defaults are derived from
// severity, but a producer can override (e.g. chat stream errors render inline
// in the prompt bar, so they are reported as 'inline' to avoid a duplicate toast).
export type ErrorSurface = 'toast' | 'inline' | 'modal' | 'silent'

export type AppErrorAction = {
  label: string
  run: () => void | Promise<void>
}

export type AppErrorContext = {
  serviceName?: string
  conversationKey?: string
  modelName?: string
  // Free-form extra context for logging/debugging. Kept serializable.
  [key: string]: unknown
}

export type AppError = {
  // Brand so isAppError() can distinguish a normalized AppError from a random object.
  readonly __isAppError: true
  // Stable machine-readable code, e.g. 'inference/backend-not-ready'.
  code: string
  category: ErrorCategory
  severity: ErrorSeverity
  surface: ErrorSurface
  // The only string shown to the user. Should be human-friendly and actionable.
  userMessage: string
  // Developer-facing detail for logs/debug panel (never shown as the primary message).
  technicalMessage: string
  context: AppErrorContext
  recoverable: boolean
  action?: AppErrorAction
  cause?: unknown
  timestamp: number
}

// Plain, structured-clone-safe shape for crossing the IPC boundary.
export type SerializedAppError = {
  code: string
  category: ErrorCategory
  severity: ErrorSeverity
  userMessage: string
  technicalMessage: string
  context: AppErrorContext
  recoverable: boolean
}
