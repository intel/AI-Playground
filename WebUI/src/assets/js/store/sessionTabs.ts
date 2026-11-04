import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useConversations } from '@/assets/js/store/conversations'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { useSessions } from '@/assets/js/store/sessions'
import {
  sessionTabs,
  sessionTabsPresetKind,
  type ArtifactsScope,
  type SessionTabId,
  type SessionTabLanding,
  type SessionTabsInput,
  type SessionTabsOwner,
} from '@/lib/sessionTabs'

/** Which tab of the open Session's view is shown; UI state only, never persisted. */
export const useSessionTabs = defineStore('sessionTabs', () => {
  const sessions = useSessions()
  const conversations = useConversations()
  const promptStore = usePromptStore()
  const agentMode = useAgentMode()
  const agentTasks = useAgentTasks()

  const current = ref<SessionTabId>('viewport')
  const artifactsScope = ref<ArtifactsScope>('this-session')

  const owner = computed<SessionTabsOwner>(() =>
    promptStore.getCurrentMode() === 'chat' &&
    conversations.getThreadKind(conversations.activeKey) === 'homeAgent'
      ? 'home-agent-thread'
      : 'session',
  )

  const context = computed<Omit<SessionTabsInput, 'landing' | 'current'>>(() => ({
    owner: owner.value,
    presetKind: sessionTabsPresetKind(promptStore.getCurrentMode(), agentMode.activeAgentPreset),
    hasAgents: agentTasks.sessionTasks.length > 0,
  }))

  const view = computed(() =>
    sessionTabs({ ...context.value, landing: 'keep', current: current.value }),
  )

  // Syncing back means a tab that disappeared stays dropped when it comes back.
  watch(
    () => view.value.shown,
    (shown) => (current.value = shown),
  )

  function land(landing: SessionTabLanding): void {
    const next = sessionTabs({ ...context.value, landing, current: current.value })
    current.value = next.shown
    if (next.artifactsScope) artifactsScope.value = next.artifactsScope
  }

  function select(tab: SessionTabId): void {
    if (view.value.tabs.includes(tab)) current.value = tab
  }

  // Sync, so a landing requested right after an open (from Artifacts) is not overridden.
  watch(
    () => sessions.openSessionId,
    () => land('open-session'),
    { flush: 'sync' },
  )

  /** The open Session has a turn in flight; a Home Agent thread is no Session's. */
  const sessionTurnInFlight = computed(
    () => owner.value === 'session' && sessions.openTurn !== null,
  )

  return {
    tabs: computed(() => view.value.tabs),
    shown: computed(() => view.value.shown),
    schedules: computed(() => view.value.schedules),
    artifactsScope,
    sessionTurnInFlight,
    land,
    select,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSessionTabs, import.meta.hot))
}
