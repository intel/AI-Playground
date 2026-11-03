import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { UIMessage } from 'ai'
import type { AgentTask } from '@/types/agentTaskIpc'
import { useConversations, type ThreadKind } from './conversations'
import { useAgentMode } from './agentMode'
import { useAgentTasks } from './agentTasks'
import { useUIStore } from './ui'
import { useImageGenerationPresets, hasDisplayableMedia } from './imageGenerationPresets'
import { usePresets } from './presets'
import { usePromptStore } from './promptArea'
import { usePresetSwitching } from './presetSwitching'
import { AGENT_PRESET, sessionDisplayTitle } from './agentModeSessions'
import { presetToMode } from '@/lib/presetModes'
import { downloadPercent } from '@/lib/downloadPercent'
import { modelDownloads } from '../models/modelDownloadQueue'
import {
  collectToolMediaUrls,
  conversationMode,
  conversationTimes,
  conversationTitle,
  entryRuntimeShown,
  isEmptyDraft,
  agentSessionStatus,
  isWorkflowMode,
  matchesFilter,
  matchesTask,
  mediaSettings,
  mediaTimes,
  mediaTitle,
  mediaUrl,
  searchEntries,
  sortEntries,
  type AgentEntry,
  type ConversationEntry,
  type RecordRow,
  type HistoryFilter,
  type MediaEntry,
  type SessionDownload,
} from './historyEntries'

export type TaskRef = Pick<AgentTask, 'id' | 'name'>
export type TaskPickerEntry = TaskRef & { sessionCount: number }

/**
 * Every reopenable unit of work as one list. This projects the three stores that
 * own the data today (chat threads, agent sessions, canvas media) rather than
 * replacing them — the persisted maps are collapsed in a follow-up — so the
 * history window can filter instead of mounting a different component per mode.
 */
export const useHistorySessions = defineStore('historySessions', () => {
  const conversations = useConversations()
  const agentMode = useAgentMode()
  const imageGeneration = useImageGenerationPresets()
  const presetsStore = usePresets()
  const promptStore = usePromptStore()
  const presetSwitching = usePresetSwitching()
  const agentTasks = useAgentTasks()
  const ui = useUIStore()

  const filter = ref<HistoryFilter>('current')
  const query = ref('')
  const taskFilterId = ref<string | null>(null)

  /**
   * A game's display name lives in its `game.json`, not on the session record,
   * so renaming one relabels its rows too.
   */
  const gameNames = ref<Record<string, string>>({})

  async function refreshGameNames(): Promise<void> {
    try {
      const games = await window.electronAPI.games.list()
      gameNames.value = Object.fromEntries(games.map((game) => [game.dir, game.name]))
    } catch {
      // Cosmetic: without the library the rows keep their first-prompt titles.
    }
  }

  function modeOfPreset(presetName: string | undefined): ModeType | null {
    if (!presetName) return null
    const preset = presetsStore.presets.find((entry) => entry.name === presetName)
    return preset ? presetToMode(preset) : null
  }

  /**
   * The preset an unsent thread will be stamped with on its first send, so its
   * row shows what the next send actually uses. Agent and canvas presets never
   * own a transcript, so a draft keeps no glyph while one of those is active.
   */
  const draftPresetName = computed<string | undefined>(() => {
    const name = presetsStore.activePresetName ?? undefined
    const mode = modeOfPreset(name)
    return mode === 'chat' || mode === 'audio' ? name : undefined
  })

  const conversationEntries = computed<ConversationEntry[]>(() =>
    Object.entries(conversations.conversationList).map(([key, stored]) => {
      const messages = stored as UIMessage[]
      const meta = conversations.conversationThreadMeta[key]
      const threadKind = conversations.getThreadKind(key)
      const draft = messages.length === 0 && threadKind === 'main'
      const presetName = meta?.presetName || (draft ? draftPresetName.value : undefined)
      return {
        kind: 'conversation',
        id: key,
        title: conversationTitle(messages),
        presetName,
        mode: conversationMode(modeOfPreset(presetName)),
        threadKind,
        variant: meta?.variant ?? null,
        ragDocHashes: conversations.conversationRagSelection[key],
        messages,
        ...conversationTimes(key, messages),
      }
    }),
  )

  function sessionDownload(sessionId: string): SessionDownload | null {
    const wait = modelDownloads().snapshot(sessionId)
    if (!wait) return null
    return { percent: Math.floor(downloadPercent(wait.progress)), queued: wait.status === 'queued' }
  }

  const agentEntries = computed<AgentEntry[]>(() =>
    Object.values(agentMode.sessions).map((session) => ({
      kind: 'agent',
      id: session.id,
      title: sessionDisplayTitle({
        title: session.title,
        gameName: gameNames.value[session.workspaceDir],
      }).name,
      presetName: session.presetName,
      mode: 'agent',
      workspaceDir: session.workspaceDir,
      capabilities: session.capabilities,
      messages: session.messages,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.taskId ? { taskId: session.taskId } : {}),
      ...(agentMode.heldAnswers[session.id]
        ? { heldAnswer: agentMode.heldAnswers[session.id] }
        : {}),
      ...agentSessionStatus({
        turn: agentMode.sessionTurns[session.id],
        unseen: agentMode.unseenTurns[session.id],
        download: sessionDownload(session.id),
      }),
    })),
  )

  const mediaEntries = computed<MediaEntry[]>(() => {
    const shownOnTranscripts = collectToolMediaUrls([
      ...conversationEntries.value.map((entry) => entry.messages),
      ...agentEntries.value.map((entry) => entry.messages),
    ])
    const now = Date.now()
    return (
      imageGeneration.generatedImages
        // A queued slot has no output yet, and a cancelled batch leaves terminal
        // items that never produced any — neither is history.
        .filter((item) => item.state !== 'queued')
        .filter((item) => item.state === 'generating' || hasDisplayableMedia(item))
        .map((item) => ({
          kind: 'media',
          id: item.id,
          title: mediaTitle(item),
          presetName: mediaSettings(item).preset,
          mode: item.mode,
          origin: shownOnTranscripts.has(mediaUrl(item)) ? 'tool' : 'canvas',
          media: item,
          ...mediaTimes(item, now),
        }))
    )
  })

  const entries = computed<RecordRow[]>(() =>
    sortEntries([...conversationEntries.value, ...agentEntries.value, ...mediaEntries.value]),
  )

  /**
   * The mode the list filters by. Background mode borrowing is gone (media
   * runs no longer switch modes, step 7), so the live mode is the user's
   * context — an open panel can't be swapped under their hands.
   */
  const currentMode = computed<ModeType>(() => promptStore.currentMode)

  /**
   * Home Agent is a mode in all but name: sitting on a remote thread makes the
   * current-mode list the remote one, and there is no chip to pick it — the
   * thread the app is on decides, the way the mode buttons decide the rest.
   */
  const conversationScope = computed<ThreadKind>(() => {
    if (currentMode.value !== 'chat' && currentMode.value !== 'audio') return 'main'
    return conversations.getThreadKind(conversations.activeKey)
  })

  /** Agents belong to the Agent preset in Agent mode, where its settings panel lists them. */
  const tasksAvailable = computed(() => currentMode.value === 'agent' && agentMode.sessionScoped)

  /** Names come from the Tasks store, never a session's title, so a rename shows at once. */
  function liveTask(taskId: string | null | undefined): TaskRef | null {
    const task = agentTasks.tasks.find((entry) => entry.id === taskId)
    return task ? { id: task.id, name: task.name } : null
  }

  /** The Task the list is narrowed to. */
  const taskFilter = computed<TaskRef | null>(() => liveTask(taskFilterId.value))

  /** The history panel's Task picker: every Task by name, with its Task Session count. */
  const taskPickerEntries = computed<TaskPickerEntry[]>(() => {
    if (!tasksAvailable.value) return []
    const counts = new Map<string, number>()
    for (const session of Object.values(agentMode.sessions)) {
      if (session.taskId) counts.set(session.taskId, (counts.get(session.taskId) ?? 0) + 1)
    }
    return agentTasks.tasks
      .map((task) => ({ id: task.id, name: task.name, sessionCount: counts.get(task.id) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  })

  /** A Task Session row's "From task" marker; hidden while a Task filter would repeat it. */
  function taskMarker(entry: RecordRow): TaskRef | null {
    if (entry.kind !== 'agent' || !tasksAvailable.value || taskFilter.value) return null
    return liveTask(entry.taskId)
  }

  function discardHeldAnswer(entry: RecordRow): void {
    if (entry.kind === 'agent') agentMode.discardHeldAnswer(entry.id)
  }

  function setTaskFilter(taskId: string): void {
    if (liveTask(taskId)) taskFilterId.value = taskId
  }

  function clearTaskFilter(): void {
    if (taskFilterId.value === null) return
    taskFilterId.value = null
    filter.value = 'current'
  }

  /** An Agent's "Show sessions": History opens narrowed to that Agent. */
  function showTaskSessions(taskId: string): void {
    query.value = ''
    setTaskFilter(taskId)
    ui.openHistory()
  }

  watch(
    [() => ui.showHistory, tasksAvailable, () => taskFilter.value === null],
    ([panelOpen, available, noTask]) => {
      if (!panelOpen || !available || noTask) clearTaskFilter()
    },
  )

  const matchingEntries = computed<RecordRow[]>(() => {
    const task = taskFilter.value
    const filtered = entries.value.filter((entry) =>
      task
        ? matchesTask(entry, task.id)
        : matchesFilter(entry, {
            filter: filter.value,
            currentMode: currentMode.value,
            agentPresetName: agentMode.agentPresetName,
            activeConversationId: conversations.activeKey,
            threadScope: conversationScope.value,
          }),
    )
    return searchEntries(filtered, query.value)
  })

  /**
   * The thread the next send goes into, before there is anything to date. It
   * sits above the dated list instead of in the middle of Today, where its
   * mint time would put it.
   */
  const pinnedDraft = computed<RecordRow | null>(
    () => matchingEntries.value.find(isEmptyDraft) ?? null,
  )

  const visibleEntries = computed<RecordRow[]>(() =>
    matchingEntries.value.filter((entry) => !isEmptyDraft(entry)),
  )

  function selectedMediaId(mode: WorkflowModeType): string | null {
    if (mode === 'imageEdit') return imageGeneration.selectedEditedImageId
    if (mode === 'video') return imageGeneration.selectedVideoId
    return imageGeneration.selectedGeneratedImageId
  }

  function setSelectedMediaId(mode: WorkflowModeType, id: string | null): void {
    if (mode === 'imageEdit') imageGeneration.selectedEditedImageId = id
    else if (mode === 'video') imageGeneration.selectedVideoId = id
    else imageGeneration.selectedGeneratedImageId = id
  }

  function isActive(entry: RecordRow): boolean {
    if (!entryRuntimeShown(entry, currentMode.value)) return false
    switch (entry.kind) {
      case 'conversation':
        return conversations.activeKey === entry.id
      case 'agent':
        return agentMode.openSessionId === entry.id
      case 'media':
        return selectedMediaId(entry.media.mode) === entry.id
    }
  }

  /** True while the canvas shows "new", i.e. nothing is selected yet. */
  const newMediaSelected = computed(() => {
    const mode = currentMode.value
    if (!isWorkflowMode(mode)) return false
    const selected = selectedMediaId(mode)
    return selected === null || selected === 'new'
  })

  /**
   * Wake the runtime the row implies. Setting a conversation key is not enough
   * when the panel is open on another mode: the chat watcher restores the
   * thread's preset, but not the view, so a row picked from All has to switch
   * the preset (and therefore the mode) itself. An agent session has the same
   * gap — `switchSession` only moves the preset when it differs from the
   * remembered agent one, which stays Game Agent while Image Gen is showing.
   */
  async function select(entry: RecordRow): Promise<void> {
    if (entry.kind === 'conversation') {
      await wakeConversation(entry)
      conversations.activeKey = entry.id
      return
    }
    if (entry.kind === 'agent') {
      await wakeAgent(entry)
      await agentMode.switchSession(entry.id)
      return
    }
    const mode = entry.media.mode
    setSelectedMediaId(mode, entry.id)
    if (promptStore.currentMode === mode) {
      // Same id does not retrigger the store watcher, but the slot may have been cleared.
      imageGeneration.syncSelectedReferenceImage()
      return
    }
    const settings = mediaSettings(entry.media)
    if (settings.preset && presetsStore.presets.some((p) => p.name === settings.preset)) {
      await presetSwitching.switchPreset(settings.preset, {
        variant: settings.variant,
        skipMemoryAlert: true,
      })
      return
    }
    promptStore.setCurrentMode(mode)
  }

  async function wakeConversation(entry: ConversationEntry): Promise<void> {
    const presetName = entry.presetName
    if (presetName && presetsStore.presets.some((preset) => preset.name === presetName)) {
      if (presetsStore.activePresetName !== presetName || promptStore.currentMode !== entry.mode) {
        await presetSwitching.switchPreset(presetName, {
          variant: entry.variant ?? undefined,
          skipMemoryAlert: true,
        })
      }
      return
    }
    if (promptStore.currentMode !== entry.mode) promptStore.setCurrentMode(entry.mode)
  }

  async function wakeAgent(entry: AgentEntry): Promise<void> {
    if (promptStore.currentMode === 'agent') return
    const preset = entry.presetName || agentMode.agentPresetName || AGENT_PRESET
    if (presetsStore.presets.some((candidate) => candidate.name === preset)) {
      await presetSwitching.switchPreset(preset, { skipMemoryAlert: true })
    }
  }

  function selectNewMedia(): void {
    const mode = currentMode.value
    if (isWorkflowMode(mode)) setSelectedMediaId(mode, 'new')
  }

  async function remove(entry: RecordRow): Promise<void> {
    switch (entry.kind) {
      case 'conversation':
        conversations.deleteConversation(entry.id)
        return
      case 'agent':
        await agentMode.deleteSession(entry.id)
        return
      case 'media':
        imageGeneration.deleteImage(entry.id)
    }
  }

  /** Only a transcript carries a user-set title; the others are named by what they produced. */
  function canRename(entry: RecordRow): boolean {
    return entry.kind === 'conversation' && entry.messages.length > 0
  }

  function rename(entry: RecordRow, title: string): void {
    if (entry.kind !== 'conversation') return
    conversations.renameConversationTitle(entry.id, title)
  }

  /** `+` follows the mode: a thread, a session or game, or a blank canvas. */
  async function startNew(): Promise<void> {
    const mode = currentMode.value
    if (mode === 'agent') {
      clearTaskFilter()
      await agentMode.startNew()
      return
    }
    if (isWorkflowMode(mode)) {
      selectNewMedia()
      return
    }
    const key = conversations.addNewConversation()
    if (key) conversations.activeKey = key
  }

  /** Clear-all is a media-only action: transcripts and sessions are deleted per row. */
  function clearCurrentModeMedia(): void {
    const mode = currentMode.value
    if (isWorkflowMode(mode)) imageGeneration.deleteAllImagesForMode(mode)
  }

  return {
    filter,
    query,
    taskFilter,
    tasksAvailable,
    taskPickerEntries,
    taskMarker,
    discardHeldAnswer,
    setTaskFilter,
    clearTaskFilter,
    showTaskSessions,
    entries,
    visibleEntries,
    pinnedDraft,
    currentMode,
    conversationScope,
    newMediaSelected,
    refreshGameNames,
    isActive,
    select,
    selectNewMedia,
    remove,
    canRename,
    rename,
    startNew,
    clearCurrentModeMedia,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useHistorySessions, import.meta.hot))
}
