import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useErrors } from '@/assets/js/store/errors'
import type { SessionSummary } from '@/types/sessionIpc'

type IpcResult<T> = ({ success: true } & T) | { success: false; error: string }

/** The renderer's projection of the Session module: the Sessions panel rows and the open Session. */
export const useSessions = defineStore('sessions', () => {
  const errors = useErrors()

  const sessions = ref<Record<string, SessionSummary>>({})
  const openSessionId = ref<string | null>(null)
  const openTimeline = ref<unknown[]>([])

  const orderedSessions = computed(() =>
    Object.values(sessions.value).sort(
      (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
    ),
  )

  const openSession = computed(() =>
    openSessionId.value ? (sessions.value[openSessionId.value] ?? null) : null,
  )

  async function call<T>(
    code: string,
    run: () => Promise<IpcResult<T>>,
  ): Promise<({ success: true } & T) | null> {
    try {
      const result = await run()
      if (result.success) return result
      errors.report(new Error(result.error), { code, category: 'backend', surface: 'toast' })
    } catch (error) {
      errors.report(error, { code, category: 'backend', surface: 'toast' })
    }
    return null
  }

  function remember(session: SessionSummary): void {
    sessions.value = { ...sessions.value, [session.id]: session }
  }

  /** Hydrates the list and opens the newest Session, creating one when there is none. */
  async function init(): Promise<void> {
    const result = await call('sessions/list-failed', () => window.electronAPI.sessions.list())
    if (!result) return
    sessions.value = Object.fromEntries(result.sessions.map((session) => [session.id, session]))
    await openNewestOrCreate()
  }

  async function openNewestOrCreate(): Promise<void> {
    const newest = orderedSessions.value[0]
    if (newest) await open(newest.id)
    else await create()
  }

  async function create(): Promise<string | null> {
    const result = await call('sessions/create-failed', () => window.electronAPI.sessions.create())
    if (!result) return null
    remember(result.session)
    openSessionId.value = result.session.id
    openTimeline.value = []
    return result.session.id
  }

  async function open(id: string): Promise<void> {
    const result = await call('sessions/open-failed', () => window.electronAPI.sessions.open(id))
    if (!result) return
    const { timeline, ...summary } = result.session
    remember(summary)
    openSessionId.value = id
    openTimeline.value = timeline
  }

  async function rename(id: string, title: string): Promise<void> {
    const result = await call('sessions/rename-failed', () =>
      window.electronAPI.sessions.rename(id, title),
    )
    if (result) remember(result.session)
  }

  async function remove(id: string): Promise<void> {
    const result = await call('sessions/delete-failed', () =>
      window.electronAPI.sessions.delete(id),
    )
    if (!result) return
    const { [id]: _removed, ...rest } = sessions.value
    sessions.value = rest
    if (openSessionId.value !== id) return
    openSessionId.value = null
    openTimeline.value = []
    await openNewestOrCreate()
  }

  return {
    sessions,
    openSessionId,
    openTimeline,
    orderedSessions,
    openSession,
    init,
    create,
    open,
    rename,
    remove,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSessions, import.meta.hot))
}
