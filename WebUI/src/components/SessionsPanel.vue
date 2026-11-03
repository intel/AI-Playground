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
          <Tooltip>
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
    </TooltipProvider>

    <TooltipProvider v-if="!collapsed" :delay-duration="200">
      <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-2 flex flex-col gap-1.5">
        <SessionRow
          v-for="session in sessions.orderedSessions"
          :key="session.id"
          :session="session"
          :active="session.id === sessions.openSessionId"
          :status="lifecycle.rowStatus(session.id)"
          :scheduled="agentTasks.scheduledSessionIds.has(session.id)"
          @open="lifecycle.openSession(session.id)"
          @rename="(title) => sessions.rename(session.id, title)"
          @delete="sessions.remove(session.id)"
        />
      </div>
    </TooltipProvider>
    <div v-else class="flex-1"></div>

    <div class="flex-none flex items-center gap-3 px-3 py-3" :class="{ 'flex-col': collapsed }">
      <slot name="footer" />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ChevronDoubleLeftIcon, ChevronDoubleRightIcon, PlusIcon } from '@heroicons/vue/24/outline'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useSessions } from '@/assets/js/store/sessions'
import { useSessionLifecycle } from '@/assets/js/store/sessionLifecycle'
import { useUIStore } from '@/assets/js/store/ui'
import SessionRow from '@/components/SessionRow.vue'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const sessions = useSessions()
const agentTasks = useAgentTasks()
const lifecycle = useSessionLifecycle()
const ui = useUIStore()

const collapsed = computed(() => ui.sessionsPanelCollapsed)
</script>
