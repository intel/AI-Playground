<template>
  <aside
    id="sessions-panel"
    role="region"
    :aria-label="languages.COM_SESSIONS"
    class="flex-none flex flex-col min-h-0 border-r border-border bg-background/60 transition-[width] duration-200"
    :class="collapsed ? 'w-14' : 'w-72'"
  >
    <TooltipProvider :delay-duration="200">
      <div
        class="flex items-center gap-1 px-2 py-2"
        :class="collapsed ? 'flex-col' : 'justify-between'"
      >
        <h2 v-if="!collapsed" class="px-1 text-base font-semibold text-foreground">
          {{ languages.COM_SESSIONS }}
        </h2>
        <div class="flex items-center gap-1" :class="{ 'flex-col': collapsed }">
          <Tooltip v-if="collapsed">
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="icon"
                class="h-8 w-8"
                :aria-label="languages.SESSIONS_NEW"
                @click="lifecycle.newSession()"
              >
                <PlusIcon class="size-5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{{ languages.SESSIONS_NEW }}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="icon"
                class="h-8 w-8"
                :aria-label="collapsed ? languages.SESSIONS_EXPAND : languages.SESSIONS_COLLAPSE"
                :aria-expanded="!collapsed"
                @click="ui.sessionsPanelCollapsed = !collapsed"
              >
                <ChevronDoubleRightIcon v-if="collapsed" class="size-5" aria-hidden="true" />
                <ChevronDoubleLeftIcon v-else class="size-5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{{
              collapsed ? languages.SESSIONS_EXPAND : languages.SESSIONS_COLLAPSE
            }}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <template v-if="!collapsed">
        <div class="flex-none flex flex-col gap-2 px-2 pb-2">
          <div class="relative">
            <MagnifyingGlassIcon
              class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              v-model="query"
              type="search"
              class="pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden"
              :aria-label="languages.SESSIONS_SEARCH"
              :placeholder="languages.SESSIONS_SEARCH"
              @keydown.esc.stop="query = ''"
            />
            <Tooltip v-if="query">
              <TooltipTrigger as-child>
                <Button
                  variant="ghost"
                  size="icon"
                  class="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
                  :aria-label="languages.SESSIONS_SEARCH_CLEAR"
                  @click="query = ''"
                >
                  <XMarkIcon class="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{{ languages.SESSIONS_SEARCH_CLEAR }}</TooltipContent>
            </Tooltip>
          </div>
          <Button
            variant="outline"
            class="w-full justify-start gap-2"
            @click="lifecycle.newSession()"
          >
            <PlusIcon class="size-4" aria-hidden="true" />
            {{ languages.SESSIONS_NEW }}
          </Button>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-2 flex flex-col gap-3">
          <p
            v-if="query.trim() && sections.length === 0"
            class="px-1 text-sm text-muted-foreground"
          >
            {{ languages.SESSIONS_NO_MATCH }}
          </p>
          <section
            v-for="section in sections"
            :key="section.id"
            role="group"
            :aria-label="sectionLabel(section.id)"
            class="flex flex-col gap-1.5"
          >
            <h3
              v-if="sections.length > 1 || section.id !== 'recent'"
              class="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              {{ sectionLabel(section.id) }}
            </h3>
            <template v-if="section.id === 'groups'">
              <section
                v-for="listing in section.groups"
                :key="listing.group.id"
                role="group"
                :aria-label="listing.group.name"
                class="flex flex-col gap-1.5"
              >
                <h4 class="px-1 truncate text-sm font-medium text-foreground">
                  {{ listing.group.name }}
                </h4>
                <SessionRow
                  v-for="session in listing.sessions"
                  :key="session.id"
                  :session="session"
                  :groups="sessions.groups"
                  :active="session.id === sessions.openSessionId"
                  :status="lifecycle.rowStatus(session.id)"
                  :scheduled="agentTasks.scheduledSessionIds.has(session.id)"
                  @open="lifecycle.openSession(session.id)"
                  @rename="(title) => sessions.rename(session.id, title)"
                  @pin="(pinned) => sessions.setPinned(session.id, pinned)"
                  @move-to-group="(groupId) => sessions.moveToGroup(session.id, groupId)"
                  @create-group="(name) => sessions.createGroup(session.id, name)"
                  @delete="sessions.remove(session.id)"
                />
              </section>
            </template>
            <template v-else>
              <SessionRow
                v-for="session in section.sessions"
                :key="session.id"
                :session="session"
                :groups="sessions.groups"
                :active="session.id === sessions.openSessionId"
                :status="lifecycle.rowStatus(session.id)"
                :scheduled="agentTasks.scheduledSessionIds.has(session.id)"
                @open="lifecycle.openSession(session.id)"
                @rename="(title) => sessions.rename(session.id, title)"
                @pin="(pinned) => sessions.setPinned(session.id, pinned)"
                @move-to-group="(groupId) => sessions.moveToGroup(session.id, groupId)"
                @create-group="(name) => sessions.createGroup(session.id, name)"
                @delete="sessions.remove(session.id)"
              />
              <Button
                v-if="section.id === 'pinned' && section.toggle"
                variant="ghost"
                size="sm"
                class="w-full justify-start text-muted-foreground"
                @click="sessions.setPinnedShowMore(section.toggle.action === 'more')"
              >
                {{ pinnedToggleLabel(section.toggle) }}
              </Button>
            </template>
          </section>
        </div>
      </template>
      <div v-else class="flex-1"></div>

      <div class="flex-none flex items-center gap-3 px-3 py-3" :class="{ 'flex-col': collapsed }">
        <slot name="footer" />
      </div>
    </TooltipProvider>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  XMarkIcon,
} from '@heroicons/vue/24/outline'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import { useSessions } from '@/assets/js/store/sessions'
import { useSessionLifecycle } from '@/assets/js/store/sessionLifecycle'
import { useUIStore } from '@/assets/js/store/ui'
import SessionRow from '@/components/SessionRow.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { sessionSections, type PinnedToggle, type SessionSectionId } from '@/lib/sessionSections'

const sessions = useSessions()
const agentTasks = useAgentTasks()
const lifecycle = useSessionLifecycle()
const ui = useUIStore()
const i18nState = useI18N().state

const collapsed = computed(() => ui.sessionsPanelCollapsed)
const query = ref('')

const sections = computed(() =>
  sessionSections({
    sessions: sessions.orderedSessions,
    groups: sessions.groups,
    query: query.value,
    untitled: i18nState.SESSIONS_UNTITLED,
    openSessionId: sessions.openSessionId,
    pinnedShowMore: sessions.pinnedShowMore,
  }),
)

const SECTION_LABELS: Record<SessionSectionId, string> = {
  pinned: 'SESSIONS_SECTION_PINNED',
  groups: 'SESSIONS_SECTION_GROUPS',
  recent: 'SESSIONS_SECTION_RECENT',
}

function sectionLabel(id: SessionSectionId) {
  return i18nState[SECTION_LABELS[id]]
}

function pinnedToggleLabel(toggle: NonNullable<PinnedToggle>) {
  return toggle.action === 'more'
    ? i18nState.SESSIONS_PINNED_SHOW_MORE.replace('{count}', String(toggle.count))
    : i18nState.SESSIONS_PINNED_SHOW_LESS
}
</script>
