import {
  type AppError,
  type AppErrorContext,
  type ErrorCategory,
  type ErrorSeverity,
  type ErrorSurface,
  type SerializedAppError,
} from './types'

const DEFAULT_SURFACE_BY_SEVERITY: Record<ErrorSeverity, ErrorSurface> = {
  info: 'toast',
  warning: 'toast',
  error: 'toast',
  fatal: 'toast',
}

export type CreateAppErrorInput = {
  code?: string
  category?: ErrorCategory
  severity?: ErrorSeverity
  surface?: ErrorSurface
  userMessage: string
  technicalMessage?: string
  context?: AppErrorContext
  recoverable?: boolean
  action?: AppError['action']
  cause?: unknown
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __isAppError?: unknown }).__isAppError === true
  )
}

export function createAppError(input: CreateAppErrorInput): AppError {
  const severity = input.severity ?? 'error'
  return {
    __isAppError: true,
    code: input.code ?? `${input.category ?? 'unknown'}/unspecified`,
    category: input.category ?? 'unknown',
    severity,
    surface: input.surface ?? DEFAULT_SURFACE_BY_SEVERITY[severity],
    userMessage: input.userMessage,
    technicalMessage: input.technicalMessage ?? input.userMessage,
    context: input.context ?? {},
    recoverable: input.recoverable ?? true,
    action: input.action,
    cause: input.cause,
    timestamp: Date.now(),
  }
}

// Pull a human-readable message out of anything that might have been thrown.
export function extractMessage(value: unknown): string {
  if (value == null) return 'Unknown error'
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  if (isAppError(value)) return value.technicalMessage
  if (typeof value === 'object') {
    const maybe = value as { message?: unknown; error?: unknown }
    if (typeof maybe.message === 'string') return maybe.message
    if (typeof maybe.error === 'string') return maybe.error
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

// Normalize anything (thrown Error, string, IPC failure object, AppError) into an
// AppError. `defaults` lets the catching layer attach category/code/userMessage
// without clobbering an already-typed AppError thrown from deeper down.
export function toAppError(value: unknown, defaults?: Partial<CreateAppErrorInput>): AppError {
  if (isAppError(value)) {
    // Already typed. Only fill gaps the producer left blank (e.g. context).
    if (defaults?.context) {
      return { ...value, context: { ...defaults.context, ...value.context } }
    }
    return value
  }

  const technicalMessage = extractMessage(value)
  return createAppError({
    code: defaults?.code,
    category: defaults?.category,
    severity: defaults?.severity,
    surface: defaults?.surface,
    userMessage: defaults?.userMessage ?? technicalMessage,
    technicalMessage,
    context: defaults?.context,
    recoverable: defaults?.recoverable,
    action: defaults?.action,
    cause: value,
  })
}

export function serializeAppError(error: AppError): SerializedAppError {
  return {
    code: error.code,
    category: error.category,
    severity: error.severity,
    userMessage: error.userMessage,
    technicalMessage: error.technicalMessage,
    context: error.context,
    recoverable: error.recoverable,
  }
}

export function deserializeAppError(serialized: SerializedAppError): AppError {
  return createAppError({ ...serialized })
}
