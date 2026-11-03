<template>
  <MediaTurnBlock
    v-if="item.kind === 'media'"
    :prompt="item.prompt"
    :preset="item.media.preset"
    :mode="item.media.mode"
    :items="item.media.items"
    :status="item.media.status"
    :error="item.media.error"
    :deleted-urls="sessions.openDeletedFiles"
    @delete-file="(url) => gallery.removeByUrl(url)"
  />
  <MediaTurnBlock
    v-else-if="item.kind === 'pending-media'"
    :prompt="item.pending.prompt"
    :preset="item.pending.preset"
    :mode="item.pending.mode"
    :items="artifactRuns.state.runs[item.pending.runId]?.items ?? []"
    :phase="artifactRuns.state.runs[item.pending.runId]?.phase ?? 'queued'"
    :progress="artifactRuns.state.runs[item.pending.runId]?.progress"
  />
  <TaskRunBlock
    v-else-if="item.kind === 'agent' && item.taskRun"
    :task-run="item.taskRun"
    :messages="item.messages"
    :live="item.live?.live"
  />
  <div v-else-if="item.kind === 'agent'" class="flex flex-col gap-6">
    <SessionMessage
      v-for="message in item.messages"
      :key="message.id"
      :message="message"
      engine="agent"
      :live="!!item.live?.live && message.id === item.messages.at(-1)?.id"
      :queued="message.id === item.live?.queuedMessageId"
      :not-run="message.id === item.live?.notRunMessageId"
      :can-resend="!!item.live?.canResend && message.id === item.messages.at(-1)?.id"
      @resend="emit('resend')"
    />
  </div>
  <div v-else-if="item.kind === 'chat'" class="flex flex-col gap-6">
    <SessionMessage
      v-for="message in item.messages"
      :key="message.id"
      :message="message"
      engine="chat"
      :last="message.id === lastChatMessageId"
      :conversation-key="chatKey"
    />
  </div>
  <AudioTurnBlock
    v-else-if="item.kind === 'audio'"
    :prompt="item.prompt"
    :preset="item.audio.preset"
    :kind="item.audio.kind"
    :audio-url="item.audio.audioUrl"
    :transcript="item.audio.transcript"
    :engine="item.audio.engine"
    :status="item.audio.status"
    :error="item.audio.error"
    :file-deleted="!!item.audio.audioUrl && sessions.isFileDeleted(item.audio.audioUrl)"
  />
  <AudioTurnBlock
    v-else-if="item.kind === 'pending-audio'"
    :prompt="item.pending.prompt"
    :preset="item.pending.preset"
    :kind="item.pending.kind"
    :phase="item.pending.phase"
  />
  <div
    v-else-if="item.kind === 'message'"
    class="text-sm text-muted-foreground whitespace-pre-wrap"
    :class="item.message.role === 'user' ? 'self-end' : 'self-start'"
  >
    {{ plainText(item.message) }}
  </div>
</template>

<script setup lang="ts">
import { useArtifactRuns } from '@/assets/js/store/artifactRuns'
import { useGallery } from '@/assets/js/store/gallery'
import type { PendingAudioTurn } from '@/assets/js/store/sessionAudio'
import { useSessions, type PendingMediaTurn } from '@/assets/js/store/sessions'
import AudioTurnBlock from '@/components/AudioTurnBlock.vue'
import MediaTurnBlock from '@/components/MediaTurnBlock.vue'
import SessionMessage from '@/components/SessionMessage.vue'
import TaskRunBlock from '@/components/TaskRunBlock.vue'
import type { SessionTimelineItem } from '@/lib/sessionTimeline'
import type { TimelineMessage } from '@/types/sessionTimeline'

/** One turn of the Session timeline, settled or still running, whichever preset ran it. */
defineProps<{
  item: SessionTimelineItem<PendingMediaTurn, PendingAudioTurn>
  /** The newest message of the Session's live chat transcript. */
  lastChatMessageId?: string
  chatKey: string
}>()

const emit = defineEmits<{ resend: [] }>()

const sessions = useSessions()
const gallery = useGallery()
const artifactRuns = useArtifactRuns()

function plainText(message: TimelineMessage): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}
</script>
