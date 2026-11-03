<template>
  <div class="flex flex-col gap-4">
    <!-- eslint-disable vue/require-v-for-key -->
    <template v-for="message in messages">
      <!-- eslint-enable -->
      <div v-if="message.role === 'user'" class="flex items-start gap-3">
        <UserCircleIcon class="size-6 text-foreground/90" />
        <div class="flex flex-col gap-2 max-w-4/5 bg-muted rounded-md px-4 py-3">
          <MarkdownRenderer :content="textOf(message)" />
        </div>
      </div>
      <article
        v-else-if="message.role === 'assistant'"
        aria-label="Assistant response"
        class="flex items-start gap-3"
      >
        <img src="../assets/svg/ai-icon.svg" class="size-6" alt="" />
        <div class="flex flex-col gap-3 w-full max-w-4/5">
          <template v-for="(part, index) in message.parts" :key="index">
            <ChatReasoningDisplay
              v-if="part.type === 'reasoning'"
              :text="(part as ReasoningPart).text"
              :streaming="false"
            />
            <MarkdownRenderer
              v-else-if="part.type === 'text'"
              :content="withoutInlineMedia((part as TextPart).text)"
            />
            <div v-else-if="isChatMediaToolPart(part)" class="flex flex-col gap-2">
              <ChatToolDisplay
                :part="asToolPart(part)"
                :state="asToolPart(part).state"
                :input="asToolPart(part).input"
              />
              <ChatWorkflowResult
                :images="mediaOf(part)"
                hide-mode-switch
                :deleted-urls="sessions.openDeletedFiles"
              />
            </div>
            <ChatToolDisplay
              v-else-if="isToolUIPart(part)"
              :part="asToolPart(part)"
              :state="asToolPart(part).state"
              :input="asToolPart(part).input"
            />
          </template>
        </div>
      </article>
    </template>
  </div>
</template>

<script setup lang="ts">
import { isToolUIPart, type DynamicToolUIPart, type ToolUIPart, type UIMessage } from 'ai'
import { useSessions } from '@/assets/js/store/sessions'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import ChatReasoningDisplay from '@/components/ChatReasoningDisplay.vue'
import ChatToolDisplay from '@/components/ChatToolDisplay.vue'
import ChatWorkflowResult from '@/components/ChatWorkflowResult.vue'
import { isChatMediaToolPart } from '@/lib/chatToolParts'
import type { AipgTools } from '@/assets/js/tools/tools'
import type { MediaItem } from '@/assets/js/store/imageGenerationPresets'
import { UserCircleIcon } from '@heroicons/vue/24/outline'

/** A settled run of the Session's chat transcript, as the Session timeline shows it. */
defineProps<{ messages: UIMessage[] }>()

type TextPart = { type: 'text'; text: string }
type ReasoningPart = { type: 'reasoning'; text: string }

const sessions = useSessions()

const INLINE_MEDIA = /!\[[^\]]*]\(aipg-media:\/\/[^)]+\)/g

function withoutInlineMedia(text: string): string {
  return text.replace(INLINE_MEDIA, '').trim()
}

function textOf(message: UIMessage): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n')
}

function asToolPart(part: unknown): ToolUIPart<AipgTools> | DynamicToolUIPart {
  return part as ToolUIPart<AipgTools> | DynamicToolUIPart
}

function mediaOf(part: unknown): MediaItem[] {
  const tool = asToolPart(part)
  if (tool.state !== 'output-available') return []
  const images = (tool.output as { images?: unknown[] } | null)?.images ?? []
  return images.map((image) => ({ ...(image as MediaItem), state: 'done' as const }))
}
</script>
