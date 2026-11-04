<template>
  <SessionRow
    :session
    :groups="sessions.groups"
    :active="session.id === sessions.openSessionId"
    :status="lifecycle.rowStatus(session.id)"
    :scheduled="agentTasks.scheduledSessionIds.has(session.id)"
    :create-group="(name) => sessions.createGroup(session.id, name)"
    @open="lifecycle.openSession(session.id)"
    @rename="(title) => sessions.rename(session.id, title)"
    @pin="(pinned) => sessions.setPinned(session.id, pinned)"
    @move-to-group="(groupId) => sessions.moveToGroup(session.id, groupId)"
    @delete="sessions.remove(session.id)"
  />
</template>

<script setup lang="ts">
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useSessions } from '@/assets/js/store/sessions'
import { useSessionLifecycle } from '@/assets/js/store/sessionLifecycle'
import SessionRow from '@/components/SessionRow.vue'
import type { SessionSummary } from '@/types/sessionIpc'

defineProps<{ session: SessionSummary }>()

const sessions = useSessions()
const agentTasks = useAgentTasks()
const lifecycle = useSessionLifecycle()
</script>
