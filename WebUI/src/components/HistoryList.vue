<template>
  <TooltipProvider :delay-duration="200">
    <div class="flex flex-col h-full gap-3 pr-3">
      <div class="flex flex-col gap-2">
        <Input
          v-model="history.query"
          type="search"
          aria-label="Search history"
          placeholder="Search history"
        />
        <div class="flex items-center gap-1" role="group" aria-label="History filter">
          <button
            v-for="chip in chips"
            :key="chip.value"
            class="rounded-full px-2.5 py-1 text-xs border transition"
            :class="
              history.filter === chip.value
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground'
            "
            :aria-pressed="history.filter === chip.value"
            @click="history.filter = chip.value"
          >
            {{ chip.label }}
          </button>
        </div>
      </div>

      <div class="flex flex-col gap-2 flex-1 overflow-y-auto overflow-x-hidden">
        <!-- A blank canvas is a row of its own: it is what "nothing selected" looks like. -->
        <div
          v-if="showNewMediaRow"
          class="flex items-center gap-2 bg-accent rounded px-3 py-2 cursor-pointer border-2 transition-colors hover:bg-accent/80"
          :class="history.newMediaSelected ? 'border-primary' : 'border-transparent'"
          role="button"
          aria-label="New image"
          @click="history.selectNewMedia()"
        >
          <div
            class="relative w-[120px] h-[72px] overflow-hidden rounded-sm flex items-center justify-center bg-background"
          >
            <span class="text-lg text-primary font-semibold">New Image</span>
          </div>
        </div>

        <!-- The thread the next send goes into, before it has a date to sort by. -->
        <HistoryEntryRow
          v-if="draft"
          :key="`draft-${draft.id}`"
          :entry="draft"
          :active="history.isActive(draft)"
          :renamable="false"
          @select="selectDraft"
          @delete="removeDraft"
        />

        <div
          v-if="groups.length === 0 && !showNewMediaRow && !draft"
          class="px-2 py-4 text-xs text-muted-foreground italic"
        >
          {{ emptyMessage }}
        </div>

        <template v-for="group in groups" :key="group.label">
          <div class="flex items-center gap-3 pt-1">
            <div class="h-px flex-1 bg-border"></div>
            <span class="text-xs text-muted-foreground">{{ group.label }}</span>
            <div class="h-px flex-1 bg-border"></div>
          </div>
          <HistoryEntryRow
            v-for="entry in group.entries"
            :key="`${entry.kind}-${entry.id}`"
            :entry="entry"
            :active="history.isActive(entry)"
            :renamable="history.canRename(entry)"
            @select="onSelect(entry)"
            @delete="history.remove(entry)"
            @rename="(title) => history.rename(entry, title)"
          />
        </template>
      </div>
    </div>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { Input } from '@/components/ui/input'
import { TooltipProvider } from '@/components/ui/tooltip'
import HistoryEntryRow from '@/components/HistoryEntryRow.vue'
import { useHistorySessions } from '@/assets/js/store/historySessions'
import { dayLabel, isWorkflowMode, type HistoryEntry } from '@/assets/js/store/historyEntries'
import { mapModeToLabel } from '@/lib/utils'

const emit = defineEmits<{
  selected: [entry: HistoryEntry]
}>()

const history = useHistorySessions()

async function onSelect(entry: HistoryEntry) {
  await history.select(entry)
  emit('selected', entry)
}

const draft = computed(() => history.pinnedDraft)

async function selectDraft() {
  if (draft.value) await onSelect(draft.value)
}

async function removeDraft() {
  if (draft.value) await history.remove(draft.value)
}

const currentLabel = computed(() =>
  history.conversationScope === 'homeAgent' ? 'Home Agent' : mapModeToLabel(history.currentMode),
)

const chips = computed(() => [
  { value: 'current' as const, label: currentLabel.value },
  { value: 'all' as const, label: 'All' },
])

const groups = computed(() => {
  const groupedByDay: { label: string; entries: HistoryEntry[] }[] = []
  for (const entry of history.visibleEntries) {
    const label = dayLabel(entry.updatedAt)
    const last = groupedByDay.at(-1)
    if (last?.label === label) last.entries.push(entry)
    else groupedByDay.push({ label, entries: [entry] })
  }
  return groupedByDay
})

const showNewMediaRow = computed(
  () => history.filter === 'current' && history.currentMode === 'imageGen',
)

const emptyMessage = computed(() => {
  if (history.query.trim()) return 'Nothing matches that search.'
  if (history.filter === 'all') return 'No history yet.'
  if (history.currentMode === 'agent')
    return 'No sessions yet. Each turn is archived automatically.'
  if (isWorkflowMode(history.currentMode)) return 'Nothing generated yet.'
  return `No ${currentLabel.value} conversations yet.`
})

// Games are named after the fact (`set_metadata`), and a renamed game must
// relabel the sessions that built it.
onMounted(() => void history.refreshGameNames())
watch(
  () => history.visibleEntries.length,
  () => void history.refreshGameNames(),
)
</script>
