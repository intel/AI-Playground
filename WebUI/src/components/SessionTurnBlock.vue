<template>
  <MediaTurnBlock
    v-if="turn.kind === 'media'"
    :prompt="turn.prompt"
    :preset="turn.media.preset"
    :mode="turn.media.mode"
    :items="turn.media.items"
    :status="turn.media.status"
    :error="turn.media.error"
    :deleted-urls="sessions.openDeletedFiles"
    @delete-file="(url) => gallery.removeByUrl(url)"
  />
  <TaskRunBlock
    v-else-if="turn.kind === 'agent' && turn.taskRun"
    :task-run="turn.taskRun"
    :messages="turn.messages"
  />
  <div v-else-if="turn.kind === 'agent'" class="flex flex-col gap-4">
    <AgentTurnBlock :messages="turn.messages" />
  </div>
  <ChatTurnBlock v-else-if="turn.kind === 'chat'" :messages="turn.messages" />
  <AudioTurnBlock
    v-else-if="turn.kind === 'audio'"
    :prompt="turn.prompt"
    :preset="turn.audio.preset"
    :kind="turn.audio.kind"
    :audio-url="turn.audio.audioUrl"
    :transcript="turn.audio.transcript"
    :engine="turn.audio.engine"
    :status="turn.audio.status"
    :error="turn.audio.error"
    :file-deleted="!!turn.audio.audioUrl && sessions.isFileDeleted(turn.audio.audioUrl)"
  />
  <div
    v-else
    class="text-sm text-muted-foreground whitespace-pre-wrap"
    :class="turn.message.role === 'user' ? 'self-end' : 'self-start'"
  >
    {{ messageText(turn.message) }}
  </div>
</template>

<script setup lang="ts">
import { useGallery } from '@/assets/js/store/gallery'
import { useSessions } from '@/assets/js/store/sessions'
import AgentTurnBlock from '@/components/AgentTurnBlock.vue'
import AudioTurnBlock from '@/components/AudioTurnBlock.vue'
import ChatTurnBlock from '@/components/ChatTurnBlock.vue'
import MediaTurnBlock from '@/components/MediaTurnBlock.vue'
import TaskRunBlock from '@/components/TaskRunBlock.vue'
import type { TimelineTurn } from '@/lib/sessionTimeline'
import type { TimelineMessage } from '@/types/sessionTimeline'

/** One settled turn of the Session timeline, whichever preset ran it. */
defineProps<{ turn: TimelineTurn }>()

const sessions = useSessions()
const gallery = useGallery()

function messageText(message: TimelineMessage): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}
</script>
