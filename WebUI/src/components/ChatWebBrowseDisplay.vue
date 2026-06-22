<script lang="ts">
// One row per browse/interact tool call in the assistant turn. `state` mirrors
// the AI SDK tool-part lifecycle; `title`/`url` come from the structured tool
// output once the navigation completes.
export type WebBrowseEntry = {
  toolCallId: string
  state:
    | 'input-streaming'
    | 'input-available'
    | 'approval-requested'
    | 'approval-responded'
    | 'output-available'
    | 'output-error'
    | 'output-denied'
  title?: string
  url?: string
  requestedUrl?: string
  action?: string
  errorText?: string
}
</script>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronRight, Globe, ExternalLink } from 'lucide-vue-next'
import { Spinner } from '@/components/ui/spinner'

const props = defineProps<{
  entries: WebBrowseEntry[]
}>()

const isExpanded = ref(false)

const isBrowsing = computed(() =>
  props.entries.some((e) => e.state === 'input-streaming' || e.state === 'input-available'),
)

// Count only actual page visits (entries with a resolved URL) so search-only
// rows are listed in the trace but don't inflate the "Browsed N pages" header.
const completedCount = computed(
  () => props.entries.filter((e) => e.state === 'output-available' && e.url).length,
)

const headerLabel = computed(() => {
  if (isBrowsing.value) return 'Browsing the web…'
  const n = completedCount.value
  return `Browsed ${n} page${n === 1 ? '' : 's'}`
})

function primaryText(entry: WebBrowseEntry): string {
  if (entry.title) return entry.title
  if (entry.url) return entry.url
  if (entry.requestedUrl) return entry.requestedUrl
  if (entry.action) return `Page interaction (${entry.action})`
  return 'Web page'
}

function secondaryText(entry: WebBrowseEntry): string | undefined {
  return entry.url ?? entry.requestedUrl
}

function openExternally(url?: string) {
  if (!url) return
  window.electronAPI.openUrl(url)
}
</script>

<template>
  <div class="flex flex-col rounded-md border border-border/80 bg-muted/20">
    <div
      class="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground"
      role="button"
      :aria-expanded="isExpanded"
      @click="isExpanded = !isExpanded"
    >
      <ChevronRight
        class="size-4 shrink-0 transition-transform"
        :class="isExpanded ? 'rotate-90' : ''"
      />
      <Globe class="size-4 shrink-0" />
      <span class="flex-1 truncate">{{ headerLabel }}</span>
      <Spinner v-if="isBrowsing" class="size-3.5" />
    </div>

    <ol v-if="isExpanded" class="flex flex-col gap-1 px-3 pb-3 animate-in fade-in-0 duration-200">
      <li
        v-for="(entry, index) in entries"
        :key="entry.toolCallId"
        class="flex items-start gap-2 rounded px-2 py-1.5 text-sm"
        :class="entry.url || entry.requestedUrl ? 'hover:bg-muted/60' : ''"
      >
        <span class="w-5 shrink-0 pt-0.5 text-right text-xs tabular-nums text-muted-foreground/70">
          {{ index + 1 }}
        </span>
        <div class="flex min-w-0 flex-1 flex-col">
          <div class="flex items-center gap-1.5">
            <span class="truncate font-medium text-foreground" :title="primaryText(entry)">
              {{ primaryText(entry) }}
            </span>
            <button
              v-if="secondaryText(entry)"
              type="button"
              class="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              title="Open in browser"
              @click="openExternally(secondaryText(entry))"
            >
              <ExternalLink class="size-3.5" />
            </button>
          </div>
          <button
            v-if="secondaryText(entry)"
            type="button"
            class="truncate text-left text-xs text-muted-foreground hover:underline"
            :title="secondaryText(entry)"
            @click="openExternally(secondaryText(entry))"
          >
            {{ secondaryText(entry) }}
          </button>
          <span
            v-if="entry.state === 'input-streaming' || entry.state === 'input-available'"
            class="text-xs text-muted-foreground"
          >
            Loading…
          </span>
          <span v-else-if="entry.state === 'output-error'" class="text-xs text-destructive">
            {{ entry.errorText || 'Failed to load page' }}
          </span>
        </div>
      </li>
    </ol>
  </div>
</template>
