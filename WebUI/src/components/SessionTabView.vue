<template>
  <div class="flex-1 flex flex-col min-h-0 min-w-0">
    <div
      role="tablist"
      :aria-label="i18nState.SESSION_TABS_LABEL"
      class="flex-none flex gap-1 px-4 border-b border-border"
      @keydown="onKeydown"
    >
      <button
        v-for="tab in sessionTabs.tabs"
        :id="tabId(tab)"
        :key="tab"
        :ref="(el) => setTabRef(tab, el)"
        role="tab"
        type="button"
        :aria-selected="sessionTabs.shown === tab"
        :aria-controls="panelId(tab)"
        :tabindex="sessionTabs.shown === tab ? 0 : -1"
        class="relative flex items-center gap-2 px-3 py-2 text-sm -mb-px border-b-2 transition-colors"
        :class="
          sessionTabs.shown === tab
            ? 'border-primary text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground'
        "
        @click="sessionTabs.select(tab)"
      >
        {{ i18nState[TAB_LABELS[tab]] }}
        <span
          v-if="tab === 'viewport' && sessionTabs.sessionTurnInFlight"
          class="size-2 rounded-full bg-primary animate-pulse"
          aria-hidden="true"
        ></span>
        <span v-if="tab === 'viewport' && sessionTabs.sessionTurnInFlight" class="sr-only">
          {{ i18nState.SESSION_TAB_BUSY }}
        </span>
      </button>
    </div>
    <div
      v-for="tab in sessionTabs.tabs"
      v-show="sessionTabs.shown === tab"
      :id="panelId(tab)"
      :key="tab"
      role="tabpanel"
      :aria-labelledby="tabId(tab)"
      class="flex-1 flex flex-col relative min-h-0"
      :class="tab === 'viewport' ? 'justify-center-safe overflow-y-auto' : 'overflow-y-auto'"
    >
      <slot :name="tab"></slot>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useSessionTabs } from '@/assets/js/store/sessionTabs'
import type { SessionTabId } from '@/lib/sessionTabs'

defineSlots<Partial<Record<SessionTabId, () => unknown>>>()

const sessionTabs = useSessionTabs()
const i18nState = useI18N().state

const TAB_LABELS: Record<SessionTabId, string> = {
  viewport: 'SESSION_TAB_VIEWPORT',
  inferencing: 'SESSION_TAB_INFERENCING',
  attributes: 'SESSION_TAB_ATTRIBUTES',
  artifacts: 'SESSION_TAB_ARTIFACTS',
  schedules: 'SESSION_TAB_SCHEDULES',
}

const tabRefs = new Map<SessionTabId, HTMLElement>()

function setTabRef(tab: SessionTabId, el: Element | ComponentPublicInstance | null) {
  if (el instanceof HTMLElement) tabRefs.set(tab, el)
  else tabRefs.delete(tab)
}

function tabId(tab: SessionTabId) {
  return `session-tab-${tab}`
}

function panelId(tab: SessionTabId) {
  return `session-tabpanel-${tab}`
}

function onKeydown(event: KeyboardEvent) {
  const tabs = sessionTabs.tabs
  const at = tabs.indexOf(sessionTabs.shown)
  const target =
    event.key === 'ArrowRight'
      ? tabs[(at + 1) % tabs.length]
      : event.key === 'ArrowLeft'
        ? tabs[(at - 1 + tabs.length) % tabs.length]
        : event.key === 'Home'
          ? tabs[0]
          : event.key === 'End'
            ? tabs[tabs.length - 1]
            : undefined
  if (!target) return
  event.preventDefault()
  sessionTabs.select(target)
  tabRefs.get(target)?.focus()
}
</script>
