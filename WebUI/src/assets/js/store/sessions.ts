import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { connectKernelEventStream } from '@/assets/js/projection/kernelProjection'
import { useErrors } from '@/assets/js/store/errors'
import type {
  SessionDocument,
  SessionLastPreset,
  SessionSummary,
  SessionTurn,
  SessionTurns,
} from '@/types/sessionIpc'
import type { MediaTurnData } from '@/types/sessionTimeline'

/** A panel run submitted in a Session whose turn has not settled into its timeline yet. */
export type PendingMediaTurn = {
  runId: string
  mode: MediaTurnData['mode']
  preset: string
  prompt: string
  createdAt: number
}

type IpcResult<T> = ({ success: true } & T) | { success: false; error: string }

/** The renderer's projection of the Session module: the Sessions panel rows and the open Session. */
export const useSessions = defineStore('sessions', () => {
  const errors = useErrors()

  const sessions = ref<Record<string, SessionSummary>>({})
  const openSessionId = ref<string | null>(null)
  const openTimeline = ref<unknown[]>([])
  /** Artifact URLs of the open Session whose file was deleted; their cards say so. */
  const openDeletedFiles = ref<string[]>([])
  const pendingTurns = ref<Record<string, PendingMediaTurn>>({})

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

  function applyChanged(document: SessionDocument): void {
    const { timeline, ...summary } = document
    remember(summary)
    if (openSessionId.value === document.id) openTimeline.value = timeline
  }

  /** Each Session's turn in flight, as main's ledger has it. */
  const turns = ref<SessionTurns>({})
  /** Sessions whose turn ended while another was open; cleared when opened. */
  const unseen = ref<Record<string, true>>({})

  function applyTurns(next: SessionTurns): void {
    const ended = Object.keys(turns.value).filter(
      (id) => !next[id] && id !== openSessionId.value && sessions.value[id],
    )
    turns.value = next
    if (ended.length === 0) return
    unseen.value = { ...unseen.value, ...Object.fromEntries(ended.map((id) => [id, true])) }
  }

  const projection = connectKernelEventStream(
    (event) => {
      if (event.type === 'session-changed') applyChanged(event.session)
      if (event.type === 'session-turns') applyTurns(event.turns)
    },
    (snapshot) => {
      turns.value = { ...snapshot.state.sessionTurns }
    },
  )

  const openTurn = computed<SessionTurn | null>(() =>
    openSessionId.value ? (turns.value[openSessionId.value] ?? null) : null,
  )

  watch(openSessionId, (id) => {
    if (!id || !unseen.value[id]) return
    const { [id]: _seen, ...rest } = unseen.value
    unseen.value = rest
  })
  projection.ready.catch((error: unknown) => errors.report(error, { surface: 'silent' }))
  if (import.meta.hot) {
    import.meta.hot.dispose(() => projection.dispose())
  }

  /** The open Session, creating one when none is open yet. */
  async function ensureOpenSession(): Promise<string | null> {
    return openSessionId.value ?? (await create())
  }

  function isFileDeleted(url: string): boolean {
    return openDeletedFiles.value.includes(url)
  }

  function markFileDeleted(sessionId: string, url: string): void {
    if (openSessionId.value !== sessionId || isFileDeleted(url)) return
    openDeletedFiles.value = [...openDeletedFiles.value, url]
  }

  function beginMediaTurn(sessionId: string, turn: PendingMediaTurn): void {
    pendingTurns.value = { ...pendingTurns.value, [sessionId]: turn }
  }

  function endMediaTurn(sessionId: string, runId: string): void {
    if (pendingTurns.value[sessionId]?.runId !== runId) return
    const { [sessionId]: _ended, ...rest } = pendingTurns.value
    pendingTurns.value = rest
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
    openDeletedFiles.value = []
    return result.session.id
  }

  /** Opens a Session; resolves with the preset and variant of its last turn. */
  async function open(id: string): Promise<SessionLastPreset | null> {
    const result = await call('sessions/open-failed', () => window.electronAPI.sessions.open(id))
    if (!result) return null
    const { timeline, ...summary } = result.session
    remember(summary)
    openSessionId.value = id
    openTimeline.value = timeline
    openDeletedFiles.value = result.missingFiles
    return result.lastPreset
  }

  async function rename(id: string, title: string): Promise<void> {
    const result = await call('sessions/rename-failed', () =>
      window.electronAPI.sessions.rename(id, title),
    )
    if (result) remember(result.session)
  }

  /** Saves settled display messages into a Session's timeline; one with a known id is replaced. */
  async function saveTimelineMessages(id: string, messages: { id: string }[]): Promise<void> {
    if (id === openSessionId.value) {
      const timeline = [...openTimeline.value]
      const at = new Map(timeline.map((message, index) => [(message as { id?: string }).id, index]))
      for (const message of messages) {
        const index = at.get(message.id)
        if (index === undefined) timeline.push(message)
        else timeline[index] = message
      }
      openTimeline.value = timeline
    }
    await call('sessions/save-timeline-failed', () =>
      window.electronAPI.sessions.saveTimelineMessages(id, messages),
    )
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
    openDeletedFiles.value = []
    await openNewestOrCreate()
  }

  return {
    sessions,
    openSessionId,
    openTimeline,
    openDeletedFiles,
    pendingTurns,
    turns,
    unseen,
    openTurn,
    orderedSessions,
    openSession,
    init,
    create,
    open,
    rename,
    remove,
    saveTimelineMessages,
    ensureOpenSession,
    isFileDeleted,
    markFileDeleted,
    beginMediaTurn,
    endMediaTurn,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSessions, import.meta.hot))
}
