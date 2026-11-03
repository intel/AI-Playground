import { useActivities } from '@/assets/js/store/activities'
import { useI18N } from '@/assets/js/store/i18n'
import { queueOrdinal } from '@/assets/js/store/recordRows'
import type { KernelQueueEvent, TurnWork } from '@/types/kernelEvents'

// ── Queue-event projection (architecture-target §4.4, step 7) ──────────────────
//
// The orchestrator's queue is main-side; its lifecycle crosses the kernel bus
// as `queue-event`. What the renderer does with it is deliberately narrow:
// a chat tool's own "Generating image…" activity already covers the wait, so
// while its run is PARKED the activity is relabelled with its queue position
// and restored when the run starts or is cancelled while queued. Panel runs
// carry no activityId — a panel run waiting in the Turn Queue is labelled on the
// generation overlay by the imageGenerationPresets store, with `turnQueuedLabel`.
// A Chat / Home Agent turn waiting in the Turn Queue gets its own chat-scoped
// activity ("Queued (2nd), waiting for …") until it takes the place; agent
// turns show their wait on the session instead.

type I18nState = ReturnType<typeof useI18N>['state']

let unsubscribe: (() => void) | null = null
const stashed = new Map<string, { activityId: string; label: string }>()
const queuedTurns = new Map<string, string>()

const WAITING_FOR_KEYS: Record<TurnWork, string> = {
  agent: 'COM_ACTIVITY_TURN_QUEUED_FOR_AGENT',
  chat: 'COM_ACTIVITY_TURN_QUEUED_FOR_CHAT',
  summary: 'COM_ACTIVITY_TURN_QUEUED_FOR_SUMMARY',
  generation: 'COM_ACTIVITY_TURN_QUEUED_FOR_GENERATION',
}

export function startQueueActivityProjection(): void {
  if (unsubscribe) return
  const subscribe = window.electronAPI?.onKernelEvent
  if (!subscribe) return
  const activities = useActivities()
  const i18n = useI18N()
  unsubscribe = subscribe((event) => {
    if (event.type !== 'queue-event') return
    if (event.kind === 'text') applyTurnQueueEvent(activities, i18n, event)
    else applyQueueEvent(activities, i18n.state, event)
  })
}

export function stopQueueActivityProjection(): void {
  unsubscribe?.()
  unsubscribe = null
  stashed.clear()
  queuedTurns.clear()
}

function applyTurnQueueEvent(
  activities: ReturnType<typeof useActivities>,
  i18n: ReturnType<typeof useI18N>,
  event: KernelQueueEvent,
): void {
  if (event.work !== 'chat' || !event.conversationKey) return
  const activityId = queuedTurns.get(event.runKey)
  if (event.position === undefined) {
    if (!activityId) return
    queuedTurns.delete(event.runKey)
    activities.end(activityId)
    return
  }
  const label = turnQueuedLabel(i18n.state, i18n.langName, event.position, event.holder)
  if (activityId) {
    activities.update(activityId, { label })
    return
  }
  queuedTurns.set(
    event.runKey,
    activities.begin({
      category: 'backend',
      label,
      scope: { kind: 'chat', conversationKey: event.conversationKey },
    }),
  )
}

/** "Queued (2nd), waiting for …" for a Turn Queue member at `position`. */
export function turnQueuedLabel(
  i18nState: I18nState,
  locale: string,
  position: number,
  holder: TurnWork | undefined,
): string {
  const pattern = i18nState[holder ? WAITING_FOR_KEYS[holder] : 'COM_ACTIVITY_TURN_QUEUED']
  return (pattern ?? '').replace('{position}', queueOrdinal(position, locale, i18nState))
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
