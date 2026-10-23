import { useActivities } from '@/assets/js/store/activities'
import { useI18N } from '@/assets/js/store/i18n'
import type { KernelQueueEvent } from '@/types/kernelEvents'

// ── Queue-event projection (architecture-target §4.4, step 7) ──────────────────
//
// The orchestrator's queue is main-side; its lifecycle crosses the kernel bus
// as `queue-event`. What the renderer does with it is deliberately narrow:
// a chat tool's own "Generating image…" activity already covers the wait, so
// while its run is PARKED the activity is relabelled with its queue position
// and restored when the run starts or is cancelled while queued. Panel runs
// and chat-turn `text` occupancy carry no activityId — panel waiting is the
// generation FSM's `queued` phase; text occupancy is kernel visibility.

let unsubscribe: (() => void) | null = null
const stashed = new Map<string, { activityId: string; label: string }>()

export function startQueueActivityProjection(): void {
  if (unsubscribe) return
  const subscribe = window.electronAPI?.onKernelEvent
  if (!subscribe) return
  const activities = useActivities()
  const i18nState = useI18N().state
  unsubscribe = subscribe((event) => {
    if (event.type !== 'queue-event') return
    applyQueueEvent(activities, i18nState, event)
  })
}

export function stopQueueActivityProjection(): void {
  unsubscribe?.()
  unsubscribe = null
  stashed.clear()
}

function applyQueueEvent(
  activities: ReturnType<typeof useActivities>,
  i18nState: Record<string, string>,
  event: KernelQueueEvent,
): void {
  if (!event.activityId) return
  if (event.action === 'enqueued') {
    const activity = activities.activeItems.find((item) => item.id === event.activityId)
    if (!activity) return
    // Idempotent on a duplicate enqueue: the stash must hold the original
    // label, not the relabelled text a first pass wrote.
    if (!stashed.has(event.runKey)) {
      stashed.set(event.runKey, { activityId: event.activityId, label: activity.label })
    }
    // queueDepth counts the entries waiting behind this one; the active run
    // is ahead of it too.
    const ahead = event.queueDepth + 1
    activities.update(event.activityId, {
      label: i18nState.COM_ACTIVITY_QUEUED_BEHIND.replace('{count}', String(ahead)),
    })
    return
  }
  const stash = stashed.get(event.runKey)
  if (!stash) return
  stashed.delete(event.runKey)
  // Cancel-while-queued emits `finished` without `started`; restoring on
  // either is a no-op if the other already cleared the stash.
  if (event.action === 'started' || event.action === 'finished') {
    activities.update(stash.activityId, { label: stash.label })
  }
}
