import {
  type Activity,
  type ActivityCategory,
  type ActivityScope,
  type ActivityState,
} from './types'

export type CreateActivityInput = {
  id?: string
  category?: ActivityCategory
  label: string
  detail?: string
  progress?: number
  scope?: ActivityScope
  parentId?: string
}

export function isActivity(value: unknown): value is Activity {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __isActivity?: unknown }).__isActivity === true
  )
}

function newActivityId(): string {
  // crypto.randomUUID is available in the renderer; fall back defensively.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `activity-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function createActivity(input: CreateActivityInput): Activity {
  const now = Date.now()
  const state: ActivityState = 'active'
  return {
    __isActivity: true,
    id: input.id ?? newActivityId(),
    category: input.category ?? 'unknown',
    label: input.label,
    detail: input.detail,
    progress: input.progress,
    scope: input.scope ?? { kind: 'global' },
    state,
    parentId: input.parentId,
    startedAt: now,
    updatedAt: now,
  }
}
