import { useActivities } from '@/assets/js/store/activities'
import { useErrors } from '@/assets/js/store/errors'
import { useTextInference } from '@/assets/js/store/textInference'
import { deserializeAppError } from '@/assets/js/errors/appError'
import {
  connectKernelEventStream,
  type KernelProjection,
} from '@/assets/js/projection/kernelProjection'
import type { KernelEvent, KernelSnapshot } from '@/types/kernelEvents'

/**
 * Projects kernel ledger events (step 14) onto the renderer sinks:
 * `activity` → activities store, `error` → errors store, `stored` of the
 * live inference profile → textInference. Renderer-local `begin` / `report`
 * stay for work that has not moved yet.
 */

let projection: KernelProjection | null = null

export function startKernelLedgerProjection(): void {
  if (projection) return
  const activities = useActivities()
  const errors = useErrors()
  const textInference = useTextInference()
  projection = connectKernelEventStream(
    (event) => applyLedgerEvent(activities, errors, textInference, event),
    (snapshot) => installKernelLedgerSnapshot(snapshot, activities, textInference),
  )
}

export function stopKernelLedgerProjection(): void {
  projection?.dispose()
  projection = null
}

function installKernelLedgerSnapshot(
  snapshot: KernelSnapshot,
  activities: ReturnType<typeof useActivities>,
  textInference: ReturnType<typeof useTextInference>,
): void {
  for (const activity of snapshot.state.activities) {
    if (activities.activeItems.some((item) => item.id === activity.id)) continue
    activities.begin({
      id: activity.id,
      category: activity.category,
      label: activity.label,
      detail: activity.detail,
      progress: activity.progress,
      scope: activity.scope,
      parentId: activity.parentId,
    })
  }
  textInference.applyInferenceProfile(snapshot.state.inferenceProfile)
}

function applyLedgerEvent(
  activities: ReturnType<typeof useActivities>,
  errors: ReturnType<typeof useErrors>,
  textInference: ReturnType<typeof useTextInference>,
  event: KernelEvent,
): void {
  if (event.type === 'activity') {
    if (event.action === 'begin') {
      if (activities.activeItems.some((item) => item.id === event.activity.id)) return
      activities.begin({
        id: event.activity.id,
        category: event.activity.category,
        label: event.activity.label,
        detail: event.activity.detail,
        progress: event.activity.progress,
        scope: event.activity.scope,
        parentId: event.activity.parentId,
      })
      return
    }
    if (event.action === 'update') {
      activities.update(event.activity.id, {
        label: event.activity.label,
        detail: event.activity.detail,
        progress: event.activity.progress,
      })
      return
    }
    activities.end(event.activity.id, event.activity.state)
    return
  }
  if (event.type === 'error') {
    errors.report(deserializeAppError(event.error), { surface: event.error.surface })
    return
  }
  if (event.type === 'stored' && event.kind === 'inference-profile') {
    textInference.applyInferenceProfile(event.inferenceProfile ?? null)
  }
}
