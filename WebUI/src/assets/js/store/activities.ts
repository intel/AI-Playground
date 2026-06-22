import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createActivity, type CreateActivityInput } from '../activities/activity'
import type { Activity, ActivityCategory, ActivityState } from '../activities/types'

const RECENT_ACTIVITY_LIMIT = 50

// Central activity sink. Mirrors the error sink (store/errors.ts): every
// long-running phase of the app reports here so there is one source of truth for
// "what is the app busy with" and the UI can render a consistent status line.
//
// Deliberately has NO store dependencies (like `errors` and `ui`) to avoid
// circular imports — producers push into it; consumers read from it. Reconciliation
// (ending stale activities) lives in the producing stores that already know when a
// turn finishes.
export const useActivities = defineStore('activities', () => {
  // Currently-running activities only. Ended ones move to `recent`.
  const items = ref<Activity[]>([])
  // Small ring buffer of finished activities, for a future debug panel.
  const recent = ref<Activity[]>([])

  const activeItems = computed(() => items.value)

  function begin(input: CreateActivityInput): string {
    const activity = createActivity(input)
    items.value = [...items.value, activity]
    return activity.id
  }

  function update(
    id: string,
    patch: Partial<Pick<Activity, 'label' | 'detail' | 'progress'>>,
  ): void {
    items.value = items.value.map((item) =>
      item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item,
    )
  }

  function end(id: string, state: ActivityState = 'done'): void {
    const activity = items.value.find((item) => item.id === id)
    if (!activity) return
    items.value = items.value.filter((item) => item.id !== id)
    recent.value = [{ ...activity, state, updatedAt: Date.now() }, ...recent.value].slice(
      0,
      RECENT_ACTIVITY_LIMIT,
    )
  }

  // Begin → run → settle. Guarantees the activity is ended even if `fn` throws,
  // so an activity can never get stuck (mirrors the generation watchdog work).
  async function track<T>(input: CreateActivityInput, fn: () => Promise<T>): Promise<T> {
    const id = begin(input)
    try {
      const result = await fn()
      end(id, 'done')
      return result
    } catch (error) {
      end(id, 'failed')
      throw error
    }
  }

  // Resolve the single activity to display for a chat turn: the innermost active
  // activity that is chat-scoped for `key`, or a descendant (via parentId) of one
  // (e.g. an image-gen phase started by a tool call in this conversation).
  // `exclude` lets a consumer skip categories it renders elsewhere (the in-turn
  // indicator excludes 'generation', which the inline ChatWorkflowResult owns).
  function chatActivity(key: string, exclude: ActivityCategory[] = []): Activity | null {
    const active = items.value
    const isChatRoot = (a: Activity) => a.scope.kind === 'chat' && a.scope.conversationKey === key

    const belongs = (a: Activity): boolean => {
      if (isChatRoot(a)) return true
      const seen = new Set<string>()
      let parentId = a.parentId
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId)
        const parent = active.find((item) => item.id === parentId)
        if (!parent) return false
        if (isChatRoot(parent)) return true
        parentId = parent.parentId
      }
      return false
    }

    const candidates = active.filter((a) => belongs(a) && !exclude.includes(a.category))
    if (candidates.length === 0) return null
    // Innermost ~= most recently started (children begin after their parents).
    return candidates.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a))
  }

  const imageGenActivity = computed<Activity | null>(() => {
    const candidates = items.value.filter((item) => item.scope.kind === 'imageGen')
    if (candidates.length === 0) return null
    return candidates.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a))
  })

  // Anti-stuck reconciliation: end any active activity matching `pred`. Producing
  // stores call this when a turn/generation finishes to clean up stragglers.
  function endScope(pred: (a: Activity) => boolean, state: ActivityState = 'cancelled'): void {
    const toEnd = items.value.filter(pred)
    toEnd.forEach((item) => end(item.id, state))
  }

  return {
    items,
    recent,
    activeItems,
    begin,
    update,
    end,
    track,
    chatActivity,
    imageGenActivity,
    endScope,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useActivities, import.meta.hot))
}
