import { randomUUID } from 'node:crypto'
import type { ActivityCategory } from '@/assets/js/activities/types'
import { emitActivity } from '../kernel/kernelBus'

type TrackedActivity = {
  id: string
  category: ActivityCategory
  label: string
  detail?: string
  scope: { kind: 'chat'; conversationKey: string } | { kind: 'global' }
}

const live = new Map<string, TrackedActivity>()

/**
 * The status chip a tool used to draw through Pinia `activities.track`. Tools
 * that execute in main emit the same Activity on the kernel stream instead;
 * the renderer projects it (`kernelLedgerProjection`) into the same sink.
 *
 * `run` receives the activity id so a multi-phase tool can relabel itself
 * mid-flight through {@link updateChatToolActivity}.
 */
export async function trackChatToolActivity<T>(
  activity: {
    category: ActivityCategory
    label: string
    detail?: string
    conversationKey?: string
  },
  run: (activityId: string) => Promise<T>,
): Promise<T> {
  const base: TrackedActivity = {
    id: randomUUID(),
    category: activity.category,
    label: activity.label,
    ...(activity.detail ? { detail: activity.detail } : {}),
    scope: activity.conversationKey
      ? ({ kind: 'chat', conversationKey: activity.conversationKey } as const)
      : ({ kind: 'global' } as const),
  }
  live.set(base.id, base)
  emitActivity('begin', { ...base, state: 'active' })
  try {
    const result = await run(base.id)
    emitActivity('end', { ...live.get(base.id)!, state: 'done' })
    return result
  } catch (error) {
    emitActivity('end', { ...live.get(base.id)!, state: 'failed' })
    throw error
  } finally {
    live.delete(base.id)
  }
}

/** Relabels a running activity — a no-op once it has settled. */
export function updateChatToolActivity(
  activityId: string,
  patch: { label?: string; detail?: string },
): void {
  const current = live.get(activityId)
  if (!current) return
  const next: TrackedActivity = {
    ...current,
    ...(patch.label ? { label: patch.label } : {}),
    ...(patch.detail ? { detail: patch.detail } : {}),
  }
  live.set(activityId, next)
  emitActivity('update', { ...next, state: 'active' })
}
