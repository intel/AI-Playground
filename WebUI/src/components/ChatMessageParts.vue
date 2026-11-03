<template>
  <div
    v-if="showRagSource && ragSource"
    class="my-2 text-muted-foreground border-l-2 border-primary pl-2 flex flex-row gap-1"
    :class="textInference.fontSizeClass"
  >
    <div class="font-bold">{{ languages.RAG_SOURCE }}:</div>
    <div class="whitespace-pre-wrap">{{ ragSource }}</div>
  </div>
  <div class="ai-answer chat-content flex flex-col gap-2" :class="textInference.fontSizeClass">
    <template
      v-for="(part, partIndex) in message.parts"
      :key="`${message.id}-${part.type}-${partIndex}`"
    >
      <!-- Reasoning part. A turn can carry several reasoning parts
         (one per agentic step, and some backends resend cumulative
         reasoning), which otherwise renders as several "Reasoned
         for…" blocks. Aggregate them into a single block rendered at
         the position of the first reasoning part (mirrors the
         web-browse aggregation below). -->
      <ChatReasoningDisplay
        v-if="part.type === 'reasoning' && isFirstReasoningPart(message, partIndex)"
        :text="mergedReasoningText(message)"
        :startedAt="reasoningStartedAtFor(message)"
        :finishedAt="reasoningFinishedAtFor(message)"
        :streaming="last && openAiCompatibleChat.reasoningInProgress"
        :liveStartedAt="openAiCompatibleChat.reasoningStartedAt"
        :onCopy="copyText"
      />

      <!-- Text part -->
      <template v-else-if="part.type === 'text'">
        <MarkdownRenderer
          role="region"
          aria-label="Assistant reply"
          :content="stripInlineMedia((part as any).text ?? '')"
          :on-copy="copyText"
        />
      </template>

      <!-- Tool parts -->
      <template v-else-if="isToolUIPart(part)">
        <template v-if="isAipgTool(part) && toolPartNameOf(part) === 'comfyUI'">
          <div>
            <span v-if="part.state === 'input-streaming' && !toolInputRecord(part).workflow"
              >Generating…</span
            >
            <span v-else
              >Generating using the preset
              <b>{{ toolInputRecord(part).workflow ?? 'unknown' }}</b></span
            >
            <br />
            <br />
            <span
              ><em>{{ toolInputRecord(part).prompt ?? '' }}</em></span
            >
            <ChatWorkflowResult v-bind="toolMediaCard(part)" />
          </div>
        </template>
        <template v-else-if="isAipgTool(part) && toolPartNameOf(part) === 'comfyUiImageEdit'">
          <div>
            <span v-if="part.state === 'input-streaming' && !toolInputRecord(part).workflow"
              >Editing…</span
            >
            <span v-else
              >Editing using the preset
              <b>{{ toolInputRecord(part).workflow ?? 'unknown' }}</b></span
            >
            <br />
            <br />
            <span
              ><em>{{ toolInputRecord(part).prompt ?? '' }}</em></span
            >
            <ChatWorkflowResult v-bind="toolMediaCard(part)" />
          </div>
        </template>
        <template v-else-if="isAipgTool(part) && toolPartNameOf(part) === 'media'">
          <div>
            <span v-if="part.state === 'input-streaming' && !toolInputRecord(part).request"
              >Creating media…</span
            >
            <span v-else>
              Creating media:
              <em>{{ toolInputRecord(part).request ?? '' }}</em>
            </span>
            <MediaAgentTimeline
              class="mt-2"
              :tool-call-id="(part as any).toolCallId"
              :fallback-steps="(part as any).output?.steps"
            />
            <div
              v-if="part.state === 'output-available' && (part as any).output?.success === false"
              class="mt-2 text-sm text-destructive"
            >
              {{ (part as any).output?.message ?? 'Media generation failed.' }}
            </div>
            <ChatWorkflowResult v-bind="toolMediaCard(part)" />
          </div>
        </template>
        <template
          v-else-if="isAipgTool(part) && toolPartNameOf(part) === 'visualizeObjectDetections'"
        >
          <div>
            <div
              v-if="part.state === 'output-available' && (part as any).output?.annotatedImageUrl"
            >
              <img
                :src="(part as any).output.annotatedImageUrl"
                alt="Annotated image with object detections"
                class="max-w-full rounded-md border-2 border-border"
              />
            </div>
            <div v-else-if="part.state === 'input-streaming' || part.state === 'input-available'">
              <span class="text-muted-foreground">Visualizing object detections...</span>
            </div>
          </div>
        </template>
        <template v-else-if="isAipgTool(part) && toolPartNameOf(part) === 'captureScreenshot'">
          <div>
            <div v-if="part.state === 'output-available' && (part as any).output?.dataUri">
              <span class="text-muted-foreground">
                Captured screenshot of
                <b>{{ (part as any).output?.windowName ?? 'window' }}</b>
              </span>
              <img
                :src="(part as any).output.dataUri"
                :alt="`Screenshot of ${(part as any).output?.windowName ?? 'window'}`"
                class="mt-2 max-w-full rounded-md border-2 border-border"
              />
            </div>
            <div v-else-if="part.state === 'input-streaming' || part.state === 'input-available'">
              <span class="text-muted-foreground">Capturing screenshot...</span>
            </div>
          </div>
        </template>
        <template v-else-if="isAipgTool(part) && toolPartNameOf(part) === 'screenshotWebPage'">
          <div>
            <div v-if="part.state === 'output-available' && (part as any).output?.dataUri">
              <span class="text-muted-foreground">Captured web page</span>
              <img
                :src="(part as any).output.dataUri"
                alt="Screenshot of the web page"
                class="mt-2 max-w-full rounded-md border-2 border-border"
              />
            </div>
            <div v-else-if="part.state === 'input-streaming' || part.state === 'input-available'">
              <span class="text-muted-foreground">Capturing web page...</span>
            </div>
          </div>
        </template>
        <template v-else-if="isAipgTool(part) && toolPartNameOf(part) === 'synthesizeTextToSpeech'">
          <div>
            <ChatTtsToolResult
              v-if="part.state === 'output-available'"
              :output="(part as any).output"
            />
            <div v-else-if="part.state === 'input-streaming' || part.state === 'input-available'">
              <span class="text-muted-foreground">Synthesizing speech…</span>
            </div>
          </div>
        </template>
        <template v-else-if="isWebBrowsePart(part)">
          <ChatWebBrowseDisplay
            v-if="isFirstWebBrowsePart(message, partIndex)"
            :entries="webBrowseEntriesFor(message)"
          />
        </template>
        <template v-else-if="isMcpTool(part)">
          <ChatMcpToolDisplay :part="part" :state="part.state" />
        </template>
        <template v-else>
          <ChatToolDisplay :part="part" :state="part.state" :input="part.input" />
        </template>
      </template>
    </template>

    <!-- Hidden while media is generating: its card shows that inline. -->
    <ChatActivityIndicator
      v-if="last && hasActivity && !messageHasLiveMedia(message)"
      :conversation-key="conversationKey"
    />
    <ChatConfirmation v-if="last && hasConfirmation" :conversation-key="conversationKey" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { type DynamicToolUIPart, isToolUIPart, type ToolUIPart } from 'ai'
import { useActivities } from '@/assets/js/store/activities'
import { useArtifactRuns } from '@/assets/js/store/artifactRuns'
import { useConfirmations } from '@/assets/js/store/confirmations'
import { useI18N } from '@/assets/js/store/i18n'
import { type MediaItem } from '@/assets/js/store/imageGenerationPresets'
import { useOpenAiCompatibleChat, type AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'
import { useTextInference } from '@/assets/js/store/textInference'
import ChatActivityIndicator from '@/components/ChatActivityIndicator.vue'
import ChatConfirmation from '@/components/ChatConfirmation.vue'
import ChatMcpToolDisplay from '@/components/ChatMcpToolDisplay.vue'
import ChatReasoningDisplay from '@/components/ChatReasoningDisplay.vue'
import ChatToolDisplay from '@/components/ChatToolDisplay.vue'
import ChatTtsToolResult from '@/components/ChatTtsToolResult.vue'
import ChatWebBrowseDisplay, { type WebBrowseEntry } from '@/components/ChatWebBrowseDisplay.vue'
import ChatWorkflowResult from '@/components/ChatWorkflowResult.vue'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import MediaAgentTimeline from '@/components/MediaAgentTimeline.vue'
import { aipgTools, type AipgTools } from '@/assets/js/tools/tools'
import { toolPartNameOf } from '@/lib/agentTranscript'
import {
  isAipgChatToolPart,
  isChatMediaToolPart,
  isChatMcpToolPart,
  isChatWebBrowseToolPart,
} from '@/lib/chatToolParts'
import { copyToClipboard, stripInlineMedia } from '@/lib/chatMessageText'
import type { ArtifactPhase } from '@/types/kernelEvents'

/** What a chat answer is made of: reasoning, text, tool cards and the media they made. */
const props = defineProps<{
  message: AipgUiMessage
  /** The newest message of the live conversation: it hosts the turn's live status. */
  last?: boolean
  conversationKey: string
  showRagSource?: boolean
}>()

const openAiCompatibleChat = useOpenAiCompatibleChat()
const textInference = useTextInference()
const artifactRuns = useArtifactRuns()
const activities = useActivities()
const confirmations = useConfirmations()
const languages = useI18N().state

const aipgToolNames = new Set(Object.keys(aipgTools))

const ragSource = computed(() => props.message.metadata?.ragSource)
const hasActivity = computed(
  () => activities.chatActivity(props.conversationKey, ['generation']) !== null,
)
const hasConfirmation = computed(
  () => confirmations.forConversation(props.conversationKey) !== null,
)

function copyText(text: string) {
  copyToClipboard(text, languages.COM_COPY_SUCCESS_TIP)
}

function toolInputRecord(part: { input?: unknown }): Record<string, unknown> {
  return part.input && typeof part.input === 'object' && !Array.isArray(part.input)
    ? (part.input as Record<string, unknown>)
    : {}
}

type ToolMediaCard = {
  images: MediaItem[]
  phase?: ArtifactPhase
  progress?: { current: number; max: number }
}

// Live runs the tool call owns (directly, or through the media specialist),
// falling back to the settled tool output once the runs have aged out or the
// page was reloaded.
function toolMediaCard(part: ToolUIPart<AipgTools> | DynamicToolUIPart): ToolMediaCard {
  if (!isChatMediaToolPart(part)) return { images: [] }
  const live = artifactRuns.viewFor(part.toolCallId)
  const settled = part.state === 'output-available' || part.state === 'output-error'
  const phase = settled ? undefined : live.phase
  if (live.items.length > 0) return { images: live.items, phase, progress: live.progress }
  const output = part.state === 'output-available' ? (part.output as { images?: unknown[] }) : null
  const images = (output?.images ?? []).map((img) => ({
    ...(img as MediaItem),
    state: 'done' as const,
  }))
  return { images, phase, progress: live.progress }
}

function messageHasLiveMedia(message: { parts?: unknown[] }): boolean {
  return (message.parts ?? []).some((part) => {
    const toolPart = part as ToolUIPart<AipgTools> | DynamicToolUIPart
    return isChatMediaToolPart(toolPart) && artifactRuns.viewFor(toolPart.toolCallId).processing
  })
}

function isAipgTool(part: ToolUIPart<AipgTools> | DynamicToolUIPart): boolean {
  return isAipgChatToolPart(part, aipgToolNames)
}

function isMcpTool(part: ToolUIPart<AipgTools> | DynamicToolUIPart): part is DynamicToolUIPart {
  return isChatMcpToolPart(part)
}

// Web-browsing tool parts (browseWeb + interactWithWebPage) are aggregated into a
// single "Browsed N pages" trace element per assistant message.
function isWebBrowsePart(part: ToolUIPart<AipgTools> | DynamicToolUIPart): boolean {
  return isChatWebBrowseToolPart(part)
}

function webBrowsePartsOf(message: AipgUiMessage) {
  return (message.parts ?? []).filter((part) =>
    isWebBrowsePart(part as ToolUIPart<AipgTools> | DynamicToolUIPart),
  ) as ToolUIPart<AipgTools>[]
}

// Reasoning is "in progress" only when the store — which watches the raw chunk
// stream — reports reasoning is the model's current output, on the last message
// of the turn.
type ReasoningPart = {
  type: 'reasoning'
  text?: string
  providerMetadata?: { aipg?: { reasoningStarted?: number; reasoningFinished?: number } }
}

function reasoningPartsOf(message: AipgUiMessage): ReasoningPart[] {
  return (message.parts ?? []).filter((part) => part.type === 'reasoning') as ReasoningPart[]
}

// A turn can carry several reasoning parts (one per agentic step); they render as
// one block, at the first one.
function isFirstReasoningPart(message: AipgUiMessage, partIndex: number): boolean {
  return (message.parts ?? []).findIndex((part) => part.type === 'reasoning') === partIndex
}

function mergedReasoningText(message: AipgUiMessage): string {
  return reasoningPartsOf(message)
    .map((part) => (part.text ?? '').trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
}

function reasoningStartedAtFor(message: AipgUiMessage): number | undefined {
  const starts = reasoningPartsOf(message)
    .map((part) => part.providerMetadata?.aipg?.reasoningStarted)
    .filter((value): value is number => value != null)
  return starts.length > 0 ? Math.min(...starts) : undefined
}

function reasoningFinishedAtFor(message: AipgUiMessage): number | undefined {
  const finishes = reasoningPartsOf(message)
    .map((part) => part.providerMetadata?.aipg?.reasoningFinished)
    .filter((value): value is number => value != null)
  return finishes.length > 0 ? Math.max(...finishes) : undefined
}

function isFirstWebBrowsePart(message: AipgUiMessage, partIndex: number): boolean {
  const parts = message.parts ?? []
  const firstIndex = parts.findIndex((part) =>
    isWebBrowsePart(part as ToolUIPart<AipgTools> | DynamicToolUIPart),
  )
  return firstIndex === partIndex
}

function webBrowseEntriesFor(message: AipgUiMessage): WebBrowseEntry[] {
  return webBrowsePartsOf(message).map((part) => {
    const input = part.input as { url?: string; action?: string; query?: string } | undefined
    if (toolPartNameOf(part) === 'searchWeb') {
      return {
        toolCallId: part.toolCallId,
        state: part.state,
        title: input?.query ? `Search: "${input.query}"` : 'Web search',
        action: 'search',
        errorText: part.state === 'output-error' ? part.errorText : undefined,
      }
    }
    const output = part.state === 'output-available' ? (part.output as WebPageSnapshot) : undefined
    return {
      toolCallId: part.toolCallId,
      state: part.state,
      title: output?.title,
      url: output?.url,
      requestedUrl: toolPartNameOf(part) === 'browseWeb' ? input?.url : undefined,
      action: toolPartNameOf(part) === 'interactWithWebPage' ? input?.action : undefined,
      errorText: part.state === 'output-error' ? part.errorText : undefined,
    }
  })
}
</script>

<style>
.hljs {
  padding-left: 0.5rem;
  border-bottom-left-radius: calc(var(--radius) - 2px);
  border-bottom-right-radius: calc(var(--radius) - 2px);
}
</style>
